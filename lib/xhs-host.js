/**
 * xhs-host.js —— 小红书「真实数据」宿主层（专用浏览器 + CDP 监听响应）。
 *
 * 思路完全仿照 dsh-fish-soul 的 DouyinHost：
 *   · 用插件自己的 Chrome profile（$DSH_HOME/dsh-xhs/browser），和用户日常浏览器互不影响；
 *   · 登录就在这个窗口里做一次（扫码 / 账号密码），登录态留在 profile 里，之后免登录；
 *   · 我们**不自己造签名**——而是让真实浏览器去发请求（x-s / x-s-common 天然合法），
 *     我们只用 CDP 的 Network 域监听响应 JSON，读出来解析；
 *   · 这样绕开了纯算法签名被设备指纹墙（461）拦的问题。
 *
 * 关键能力：
 *   searchNotes(keyword, {limit, sort, noteType})  → 搜关键词，返回真实笔记列表
 *   fetchNote(note)                                → 打开笔记详情页，读全文 + 图集
 *   fetchComments(note, {limit})                   → 读笔记评论（含二级）
 *   ensureReady()                                  → 确保浏览器起来、已登录
 *   status() / openLogin() / stop()
 */
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { getBrowser } from './browser.mjs';
import { parseNotesResponse, parseFeedResponse, parseCommentsResponse } from '../src/parse.mjs';

export const XHS_HOME = 'https://www.xiaohongshu.com/';
const DEFAULT_PORT = 47891; // 避开鱼的 47890

const sleep = (ms) => new Promise((r) => { const t = setTimeout(r, ms); t.unref?.(); });
const errText = (e) => String(e instanceof Error ? e.message : e);

/** 随机字符串，做伪 search_id（浏览器自己也会发，我们只是用它区分本次导航）。 */
function randId(n = 16) {
  const chars = 'abcdef0123456789';
  let s = '';
  for (let i = 0; i < n; i++) s += chars[Math.floor(Math.random() * chars.length)];
  return s;
}

export class XhsHost {
  /**
   * @param {object} opts
   * @param {string} [opts.pluginDir] 插件根目录（profile 放这下面）
   * @param {number} [opts.port]      CDP 端口
   * @param {Function} [opts.log]
   * @param {string} [opts.browserExe] 指定浏览器可执行文件（可选）
   */
  constructor({ pluginDir, port = DEFAULT_PORT, log = () => {}, browserExe = '' } = {}) {
    this.pluginDir = pluginDir || join(process.env.DSH_HOME || join(homedir(), '.dsh'), 'dsh-xhs');
    this.port = port;
    this.log = log;
    this.browserExe = browserExe;
    this.userDataDir = join(this.pluginDir, 'browser');
    this.browser = null;
    this.launching = null;
    /** 最近一次搜索/详情拿到的原始响应，供轮询与手动触发协调 */
    this._busy = false;
  }

  get base() {
    return `http://127.0.0.1:${this.port}`;
  }

  /** 日志里的状态 */
  status() {
    const alive = Boolean(this.browser && this.browser.isAlive());
    return {
      connected: alive,
      port: this.port,
      profileDir: this.userDataDir,
      busy: this._busy,
    };
  }

  /** 确保浏览器起来（连已有或新开），返回 Browser 实例。同一个启动流程只跑一次。 */
  async ensureBrowser() {
    if (this.browser && this.browser.isAlive()) return this.browser;
    if (this.launching) return this.launching;
    this.launching = (async () => {
      mkdirSync(this.userDataDir, { recursive: true });
      const b = await getBrowser({
        exe: this.browserExe || undefined,
        userDataDir: this.userDataDir,
        port: this.port,
        log: (m) => this.log(String(m)),
        reuse: true,
      });
      this.browser = b;
      this.log(`浏览器就绪（端口 ${this.port}）`);
      return b;
    })();
    try {
      return await this.launching;
    } finally {
      this.launching = null;
    }
  }

  /** 确保浏览器起来并已登录小红书（未登录就停在登录页，用户扫码后继续）。 */
  async ensureReady({ navToHome = true } = {}) {
    const b = await this.ensureBrowser();
    let href = await b.eval('location.href').catch(() => '');
    const onXhs = /xiaohongshu\.com/.test(href || '');
    if (!onXhs && navToHome) {
      await b.goto(XHS_HOME, { settleMs: 6000 });
      href = await b.eval('location.href').catch(() => '');
    }
    const loggedIn = await this.isLoggedIn(b);
    return { browser: b, href: String(href || ''), loggedIn };
  }

  /** 读 cookie 判断是否登录（web_session 存在 = 已登录）。 */
  async isLoggedIn(b = null) {
    const browser = b || (await this.ensureBrowser());
    try {
      const cookies = await browser.cookies(['https://www.xiaohongshu.com', 'https://edith.xiaohongshu.com', 'https://so.xiaohongshu.com']);
      return cookies.some((c) => c.name === 'web_session' && String(c.value || '').length > 8);
    } catch {
      return false;
    }
  }

  /** 打开登录页，让用户在那个窗口里扫码 / 登录。 */
  async openLogin() {
    const b = await this.ensureBrowser();
    await b.goto(`${XHS_HOME}`, { settleMs: 4000 });
    return { href: await b.eval('location.href').catch(() => '') };
  }

  /**
   * 搜关键词：导航到搜索结果页，等待浏览器自己发出的 /search/notes 响应。
   * @returns {Promise<{items:Array, raw:number}>}
   */
  async searchNotes(keyword, { limit = 20, sort = 'general', noteType = 0, timeoutMs = 30000 } = {}) {
    const { browser: b, loggedIn } = await this.ensureReady();
    if (!loggedIn) {
      throw new Error('小红书还没登录。请在插件窗口里扫码登录后重试（设置面板点「打开登录窗口」）。');
    }
    this._busy = true;
    try {
      const kw = encodeURIComponent(keyword);
      const url = `${XHS_HOME}search_result/?keyword=${kw}&source=web_search_result_notes&type=51`;
      await b.goto(url, { settleMs: 7000 });
      // ⚠️ goto() 会清空 b.events，用单调序号 seqNow 当 since（0 = 全部）
      const since = 0;

      // 等第一条 search notes 响应出现（浏览器自动带签名发出）。
      // 真实接口：so.xiaohongshu.com/api/sns/web/v2/search/notes（v2，域名是 so.）
      // 用宽松正则兼容 v1/v2 及域名变化。
      const re = /\/api\/sns\/web\/v\d+\/search\/notes/;
      let resp = null;
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        const hits = b.imResponses(re, since);
        // 挑一条 status 200 的
        const ok = hits.find((h) => h.status === 200) || null;
        if (ok) {
          resp = ok;
          break;
        }
        // 页面可能还在滚动懒加载，等一下
        await sleep(600);
        // 主动滚一下触发更多结果
        await b.eval('window.scrollTo(0, document.body.scrollHeight)').catch(() => {});
      }
      if (!resp) throw new Error('没等到搜索结果响应（可能页面结构变了 / 登录态失效）。可以点「立即获取」重试。');
      const buf = await b.responseBody(resp.requestId);
      if (!buf) throw new Error('搜索结果响应体已被回收，请重试。');
      const items = parseNotesResponse(buf.toString('utf8'));
      return { items: items.slice(0, Math.min(60, Math.max(1, limit))), raw: items.length };
    } finally {
      this._busy = false;
    }
  }

  /**
   * 打开笔记详情（带 xsec_token），读全文与图集。
   * 小红书详情页没有单独的「详情」XHR —— 正文直接内联在页面 __INITIAL_STATE__
   * 的 note.noteDetailMap[noteId].note 里（title / desc / imageList / tagList / interactInfo / user）。
   * 所以这里导航到详情页后，用 CDP eval 读 __INITIAL_STATE__。
   * @param {{id:string, xsecToken?:string, url?:string}} note
   */
  async fetchNote(note, { timeoutMs = 25000 } = {}) {
    const b = await this.ensureBrowser();
    if (!note || !note.id) throw new Error('缺少笔记 id');
    this._busy = true;
    try {
      const url = note.url || (note.xsecToken
        ? `${XHS_HOME}explore/${note.id}?xsec_token=${note.xsecToken}&xsec_source=pc_feed`
        : `${XHS_HOME}explore/${note.id}`);
      await b.goto(url, { settleMs: 6000 });

      // 轮询 __INITIAL_STATE__ 里的详情，最多等 timeoutMs
      const expr = `(() => {
        try {
          const s = window.__INITIAL_STATE__;
          if (!s || !s.note || !s.note.noteDetailMap) return null;
          const map = s.note.noteDetailMap;
          const id = ${JSON.stringify(String(note.id))};
          const entry = map[id] || map[Object.keys(map)[0]];
          const nc = entry && (entry.note || entry.noteCard);
          if (!nc) return null;
          const r = (path) => { const a = path.split('.'); let o = nc; for (const k of a) { if (!o) return undefined; o = o[k]; } return o; };
          const ii = nc.interactInfo || {};
          return {
            id: nc.noteId || id,
            title: nc.title || '',
            desc: nc.desc || '',
            type: nc.type || 'normal',
            images: (nc.imageList || []).map((x, i) => (x.urlDefault || x.urlPre || x.url || (x.infoList && x.infoList[0] && x.infoList[0].url) || '')).filter(Boolean),
            cover: ((nc.imageList || [])[0] || {}).urlDefault || '',
            tags: (nc.tagList || []).map((t) => t.name).filter(Boolean),
            interact: {
              liked: ii.likedCount, collected: ii.collectedCount, comment: ii.commentCount, shared: ii.shareCount,
            },
            author: {
              nick: (nc.user || {}).nickname || '', avatar: (nc.user || {}).avatar || (nc.user || {}).image || '', userId: (nc.user || {}).userId || '',
            },
            time: nc.time,
          };
        } catch (e) { return { __err: String(e && e.message || e) }; }
      })()`;
      const deadline = Date.now() + timeoutMs;
      let raw = null;
      while (Date.now() < deadline) {
        raw = await b.eval(expr, { awaitPromise: false }).catch(() => null);
        if (raw && (raw.desc !== undefined || raw.title !== undefined) && !raw.__err) break;
        if (raw && raw.__err) throw new Error('详情解析失败：' + raw.__err);
        await sleep(500);
      }
      if (!raw || (!raw.title && !raw.desc)) {
        throw new Error('没读到笔记详情（笔记可能已删除 / 需要登录 / xsec_token 失效）。');
      }
      // 统一成 parseFeedResponse 同款结构；noteUrl 指向规范链接
      return {
        id: raw.id,
        title: raw.title,
        desc: raw.desc,
        type: raw.type,
        cover: raw.cover,
        images: raw.images,
        tags: raw.tags,
        interact: raw.interact,
        author: raw.author,
        noteUrl: `${XHS_HOME}explore/${raw.id}`,
        url: url,
      };
    } finally {
      this._busy = false;
    }
  }

  /** 读评论（在详情页里滚动到评论区，等 /comment/page 响应）。 */
  async fetchComments(note, { limit = 20, timeoutMs = 20000 } = {}) {
    const b = await this.ensureBrowser();
    if (!note || !note.id) return [];
    const re = /\/api\/sns\/web\/v\d+\/comment\/page/;
    const cap = () => Math.min(50, Math.max(1, limit));

    // 很多笔记一进详情就自动请求评论；但那批 body 可能已被回收（时间早、或事件被裁剪）。
    // 先尝试捡现成的，body 读取失败就算了。
    const tryRead = async (hit) => {
      try {
        const buf = await b.responseBody(hit.requestId);
        if (!buf) return null;
        const list = parseCommentsResponse(buf.toString('utf8'));
        return list.length ? list : null;
      } catch {
        return null;
      }
    };
    for (const hit of b.imResponses(re, 0).filter((h) => h.status === 200)) {
      const list = await tryRead(hit);
      if (list) return list.slice(0, cap());
    }

    // 没捡到 → 主动滚 .note-scroller（详情页真正的滚动容器）到底，触发新的评论请求。
    const since = b.seqNow ? b.seqNow() : b.events.length;
    const deadline = Date.now() + timeoutMs;
    let tries = 0;
    while (Date.now() < deadline) {
      const hits = b.imResponses(re, since).filter((h) => h.status === 200);
      for (const hit of hits) {
        const list = await tryRead(hit);
        if (list) return list.slice(0, cap());
      }
      // 分步往下滚 note-scroller
      await b.eval(`(() => {
        const el = document.querySelector('.note-scroller') || document.scrollingElement;
        if (el) { const step = Math.max(400, el.clientHeight * 0.9); el.scrollTop = Math.min(el.scrollTop + step, el.scrollHeight); }
        return el ? el.scrollTop + '/' + el.scrollHeight : 'no';
      })()`).catch(() => {});
      await sleep(tries < 3 ? 900 : 1400);
      tries++;
    }
    return [];
  }

  /** 关浏览器（设置面板「停止」/ 插件卸载）。 */
  async stop() {
    try {
      if (this.browser) await this.browser.quit();
    } catch (e) {
      this.log(`关闭浏览器失败：${errText(e)}`);
    }
    this.browser = null;
  }
}
