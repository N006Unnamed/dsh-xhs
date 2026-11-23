/**
 * dsh-xhs —— 小红书笔记采集 / 评论 / 生成发布草稿（DSH 插件）。
 *
 * 数据来源：**宿主内专用浏览器 + CDP 监听响应**（仿 dsh-fish-soul 的 DouyinHost）。
 * 小红书没有免登录接口、搜索接口有设备指纹校验（纯算法签名会被 461 拦），
 * 所以正确路线是让真实浏览器自己发签名请求，我们只读响应 JSON。
 *
 * 对外提供：
 *   ① 模型工具：xhs_search / xhs_note / xhs_draft / xhs_login / xhs_status
 *   ② 跨插件服务：ctx.provide('xhs', { search, listNotes, note, draft, status, login })
 *   ③ 设置面板：Web UI「设置 → 小红书」卡片（client.js 注册到 settings.section）
 *
 * 依赖解析走 hostdeps 模式（桌面 profile 不装 optional peer，裸 import 会让整条插件不激活）。
 */
import { readFileSync, writeFileSync, existsSync, renameSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';

import { loadHostDeps } from './hostdeps.mjs';
import { createCore } from '../src/core.mjs';
import { createRoutes } from './routes.mjs';
import { createLlm } from './llm.mjs';
import { xhsConfigSchema } from './config-schema.mjs';

const PLUGIN_ID = 'dsh-xhs';
const PLUGIN_DIR = join(dirname(fileURLToPath(import.meta.url)), '..');

const hostDeps = await loadHostDeps();
const z = hostDeps.z;
const defineTool = hostDeps.defineTool;

export const name = PLUGIN_ID;
// webServer：HTTP 路由；tools：注册模型工具；llm/agentDefaultModel：写草稿时用宿主模型。
// connection：DSH 访问检查（requestRejection），防止浏览器里任意网页跨域调用这些路由。
export const inject = ['webServer', 'tools', 'llm', 'connection'];
export const optional = ['agentDefaultModel'];

export const Config = z === null ? undefined : xhsConfigSchema(z);

function deepMerge(base, over) {
  const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
  if (!isObj(base)) return isObj(over) ? { ...over } : over === undefined ? base : over;
  const out = { ...base };
  if (!isObj(over)) return out;
  for (const [k, v] of Object.entries(over)) {
    if (v === undefined) continue;
    out[k] = isObj(v) && isObj(out[k]) ? deepMerge(out[k], v) : v;
  }
  return out;
}

function configPath() {
  const home = process.env.DSH_HOME || join(homedir(), '.dsh');
  return join(home, PLUGIN_ID, 'config.json');
}

function readConfigFile(path = configPath()) {
  if (!existsSync(path)) return { ok: true, value: {} };
  let text;
  try {
    text = readFileSync(path, 'utf8');
  } catch (error) {
    return { ok: false, error: String(error) };
  }
  text = text.replace(/^\uFEFF/, '');
  if (text.trim() === '') return { ok: true, value: {} };
  try {
    const value = JSON.parse(text);
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return { ok: false, error: '最外层不是 {}' };
    return { ok: true, value };
  } catch (error) {
    return { ok: false, error: String(error) };
  }
}

function saveConfigFile(patch, path = configPath()) {
  const cur = readConfigFile(path);
  if (!cur.ok) throw new Error(`${PLUGIN_ID} 配置格式不对，没保存（${cur.error}）。先把文件改对（或删掉）再设置`);
  const next = deepMerge(cur.value, patch);
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, JSON.stringify(next, null, 2), 'utf8');
  renameSync(tmp, path);
  return next;
}

function objectSchema(props) {
  const properties = {};
  const required = [];
  for (const [k, v] of Object.entries(props)) {
    const { required: req, ...rest } = v;
    properties[k] = rest;
    if (req === true) required.push(k);
  }
  return { type: 'object', properties, required, additionalProperties: false };
}

function noteLines(items) {
  return items
    .map((n, i) => {
      const meta = [n.author?.nick ? `@${n.author.nick}` : '', n.interact?.liked ? `赞${n.interact.liked}` : ''].filter(Boolean).join(' ');
      return `${i + 1}. ${n.title || '(无题)'}${meta ? ` ｜ ${meta}` : ''}\n   ${n.url}`;
    })
    .join('\n');
}

export async function apply(ctx, hostConfig) {
  const log = (msg) => {
    try {
      ctx.logger?.('info')?.('[dsh-xhs]', String(msg));
    } catch {
      /* ignore */
    }
  };
  for (const n of hostDeps.notes) log(n);

  const fileCfg = readConfigFile();
  let current = deepMerge(hostConfig ?? {}, fileCfg.ok ? fileCfg.value : {});

  const getConfig = () => current;
  const saveConfig = (patch) => {
    current = deepMerge(current, patch);
    try {
      saveConfigFile(patch);
    } catch (e) {
      log(`保存配置失败：${e?.message ?? e}`);
      throw e;
    }
    reschedule();
    return current;
  };

  const llm = createLlm({ ctx, log });
  const core = createCore({ getConfig, log, llm, pluginDir: join(process.env.DSH_HOME || join(homedir(), '.dsh'), PLUGIN_ID) });

  // ── 定时搜索（可选）：到点搜一次关键词，结果写进 status（不推送，主要给面板/工具用） ──
  let timer = null;
  let lastScheduled = null;
  function stopTimer() {
    if (timer) { clearInterval(timer); timer = null; }
  }
  function reschedule() {
    stopTimer();
    const sched = current.schedule ?? {};
    if (!sched.enabled) return;
    const minutes = Math.min(1440, Math.max(5, Number(sched.intervalMinutes) || 60));
    const kw = String(sched.keyword || (Array.isArray(current.keywords) ? current.keywords[0] : '') || '').trim();
    if (!kw) { log('定时搜索已开启但没有关键词，跳过'); return; }
    timer = setInterval(async () => {
      try {
        const r = await core.listNotes(kw, {});
        lastScheduled = { keyword: kw, count: r.items.length, at: Date.now() };
        log(`定时搜索「${kw}」完成：${r.items.length} 条`);
      } catch (e) {
        log(`定时搜索失败：${e?.message ?? e}`);
      }
    }, minutes * 60_000);
    if (timer.unref) timer.unref();
    log(`已启用定时搜索：每 ${minutes} 分钟 搜「${kw}」`);
  }
  ctx.effect(() => {
    reschedule();
    return () => stopTimer();
  }, 'dsh-xhs: schedule');

  // ── HTTP 路由（设置面板） ──
  ctx.effect(
    () =>
      ctx.webServer.register({
        kind: 'prefix',
        path: `/api/plugins/${PLUGIN_ID}`,
        handler: createRoutes({ getConfig, saveConfig, core, log, uiDir: join(PLUGIN_DIR, 'lib'), connection: ctx.connection }),
      }),
    'dsh-xhs: api',
  );

  // ── 跨插件服务：别的插件 ctx.get('xhs') 拿到 ──
  const service = {
    search: async (keyword, limit) => (await core.search(keyword, { limit })).items,
    listNotes: async (keyword, limit) => (await core.listNotes(keyword, { limit })).items,
    note: async (id, opts) => core.note(id, opts),
    draft: async (opts) => core.draft(opts),
    status: () => core.status(),
    login: () => core.login(),
  };
  ctx.provide('xhs', service);

  // ── 模型工具 ──
  const textOutput = {
    schema: { type: 'string' },
    render: (_args, value) => [{ type: 'text', text: String(value) }],
  };

  ctx.effect(
    () =>
      ctx.tools.register(
        defineTool({
          name: 'xhs_search',
          description: '搜索小红书笔记（走真实浏览器，需已登录）。返回笔记标题、作者、点赞、链接；可选抓正文与评论。',
          parameters: objectSchema({
            keyword: { type: 'string', required: true, description: '搜索关键词，如 穿搭 / 露营' },
            limit: { type: 'number', description: '返回条数，1~60，缺省用插件设置' },
            withComments: { type: 'boolean', description: '是否附带评论，缺省用插件设置' },
          }),
          output: textOutput,
          async execute(args) {
            const r = await core.search(args.keyword, { limit: args.limit, withComments: args.withComments });
            if (!r.items.length) return `「${r.keyword}」没搜到笔记（可能未登录 / 页面结构变了）。`;
            return `小红书「${r.keyword}」搜索结果（${r.items.length} 条${r.cached ? '，缓存' : ''}）：\n${noteLines(r.items)}`;
          },
        }),
        'dsh-xhs: xhs_search',
      ),
  );

  ctx.effect(
    () =>
      ctx.tools.register(
        defineTool({
          name: 'xhs_note',
          description: '读一篇小红书笔记的详情（正文全文 + 图集 + 评论）。需要笔记 id，可带 xsecToken。',
          parameters: objectSchema({
            id: { type: 'string', required: true, description: '笔记 id' },
            xsecToken: { type: 'string', description: '笔记的 xsec_token（搜索结果里带）' },
            url: { type: 'string', description: '笔记完整链接（可选）' },
          }),
          output: textOutput,
          async execute(args) {
            const n = await core.note(args.id, { xsecToken: args.xsecToken, url: args.url, withComments: true });
            if (!n) return '没读到这篇笔记（可能已删除 / 需要登录）。';
            const cms = (n.comments || []).slice(0, 10).map((c) => `· ${c.nick}：${c.content}`).join('\n');
            return `${n.title || '(无题)'}\n作者：@${n.author?.nick || '-'} ｜ 赞${n.interact?.liked || '-'} 收藏${n.interact?.collected || '-'}\n话题：${(n.tags || []).map((t) => '#' + t).join(' ')}\n\n${n.desc || '(无正文)'}\n\n${cms ? `评论（${n.comments.length}）：\n${cms}` : '（无评论）'}\n\n${n.url}`;
          },
        }),
        'dsh-xhs: xhs_note',
      ),
  );

  ctx.effect(
    () =>
      ctx.tools.register(
        defineTool({
          name: 'xhs_draft',
          description: '据某关键词的小红书搜索结果，调用模型写一篇可发布的小红书笔记（第一人称种草文，含标题/正文/话题标签）。可用 style 控制文风/角度。',
          parameters: objectSchema({
            keyword: { type: 'string', required: true, description: '出稿关键词，如 穿搭' },
            style: { type: 'string', description: '文风/角度，逗号分隔，如：真诚、干货、带点幽默' },
            topN: { type: 'number', description: '参考笔记条数，缺省用插件设置' },
          }),
          output: textOutput,
          async execute(args) {
            const d = await core.draft({ keyword: args.keyword, style: args.style, topN: args.topN });
            const mode = d.generatedByAi ? '（模型撰写）' : '（模型不可用·素材提纲）';
            return `标题：${d.title}${mode}\n\n话题：${d.tags.map((t) => '#' + t).join(' ')}\n\n正文：\n${d.bodyText}\n\n参考笔记：\n${(d.refs || []).map((r, i) => `${i + 1}. ${r.title}${r.author ? ` @${r.author}` : ''}`).join('\n')}`;
          },
        }),
        'dsh-xhs: xhs_draft',
      ),
  );

  ctx.effect(
    () =>
      ctx.tools.register(
        defineTool({
          name: 'xhs_login',
          description: '打开小红书登录窗口（在宿主浏览器里扫码登录），并返回当前登录状态。',
          parameters: objectSchema({}),
          output: textOutput,
          async execute() {
            const r = await core.ensureReady().catch((e) => ({ error: String(e?.message ?? e) }));
            if (r?.error) return `打开失败：${r.error}`;
            const st = await core.status();
            return st.connected
              ? `浏览器已连接（端口 ${st.port}）。${r.loggedIn ? '已登录小红书。' : '还没登录，请在打开的小红书窗口里扫码登录。'}`
              : '浏览器还没连上。';
          },
        }),
        'dsh-xhs: xhs_login',
      ),
  );

  ctx.effect(
    () =>
      ctx.tools.register(
        defineTool({
          name: 'xhs_status',
          description: '查看小红书插件状态：浏览器是否连接、是否已登录、上次搜索关键词与时间。',
          parameters: objectSchema({}),
          output: textOutput,
          async execute() {
            const st = core.status();
            const logged = st.connected ? await core.ensureReady({ navToHome: false }).then((r) => r.loggedIn).catch(() => false) : false;
            return `浏览器：${st.connected ? '已连接' : '未连接'}（端口 ${st.port}）\n登录：${logged ? '已登录' : '未登录/未知'}\n上次搜索：${st.lastKeyword || '-'}${st.lastSearchAt ? '（' + new Date(st.lastSearchAt).toLocaleString('zh-CN') + '）' : ''}\n模型：${st.llmAvailable ? '可用' : '不可用'}`;
          },
        }),
        'dsh-xhs: xhs_status',
      ),
  );

  log('已就绪');
}
