# dsh-xhs

小红书热点 / 笔记采集插件（DSH 桌面端）。在「设置 → 小红书」里用卡片操作，也可被其他插件通过 `ctx.get('xhs')` 调用，并注册了 `xhs_*` 工具。

## 数据路线（为什么这么做）
小红书**没有免登录公开接口**：搜索 / 详情 / 评论全部要前端 `x-s`/`x-t` 签名 + 登录态 cookie。
纯算法签名（xhshow-js 那种）实测会被**设备指纹墙**拦，搜索接口稳定返回 HTTP 461。
所以本插件采用和抖音插件（DouyinHost）相同的路线：**在插件进程内起一个专用 Chrome，用 CDP 监听小红书自己发出的签名请求，只读响应 JSON、不碰签名**。

- 浏览器层：`lib/browser.mjs`（零依赖 CDP，Node 22+ 自带 WebSocket/fetch，直接复用自 fish-soul 的 douyin-bridge）
- 小红书层：`lib/xhs-host.js`（`XhsHost`，独立端口默认 47891、独立 profile 在 `$DSH_HOME/dsh-xhs/browser/`）
- 数据层：`src/core.mjs`（缓存 + 限速 + 组装）、`src/parse.mjs`（解析笔记/评论）、`src/draft.mjs`（据搜索结果用宿主 LLM 写一篇可发布笔记）

## 功能
- **连接与登录**：点「打开登录窗口」起专用 Chrome，首次扫码登录一次，之后登录态保存在 profile 里免登录。
- **搜索笔记**：
  - 「搜索（快）」只拿列表（标题/封面/作者/点赞/tag）
  - 「搜索并抓正文/评论」对前 N 条抓详情（正文 + 图片 + 评论）
- **生成发布草稿**：输入出稿关键词 +（可选）风格/角度，用宿主 LLM 把搜索结果写成一篇小红书笔记（标题+正文+话题标签），并附参考笔记。
- **定时搜索**：到点按关键词搜一次。
- **可被其他插件调用**：`ctx.get('xhs')` → `{ search, listNotes, note, draft, status, login }`。
- **工具**：`xhs_search / xhs_note / xhs_draft / xhs_login / xhs_status`。

## 目录
```
dsh-xhs/
  lib/
    index.js          # 插件入口：注入工具 / 路由 / ctx.provide('xhs') / 定时
    xhs-host.js       # XhsHost：起 Chrome + CDP 监听小红书接口
    browser.mjs       # 零依赖 CDP 浏览器控制（复用 douyin-bridge）
    routes.mjs        # /api/plugins/dsh-xhs/* 路由
    config-schema.mjs # Config（schemastery）
    llm.mjs           # 宿主 LLM 精简封装（写草稿用）
    hostdeps.mjs      # 从宿主拿 z / defineTool
    client.js         # 设置面板卡片（settings.section）
    panel.css         # 卡片样式
  src/
    parse.mjs         # 解析笔记/评论响应
    draft.mjs         # 文章 prompt + 草稿组装
    core.mjs          # 业务核心：缓存/限速/search/note/draft
  test/syntax.mjs     # 冒烟测试（node test/syntax.mjs）
  cordis.patch.yml
  package.json
```

## 合规
低频、单账号、人工触发；评论只做聚合展示、不留个人可识别信息；不二次分发。请用与主号无关的账号。
