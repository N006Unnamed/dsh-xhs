/**
 * config-schema.mjs —— 插件的 Config（schemastery）。宿主拿不到 schemastery 时整块省略。
 * 这里只做「存储 / 校验 / 设置页初值」，界面由 client.js 手写卡片渲染。
 */
export function xhsConfigSchema(z) {
  return z.object({
    enabled: z.boolean().default(true).description('启用小红书插件'),
    searchLimit: z.number().min(1).max(60).default(20).description('每次搜索的笔记条数'),
    noteDetailLimit: z.number().min(0).max(30).default(8).description('自动抓正文/评论的笔记条数（0=只拿列表）'),
    withComments: z.boolean().default(true).description('抓详情时附带评论'),
    keywords: z.array(z.string()).default([]).description('常用关键词（设置页快捷 chips）'),
    draftTopN: z.number().min(3).max(20).default(8).description('出稿时参考的笔记条数'),
    autoDraft: z.boolean().default(false).description('搜索后自动生成草稿'),
    browserPort: z.number().min(1024).max(65535).default(47891).description('CDP 调试端口'),
    schedule: z.object({
      enabled: z.boolean().default(false).description('定时搜索'),
      intervalMinutes: z.number().min(5).max(1440).default(60).description('定时间隔（分钟）'),
      keyword: z.string().default('').description('定时搜索的关键词（留空用第一个常用关键词）'),
    }).default({}),
  });
}
