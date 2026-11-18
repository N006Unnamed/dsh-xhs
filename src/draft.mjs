/**
 * draft.mjs —— 据小红书笔记素材，用宿主模型写一篇「可发布的小红书笔记 / 种草文」。
 *
 * 与头条插件的区别：小红书是「种草社区」，文体更口语、第一人称、分点、带 emoji，
 * 但仍要先给一篇针对这件事的**完整可发布正文**（介绍 + 真实素材支撑 + 自己的观察/建议），
 * 而不是把搜索结果罗列成报表。
 */
import { fmtCount } from './parse.mjs';

const CN_MONTH_DAY = (d = new Date()) => `${d.getMonth() + 1}月${d.getDate()}日`;

/** 把笔记列表压成给模型的素材文本（只给事实，防编造）。 */
export function materialsFromNotes(notes, topN = 10) {
  const list = (notes || []).slice(0, Math.min(20, Math.max(1, topN)));
  return list
    .map((n, i) => {
      const meta = [
        n.author?.nick ? `作者：${n.author.nick}` : '',
        n.interact?.liked ? `赞${n.interact.liked}` : '',
        n.tags?.length ? `标签：${n.tags.join(' ')}` : '',
      ].filter(Boolean).join(' ｜ ');
      const body = (n.desc || '').replace(/\s+/g, ' ').slice(0, 220);
      return `${i + 1}. 《${n.title || '(无题)'}》${meta ? `\n   ${meta}` : ''}${body ? `\n   摘要：${body}` : ''}`;
    })
    .join('\n');
}

/**
 * 构造写文章的提示词。
 * @param {string} keyword
 * @param {Array} notes 素材笔记
 * @param {{style?:string[], topN?:number, platform?:'xhs'|'toutiao'}} opts
 */
export function buildArticlePrompt(keyword, notes, { style = [], topN = 10 } = {}) {
  const styleText = style && style.length
    ? `文风/角度要求：${style.join('、')}。（请让这些风格明显体现在语气和取舍上）`
    : '文风：自然、真诚、像真实用户在分享，不要像广告或公文。';
  const mat = materialsFromNotes(notes, topN);
  return [
    `你是小红书上的资深分享者，现在要围绕「${keyword}」写一篇**可以直接发布的小红书笔记**。`,
    '',
    '要求：',
    '1) 标题：20 字以内，带一点小红书味（可以有 emoji），吸引但别夸张到假。',
    '2) 正文：400~700 字，第一人称，口语化，分段清晰；可以先抛出一个大家关心的问题/痛点，再结合下面的真实素材讲清楚，最后给出你自己的想法或可执行的建议。',
    '3) 不要罗列和统计（不要"第1条、第2条数据"这种报表腔），要像一个人在讲自己的观察和判断。',
    '4) 只能使用下面素材里出现的事实，**不要编造具体数字、品牌、地点、价格**；素材不够就写得含蓄一些。',
    `5) ${styleText}`,
    '6) 结尾给 4~6 个话题标签，用 # 开头，单独一行。',
    '',
    `【真实素材（小红书「${keyword}」相关笔记）】`,
    mat || '（这次没拿到素材，请写得通用、克制，不要编造事实）',
    '',
    '请直接输出：第一行「标题：xxx」，空一行，然后正文，最后一行话题标签。',
  ].join('\n');
}

/** 从模型返回文本里拆出 标题 / 正文 / 标签。 */
export function splitArticle(keyword, text, { style = [], date = new Date() } = {}) {
  const raw = String(text || '').trim();
  let title = '';
  let rest = raw;
  const m = raw.match(/^标题[:：]\s*(.+)$/m);
  if (m) {
    title = m[1].trim();
    rest = raw.slice(raw.indexOf(m[0]) + m[0].length).trim();
  }
  // 末尾话题行
  const lines = rest.split(/\n/);
  const tagLines = [];
  while (lines.length) {
    const last = lines[lines.length - 1].trim();
    if (/^#|(#[\u4e00-\u9fa5\w]+\s*){2,}/.test(last) || (/^#/.test(last) && last.length < 120)) {
      tagLines.unshift(lines.pop().trim());
    } else break;
  }
  let bodyText = lines.join('\n').trim();
  // 若正文里还夹着 # 标签，抽出来
  const inlineTags = (raw.match(/#[\u4e00-\u9fa5A-Za-z0-9_]+/g) || []).map((t) => t.slice(1));
  const tagSource = (tagLines.join(' ') + ' ' + inlineTags.join(' ')).trim();
  let tags = Array.from(new Set((tagSource.match(/#?[\u4e00-\u9fa5A-Za-z0-9_]+/g) || []).map((t) => t.replace(/^#/, '')).filter((t) => t && t.length <= 20))).slice(0, 8);
  if (!tags.length) tags = ['小红书', keyword, ...(style || [])].filter(Boolean).slice(0, 6);
  if (!title) title = `${keyword}｜${CN_MONTH_DAY(date)}`;
  return { title: title.slice(0, 40), bodyText, tags };
}

/** 组装最终草稿对象（前端/工具统一消费）。 */
export function buildDraft({ keyword, notes, articleText, style = [], date = new Date(), generatedByAi = true }) {
  const { title, bodyText, tags } = splitArticle(keyword, articleText, { style, date });
  const top = (notes || [])[0];
  return {
    kind: 'xhs',
    keyword,
    style: style || [],
    title,
    summary: (bodyText.split(/\n/).find((l) => l.trim()) || '').slice(0, 60),
    bodyText,
    tags,
    generatedByAi,
    cover: top?.cover || '',
    refs: (notes || []).slice(0, 10).map((n) => ({
      id: n.id,
      title: n.title,
      author: n.author?.nick,
      liked: n.interact?.liked,
      url: n.url,
    })),
    date: CN_MONTH_DAY(date),
  };
}

export { fmtCount };
