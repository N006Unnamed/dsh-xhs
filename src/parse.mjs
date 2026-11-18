/**
 * parse.mjs —— 把小红书网页接口返回的 JSON 归一成插件内部统一的笔记 / 评论结构。
 *
 * 数据来源都是**真实浏览器自己发出的请求**（XhsHost 通过 CDP 监听响应），
 * 我们只解析响应体，不做任何签名或逆向。
 *
 * 统一结构：
 *   note = {
 *     id, xsecToken,
 *     title, desc,
 *     author: { nick, avatar, userId },
 *     cover,        // 封面图 URL
 *     images: [],   // 图集（详情里才有）
 *     interact: { liked, collected, comment, shared },
 *     tags: [],     // 话题名
 *     type,         // 'normal' | 'video'
 *     url,          // 拼好的笔记页链接（带 xsec_token）
 *     noteUrl,      // 不带 token 的短链
 *   }
 *   comment = { id, nick, avatar, content, liked, time, subComments: [] }
 */

const asStr = (v) => (v == null ? '' : String(v));

/** 小红书数字可能是 "1.2万" / "10万+" / 数字，统一转成展示字符串。 */
export function fmtCount(v) {
  if (v == null || v === '') return '';
  if (typeof v === 'string') return v.trim();
  const n = Number(v);
  if (!Number.isFinite(n)) return String(v);
  if (n >= 100000000) return `${(n / 100000000).toFixed(1).replace(/\.0$/, '')}亿`;
  if (n >= 10000) return `${(n / 10000).toFixed(1).replace(/\.0$/, '')}万`;
  return String(n);
}

/** 从 note_card 里挑封面。 */
function pickCover(nc) {
  const c = nc?.cover || {};
  return (
    c.urlDefault ||
    c.url_default ||
    c.urlPre ||
    c.url ||
    nc?.image_list?.[0]?.urlDefault ||
    nc?.image_list?.[0]?.url_default ||
    nc?.image_list?.[0]?.url ||
    ''
  );
}

/** 从 note_card 里取所有图片 URL（详情用）。 */
function pickImages(nc) {
  const list = nc?.image_list || [];
  return list
    .map(
      (img) =>
        img?.urlDefault ||
        img?.url_default ||
        img?.urlPre ||
        img?.url ||
        img?.info_list?.find?.((x) => x?.image_scene === 'WB_DFT')?.url ||
        '',
    )
    .filter(Boolean);
}

/** 一条搜索/feed 响应里的 item → note。item 形如 { id, xsec_token, note_card } */
export function parseNoteItem(item) {
  if (!item) return null;
  const nc = item.note_card || item.noteCard || {};
  const id = asStr(item.id || nc.note_id || nc.noteId);
  if (!id) return null;
  const xsecToken = asStr(item.xsec_token || item.xsecToken || item.xsecToken || '');
  const user = nc.user || {};
  const ii = nc.interact_info || nc.interactInfo || {};
  const tags = (nc.tag_list || nc.tagList || item.tag_list || [])
    .map((t) => asStr(t?.name || t))
    .filter(Boolean);
  const note = {
    id,
    xsecToken,
    title: asStr(nc.display_title || nc.displayTitle || nc.title),
    desc: asStr(nc.desc),
    author: {
      nick: asStr(user.nickname || user.nick_name || user.nickName),
      avatar: asStr(user.avatar || user.image || ''),
      userId: asStr(user.user_id || user.userId || user.userid),
    },
    cover: pickCover(nc),
    images: pickImages(nc),
    interact: {
      liked: fmtCount(ii.liked_count ?? ii.likedCount),
      collected: fmtCount(ii.collected_count ?? ii.collectedCount),
      comment: fmtCount(ii.comment_count ?? ii.commentCount),
      shared: fmtCount(ii.share_count ?? ii.shareCount),
    },
    tags,
    type: asStr(nc.type || 'normal'),
    noteUrl: `https://www.xiaohongshu.com/explore/${id}`,
    url: '',
  };
  note.url = note.xsecToken
    ? `${note.noteUrl}?xsec_token=${note.xsecToken}&xsec_source=pc_feed`
    : note.noteUrl;
  return note;
}

/** 整个 /search/notes 或 /homefeed 响应体 → note[] */
export function parseNotesResponse(body) {
  let data = body;
  if (typeof body === 'string') {
    try {
      data = JSON.parse(body);
    } catch {
      return [];
    }
  }
  const items = data?.data?.items || data?.items || [];
  const out = [];
  for (const it of items) {
    const n = parseNoteItem(it);
    if (n) out.push(n);
  }
  return out;
}

/** /feed 详情响应体（带完整 body）→ note（含 images / desc 全文） */
export function parseFeedResponse(body, fallback = null) {
  let data = body;
  if (typeof body === 'string') {
    try {
      data = JSON.parse(body);
    } catch {
      return fallback;
    }
  }
  const item = data?.data?.items?.[0];
  const nc = item?.note_card || item?.noteCard;
  if (!nc) return fallback;
  const merged = parseNoteItem({ id: item.id || fallback?.id, xsec_token: item.xsec_token, note_card: nc });
  if (!merged) return fallback;
  // 详情接口的 desc 才是全文；评论数等以详情为准
  if (fallback) {
    merged.xsecToken = merged.xsecToken || fallback.xsecToken;
    if (!merged.url) merged.url = fallback.url;
  }
  return merged;
}

/** /comment/page 响应体 → comment[]，带子评论（二级回复）。 */
export function parseCommentsResponse(body) {
  let data = body;
  if (typeof body === 'string') {
    try {
      data = JSON.parse(body);
    } catch {
      return [];
    }
  }
  const list = data?.data?.comments || data?.comments || [];
  return list.map((c) => ({
    id: asStr(c.id || c.comment_id),
    nick: asStr(c.user_info?.nickname || c.userInfo?.nickname || c.nickname),
    avatar: asStr(c.user_info?.image || c.userInfo?.image || ''),
    content: asStr(c.content),
    liked: fmtCount(c.like_count ?? c.likeCount),
    time: c.create_time ?? c.createTime ?? null,
    subComments: (c.sub_comments || c.subComments || []).map((s) => ({
      id: asStr(s.id || s.comment_id),
      nick: asStr(s.user_info?.nickname || s.userInfo?.nickname || s.nickname),
      content: asStr(s.content),
      liked: fmtCount(s.like_count ?? s.likeCount),
    })),
  }));
}

/** 简易探测一段响应体到底是不是搜索结果（用于 CDP 监听时识别）。 */
export function looksLikeNotesBody(text) {
  if (!text) return false;
  const t = text.slice(0, 2000);
  return /"items"\s*:/.test(t) && /("note_card"|"noteCard"|"display_title"|"xsec_token")/.test(t);
}
