/**
 * core.mjs —— 小红书插件的业务核心：把 XhsHost（真实浏览器数据）+ 解析 + 草稿 + 模型 串起来。
 *
 * 与头条 core 的区别：数据不是 HTTP 直采，而是走宿主浏览器（XhsHost）。
 * 加 90 秒 TTL 缓存，避免设置面板反复点「搜索」时把浏览器刷崩。
 */
import { XhsHost } from '../lib/xhs-host.js';
import { buildArticlePrompt, buildDraft } from './draft.mjs';

const sleep = (ms) => new Promise((r) => { const t = setTimeout(r, ms); t.unref?.(); });

function makeTtl(ttlMs) {
  const map = new Map();
  return {
    get(key) {
      const e = map.get(key);
      if (!e) return null;
      if (Date.now() - e.at > ttlMs) { map.delete(key); return null; }
      return e.value;
    },
    set(key, value) { map.set(key, { at: Date.now(), value }); },
    clear() { map.clear(); },
  };
}

function clampInt(v, def, lo, hi) {
  const n = Number(v);
  if (!Number.isFinite(n)) return def;
  return Math.max(lo, Math.min(hi, Math.floor(n)));
}

function normKeywords(v) {
  if (Array.isArray(v)) return v.map((s) => String(s).trim()).filter(Boolean);
  if (typeof v === 'string') return v.split(/[,，、\s]+/).map((s) => s.trim()).filter(Boolean);
  return [];
}

export function createCore({ getConfig, log = () => {}, llm = null, pluginDir = '' }) {
  const host = new XhsHost({ pluginDir, log });
  const cache = makeTtl(90_000);
  let lastSearchAt = 0;
  let lastKeyword = '';

  function cfg() {
    const c = getConfig() || {};
    return {
      limit: clampInt(c.searchLimit, 20, 1, 60),
      noteDetailLimit: clampInt(c.noteDetailLimit, 10, 1, 30),
      withComments: c.withComments !== false,
      autoDraft: c.autoDraft === true,
      draftTopN: clampInt(c.draftTopN, 8, 3, 20),
      keywords: normKeywords(c.keywords),
    };
  }

  function status() {
    return {
      ...host.status(),
      lastKeyword,
      lastSearchAt,
      llmAvailable: llm ? Boolean(llm.available?.()) : false,
    };
  }

  async function ensureReady() {
    return host.ensureReady();
  }

  async function login() {
    return host.openLogin();
  }

  async function stop() {
    return host.stop();
  }

  /** 搜关键词 + 可选抓正文/评论。 */
  async function search(keyword, { limit, withComments, noteDetailLimit } = {}) {
    const kw = String(keyword || '').trim();
    if (!kw) throw new Error('请给一个搜索关键词');
    const c = cfg();
    const lim = clampInt(limit, c.limit, 1, 60);
    const cacheKey = `s:${kw}:${lim}`;
    const cached = cache.get(cacheKey);
    if (cached) return { keyword: kw, items: cached, cached: true };

    const { items } = await host.searchNotes(kw, { limit: lim });
    // 需要正文/评论时，对前 N 条逐个打开详情
    const detailN = clampInt(noteDetailLimit, withComments === false ? 0 : c.noteDetailLimit, 0, 30);
    if (detailN > 0) {
      for (let i = 0; i < Math.min(detailN, items.length); i++) {
        try {
          const full = await host.fetchNote(items[i]);
          if (full) {
            // 用详情里的全文/图集覆盖搜索里的简版，但保留 xsecToken / url
            items[i] = { ...items[i], ...full, xsecToken: items[i].xsecToken || full.xsecToken, url: items[i].url || full.url };
          }
          if (withComments !== false && c.withComments) {
            const cms = await host.fetchComments(items[i], { limit: 20 });
            items[i].comments = cms;
          }
          await sleep(800 + Math.random() * 1200); // 温和节流
        } catch (e) {
          log(`取详情失败（${items[i]?.id}）：${e instanceof Error ? e.message : e}`);
        }
      }
    }
    cache.set(cacheKey, items);
    lastKeyword = kw;
    lastSearchAt = Date.now();
    return { keyword: kw, items, cached: false };
  }

  /** 只拿列表（不抓详情），快。 */
  async function listNotes(keyword, { limit } = {}) {
    const kw = String(keyword || '').trim();
    if (!kw) throw new Error('请给一个搜索关键词');
    const c = cfg();
    const lim = clampInt(limit, c.limit, 1, 60);
    const cacheKey = `l:${kw}:${lim}`;
    const cached = cache.get(cacheKey);
    if (cached) return { keyword: kw, items: cached, cached: true };
    const { items } = await host.searchNotes(kw, { limit: lim });
    cache.set(cacheKey, items);
    lastKeyword = kw;
    lastSearchAt = Date.now();
    return { keyword: kw, items, cached: false };
  }

  /** 读单篇笔记详情 + 评论。 */
  async function note(id, { xsecToken, url, withComments = true } = {}) {
    const full = await host.fetchNote({ id, xsecToken, url });
    if (full && withComments) {
      try {
        full.comments = await host.fetchComments(full, { limit: 30 });
      } catch (e) {
        log(`评论抓取失败：${e instanceof Error ? e.message : e}`);
        full.comments = [];
      }
    }
    return full;
  }

  /** 据关键词搜索结果，用模型写一篇可发布的小红书笔记。 */
  async function draft({ keyword, style, topN } = {}) {
    const kw = String(keyword || '').trim();
    if (!kw) throw new Error('请给一个出稿关键词');
    const c = cfg();
    const styles = normKeywords(style);
    const { items } = await listNotes(kw, { limit: Math.max(c.limit, 10) });
    const top = clampInt(topN, c.draftTopN, 3, 20);
    const notes = items.slice(0, top);
    if (!notes.length) throw new Error(`「${kw}」没搜到笔记，没法出稿`);
    const prompt = buildArticlePrompt(kw, notes, { style: styles, topN: top });
    let articleText = null;
    let generatedByAi = false;
    if (llm && llm.available()) {
      articleText = await llm.complete(prompt, { maxTokens: 2200, temperature: 0.85 });
      generatedByAi = Boolean(articleText);
    }
    if (!articleText) {
      // 模型不可用时的兜底：给一段克制的模板，不假装是模型写的
      articleText = [
        `标题：${kw}｜${new Date().getMonth() + 1}月${new Date().getDate()}日`,
        '',
        `最近很多人在聊「${kw}」。我整理了小红书上相关的高赞笔记，发现大家的关注点集中在这些：`,
        ...notes.slice(0, 5).map((n, i) => `${i + 1}. ${n.title}${n.author?.nick ? `（@${n.author.nick}）` : ''}`),
        '',
        '（模型当前不可用，这里先给素材提纲；配置好宿主模型后重新生成即可得到成文。）',
        `#${kw} #小红书 #干货`,
      ].join('\n');
      generatedByAi = false;
    }
    return buildDraft({ keyword: kw, notes, articleText, style: styles, generatedByAi });
  }

  function clearCache() { cache.clear(); }

  return { status, ensureReady, login, stop, search, listNotes, note, draft, clearCache, cfg };
}
