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

function sameOrigin(req) {
  const headers = req.headers ?? {};
  const hasFetchSite = headers['sec-fetch-site'] !== undefined;
  if (!hasFetchSite) return true;
  return headers['sec-fetch-site'] === 'same-origin' || headers['sec-fetch-site'] === 'none';
}

const normKw = (v) =>
  v ? String(v).split(/[,，、]/).map((s) => s.trim()).filter(Boolean) : undefined;

export function createRoutes({ getConfig, saveConfig, core, log, uiDir }) {
  const logger = log ?? (() => {});
  return async function handler(req, res) {
    const send = (code, obj) => {
      res.writeHead(code, { 'content-type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify(obj));
    };
    try {
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
        if (!sameOrigin(req)) return send(403, { ok: false, error: 'forbidden' });
        const r = await core.login().catch((e) => ({ error: String(e?.message ?? e) }));
        return send(200, { ok: !r?.error, ...r });
      }

      if (method === 'POST' && path === '/stop') {
        if (!sameOrigin(req)) return send(403, { ok: false, error: 'forbidden' });
        await core.stop().catch(() => {});
        return send(200, { ok: true });
      }

      if (method === 'POST' && path === '/config') {
        if (!sameOrigin(req)) return send(403, { ok: false, error: 'forbidden' });
        const body = JSON.parse((await readBody(req)) || '{}');
        const allowed = ['enabled', 'searchLimit', 'noteDetailLimit', 'withComments', 'keywords', 'draftTopN', 'autoDraft', 'browserPort', 'schedule'];
        const patch = {};
        for (const k of allowed) if (body[k] !== undefined) patch[k] = body[k];
        const next = saveConfig(patch);
        return send(200, { ok: true, config: next });
      }

      if (method === 'POST' && path === '/list') {
        if (!sameOrigin(req)) return send(403, { ok: false, error: 'forbidden' });
        const body = JSON.parse((await readBody(req)) || '{}');
        const r = await core.listNotes(body.keyword, { limit: body.limit });
        return send(200, { ok: true, keyword: r.keyword, items: r.items, cached: r.cached });
      }

      if (method === 'POST' && path === '/search') {
        if (!sameOrigin(req)) return send(403, { ok: false, error: 'forbidden' });
        const body = JSON.parse((await readBody(req)) || '{}');
        const r = await core.search(body.keyword, {
          limit: body.limit,
          withComments: body.withComments,
          noteDetailLimit: body.noteDetailLimit,
        });
        return send(200, { ok: true, keyword: r.keyword, items: r.items, cached: r.cached });
      }

      if (method === 'POST' && path === '/note') {
        if (!sameOrigin(req)) return send(403, { ok: false, error: 'forbidden' });
        const body = JSON.parse((await readBody(req)) || '{}');
        const n = await core.note(body.id, { xsecToken: body.xsecToken, url: body.url, withComments: body.withComments !== false });
        return send(200, { ok: true, note: n });
      }

      if (method === 'POST' && path === '/draft') {
        if (!sameOrigin(req)) return send(403, { ok: false, error: 'forbidden' });
        const body = JSON.parse((await readBody(req)) || '{}');
        const d = await core.draft({ keyword: body.keyword, style: body.style, topN: body.topN });
        return send(200, { ok: true, draft: d });
      }

      if (method === 'POST' && path === '/keywords') {
        // 兼容：单纯保存关键词列表
        if (!sameOrigin(req)) return send(403, { ok: false, error: 'forbidden' });
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
