// dsh-xhs 冒烟测试：不启动浏览器，只验证模块可加载、导出齐全、工具/服务/路由注册逻辑。
// 运行：node test/syntax.mjs
import assert from "node:assert";

const results = [];
function ok(name) { results.push(["✓", name]); }
function bad(name, err) { results.push(["✗", name + " :: " + (err && err.message || err)]); }

// 1) parse.mjs 纯函数
try {
  const p = await import("../src/parse.mjs");
  const sample = {
    code: 0, success: true,
    data: { items: [{
      id: "abc123", xsec_token: "TOK",
      note_card: {
        display_title: "夏日穿搭分享", desc: "今天穿了好喜欢的裙子",
        user: { nickname: "小美", avatar: "http://a/x.jpg", user_id: "u1" },
        interact_info: { liked_count: "1.2万", collected_count: "300", comment_count: "45" },
        cover: { url_default: "http://a/c.jpg" },
        image_list: [{ url_default: "http://a/1.jpg" }],
        tag_list: [{ name: "穿搭" }, { name: "夏日" }],
        type: "normal",
      },
    }] },
  };
  const notes = p.parseNotesResponse(sample);
  assert.equal(notes.length, 1, "notes len");
  assert.equal(notes[0].id, "abc123");
  assert.equal(notes[0].xsecToken, "TOK");
  assert.equal(notes[0].author.nick, "小美");
  assert.equal(notes[0].interact.liked, "1.2万");
  assert.deepEqual(notes[0].tags, ["穿搭", "夏日"]);
  assert.ok(p.fmtCount(12000).includes("万"), "fmtCount 万");
  const cm = p.parseCommentsResponse({ data: { comments: [{ id: "c1", content: "好看", user_info: { nickname: "路人", image: "img" }, like_count: "3", sub_comments: [{ id: "s1", content: "同问", user_info: { nickname: "乙" } }] }] } });
  assert.equal(cm.length, 1);
  assert.equal(cm[0].nick, "路人");
  assert.equal(cm[0].subComments.length, 1);
  ok("parse.mjs 解析笔记/评论");
} catch (e) { bad("parse.mjs", e); }

// 2) draft.mjs 纯函数
try {
  const d = await import("../src/draft.mjs");
  const notes = [{ id: "n1", title: "穿搭T1", desc: "描述一", author: { nick: "A" }, interact: { liked: "1万" }, url: "http://x/1" }];
  const prompt = d.buildArticlePrompt("穿搭", notes, { style: ["真诚", "干货"], topN: 8 });
  assert.ok(prompt.includes("穿搭"), "prompt 含关键词");
  assert.ok(prompt.includes("真诚"), "prompt 含风格");
  assert.ok(prompt.includes("穿搭T1"), "prompt 含素材");
  const split = d.splitArticle("穿搭", "标题行\n\n第一段正文。\n\n第二段正文。\n\n#穿搭 #夏日", { style: ["真诚"] });
  assert.ok(split.title, "split 有标题");
  assert.ok(split.tags.length >= 1, "split 有 tags");
  const draft = d.buildDraft({ keyword: "穿搭", notes, articleText: "标题行\n\n正文一\n\n正文二", style: ["真诚"], generatedByAi: true });
  assert.equal(draft.kind, "xhs");
  assert.equal(draft.generatedByAi, true);
  assert.ok(Array.isArray(draft.refs) && draft.refs.length === 1, "draft refs");
  ok("draft.mjs 组装文章/prompt");
} catch (e) { bad("draft.mjs", e); }

// 3) config-schema.mjs 需要 z — 用假的 z 验证结构
try {
  const c = await import("../lib/config-schema.mjs");
  // 用一个最小 z 存根
  const chain = (o) => {
    const self = { ...o, min: () => self, max: () => self, default: () => self, description: () => self };
    return self;
  };
  const zobj = (shape) => chain({ __type: "object", shape });
  const fakeZ = {
    object: zobj,
    boolean: () => chain({ __type: "boolean" }),
    array: (x) => chain({ __type: "array", item: x }),
    string: () => chain({ __type: "string" }),
    number: () => chain({ __type: "number" }),
  };
  const schema = c.xhsConfigSchema(fakeZ);
  assert.equal(schema.__type, "object");
  assert.ok("searchLimit" in schema.shape, "schema 有 searchLimit");
  assert.ok("schedule" in schema.shape, "schema 有 schedule");
  ok("config-schema.mjs 结构");
} catch (e) { bad("config-schema.mjs", e); }

// 4) core.mjs / xhs-host.js / routes.mjs / index.js 仅检查可 import（index 依赖 hostdeps，可能拿不到 z）
try {
  await import("../lib/xhs-host.js");
  ok("xhs-host.js 可加载");
} catch (e) { bad("xhs-host.js", e); }
try {
  const core = await import("../src/core.mjs");
  assert.equal(typeof core.createCore, "function");
  ok("core.mjs 可加载");
} catch (e) { bad("core.mjs", e); }
try {
  const routes = await import("../lib/routes.mjs");
  assert.equal(typeof routes.createRoutes, "function");
  ok("routes.mjs 可加载");
} catch (e) { bad("routes.mjs", e); }

// 5) 打印
console.log("\n=== dsh-xhs smoke test ===");
for (const [mark, msg] of results) console.log(mark, msg);
const failed = results.filter(([m]) => m === "✗");
console.log(`\n${results.length - failed.length}/${results.length} passed`);
if (failed.length) process.exit(1);
