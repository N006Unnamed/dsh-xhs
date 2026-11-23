/**
 * routes.mjs —— 设置面板 / 立即获取用的 HTTP 路由（prefix: /api/plugins/dsh-xhs）。
 *
 * 契约：
 *   GET  /state            → { ok, config, status }
 *   POST /config           → 保存设置
 *   POST /login            → 打开登录窗口（返回当前登录态）
 *   GET  /login-status     → 当前是否已登录
 *   POST /stop             → 关掉浏览器
 *   POST /search           → { keyword, limit, withComments, noteDetailLimit } → 笔记列表（含正文/评论）
 *   POST /list             → { keyword, limit } → 仅列表（快）
 *   POST /note             → { id, xsecToken?, url?, withComments? } → 单篇详情+评论
 *   POST /draft            → { keyword, style?, topN? } → 草稿
 *   GET  /ui/panel.css     → 面板样式
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

function readBody(req) {
  return new Promise((resolveBody, reject) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => resolveBody(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

/**
 * DSH 访问检查：优先用官方 ctx.connection.requestRejection（Host 反 DNS 重绑定
 * + Origin/跨域校验 + 浏览器令牌认证）。返回 401/403 即拒绝，undefined 才放行。
 */
function makeGuard(connection, logger) {
  return function reject(req) {
    if (!connection || typeof connection.requestRejection !== 'function') return 0;
    try {
      return connection.requestRejection(req) || 0;
    } catch (e) {
      logger(`访问检查异常：${String(e?.message ?? e)}`);
      return 403;
    }
  };
}

const normKw = (v) =>
  v ? String(v).split(/[,，、]/).map((s) => s.trim()).filter(Boolean) : undefined;

export function createRoutes({ getConfig, saveConfig, core, log, uiDir, connection }) {
  const logger = log ?? (() => {});
  const reject = makeGuard(connection, logger);
  return async function handler(req, res) {
    const send = (code, obj) => {
      res.writeHead(code, { 'content-type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify(obj));
    };
    try {
      // DSH 访问检查放最前：CSS 与所有接口一律过闸。
      const denied = reject(req);
      if (denied) {
        res.writeHead(denied, { 'content-type': 'text/plain; charset=utf-8' });
        res.end('forbidden');
        return;
      }
      const url = new URL(req.url ?? '/', 'http://localhost');
      const path = url.pathname.replace('/api/plugins/dsh-xhs', '') || '/';
      const method = req.method ?? 'GET';

      if (method === 'GET' && path === '/ui/panel.css') {
        res.writeHead(200, { 'content-type': 'text/css; charset=utf-8', 'cache-control': 'no-cache' });
        res.end(readFileSync(join(uiDir, 'panel.css'), 'utf8'));
        return;
      }

      if (method === 'GET' && path === '/state') {
        return send(200, { ok: true, config: getConfig(), status: core.status() });
      }

      if (method === 'GET' && path === '/login-status') {
        const r = await core.ensureReady({ navToHome: false }).catch(() => ({ loggedIn: false }));
        return send(200, { ok: true, loggedIn: Boolean(r?.loggedIn) });
      }

      if (method === 'POST' && path === '/login') {
        const r = await core.login().catch((e) => ({ error: String(e?.message ?? e) }));
        return send(200, { ok: !r?.error, ...r });
      }

      if (method === 'POST' && path === '/stop') {
        await core.stop().catch(() => {});
        return send(200, { ok: true });
      }

      if (method === 'POST' && path === '/config') {
        const body = JSON.parse((await readBody(req)) || '{}');
        const allowed = ['enabled', 'searchLimit', 'noteDetailLimit', 'withComments', 'keywords', 'draftTopN', 'autoDraft', 'browserPort', 'schedule'];
        const patch = {};
        for (const k of allowed) if (body[k] !== undefined) patch[k] = body[k];
        const next = saveConfig(patch);
        return send(200, { ok: true, config: next });
      }

      if (method === 'POST' && path === '/list') {
        const body = JSON.parse((await readBody(req)) || '{}');
        const r = await core.listNotes(body.keyword, { limit: body.limit });
        return send(200, { ok: true, keyword: r.keyword, items: r.items, cached: r.cached });
      }

      if (method === 'POST' && path === '/search') {
        const body = JSON.parse((await readBody(req)) || '{}');
        const r = await core.search(body.keyword, {
          limit: body.limit,
          withComments: body.withComments,
          noteDetailLimit: body.noteDetailLimit,
        });
        return send(200, { ok: true, keyword: r.keyword, items: r.items, cached: r.cached });
      }

      if (method === 'POST' && path === '/note') {
        const body = JSON.parse((await readBody(req)) || '{}');
        const n = await core.note(body.id, { xsecToken: body.xsecToken, url: body.url, withComments: body.withComments !== false });
        return send(200, { ok: true, note: n });
      }

      if (method === 'POST' && path === '/draft') {
        const body = JSON.parse((await readBody(req)) || '{}');
        const d = await core.draft({ keyword: body.keyword, style: body.style, topN: body.topN });
        return send(200, { ok: true, draft: d });
      }

      if (method === 'POST' && path === '/keywords') {
        // 兼容：单纯保存关键词列表
        const body = JSON.parse((await readBody(req)) || '{}');
        const next = saveConfig({ keywords: normKw(body.keywords) ?? [] });
        return send(200, { ok: true, config: next });
      }

      return send(404, { ok: false, error: 'not found' });
    } catch (error) {
      logger(`路由异常：${String(error instanceof Error ? error.message : error)}`);
      return send(200, { ok: false, error: String(error instanceof Error ? error.message : error) });
    }
  };
}
