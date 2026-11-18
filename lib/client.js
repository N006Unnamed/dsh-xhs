/**
 * dsh-xhs — 桌面端设置面板（client.js）
 *
 * 宿主契约（照抄 dsh-toutiao / fish-soul 的做法）：
 *  - window.__ModuleLoader__.load({ id, factory })，exports.apply / inject；inject: ["slots"]
 *  - ctx.slots.inject("settings.section", ...) 挂到「设置」里一个独立分区
 *  - 不 require 任何 Harness Client 包；控件结构照抄 ui-primitives
 *  - 所有数据走 /api/plugins/dsh-xhs/*（见 lib/routes.mjs）
 *
 * ⚠️ 血泪教训（dsh-toutiao 踩过）：函数组件只从 props.children 取子节点，
 *    不要用 rest 参数 ...kids（React 会额外传一个空 context 对象 → 当成子节点崩掉）。
 */
window.__ModuleLoader__.load({
	id: "dsh-xhs",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		const react = require("react");

		const inject = ["slots"];
		const PLUGIN_ID = "dsh-xhs";
		const API = "/api/plugins/dsh-xhs";
		const h = react.createElement;
		const cx = (...names) => names.filter(Boolean).join(" ");

		async function api(method, path, body) {
			try {
				const response = await fetch(API + path, {
					method,
					headers: { "content-type": "application/json" },
					...(body !== undefined ? { body: JSON.stringify(body) } : {}),
				});
				const data = await response.json().catch(() => null);
				if (data) return data;
				return { ok: false, error: `HTTP ${response.status}` };
			} catch (error) {
				return { ok: false, error: String(error instanceof Error ? error.message : error) };
			}
		}

		let cssPromise = null;
		function useCss() {
			const [css, setCss] = react.useState(null);
			react.useEffect(() => {
				let alive = true;
				cssPromise ??= fetch(`${API}/ui/panel.css`).then((r) => (r.ok ? r.text() : "")).catch(() => "");
				cssPromise.then((text) => { if (alive) setCss(text); if (text === "") cssPromise = null; });
				return () => { alive = false; };
			}, []);
			return css;
		}

		// ── 控件 ──
		function Switch({ checked, onChange, label, disabled }) {
			return h("button", { type: "button", role: "switch", "aria-checked": checked === true, "aria-label": label, disabled, className: "xs-switch", onClick: () => onChange(!checked) },
				h("span", { className: "xs-switch-thumb" }));
		}
		const Button = ({ variant, children, ...props }) => h("button", { type: "button", ...props, className: cx("xs-btn", variant) }, children);
		const Input = (props) => h("input", { spellCheck: false, autoComplete: "off", ...props, className: cx("xs-input", props.className) });
		const Num = (props) => h("input", { type: "number", inputMode: "numeric", ...props, className: "xs-input num" });
		const Dot = (state) => h("span", { className: "xs-dot", "data-state": state, "aria-hidden": true });
		const State = (state, text, title) => h("span", { className: "xs-state", "data-state": state, title: title ?? text, role: "status" }, Dot(state), h("span", null, text));
		const Tag = (text, tone) => h("span", { className: cx("xs-tag", tone) }, text);
		function Row({ title, desc, stack, children }) {
			return h("div", { className: cx("xs-row", stack && "stack") },
				h("div", { className: "xs-row-title" }, h("span", null, title), desc ? h("span", { className: "xs-row-desc" }, desc) : null),
				h("div", { className: "xs-ctl" }, children));
		}
		function Group({ title, children }) {
			return h("section", { className: "xs-group" }, title ? h("h3", { className: "xs-group-head" }, h("span", null, title)) : null, children);
		}

		const fmtClock = (ms) => {
			if (typeof ms !== "number" || !Number.isFinite(ms)) return "--:--";
			const d = new Date(ms);
			const p = (n) => String(n).padStart(2, "0");
			return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
		};

		// ── 列表/卡片 ──
		function NoteCard({ note, onOpen }) {
			const cover = note.cover
				? h("img", { className: "xs-card-cover", src: note.cover, loading: "lazy", alt: "" })
				: h("div", { className: "xs-card-cover-empty" }, "无封面");
			return h("div", { className: "xs-card", onClick: () => onOpen(note), role: "button", tabIndex: 0 },
				cover,
				h("div", { className: "xs-card-body" },
					h("div", { className: "xs-card-title" }, note.title || "(无题)"),
					h("div", { className: "xs-card-meta" },
						h("span", { className: "xs-card-author" },
							note.author?.avatar ? h("img", { className: "xs-card-av", src: note.author.avatar, alt: "" }) : null,
							h("span", null, note.author?.nick || "-")),
						h("span", null, "♥ ", note.interact?.liked || "-"))));
		}

		function NoteGrid({ items, onOpen }) {
			if (!items || !items.length) return h("p", { className: "xs-muted" }, "没有笔记。");
			return h("div", { className: "xs-cards" }, items.map((n, i) => h(NoteCard, { key: n.id || i, note: n, onOpen })));
		}

		function Comment({ c }) {
			return h("div", { className: "xs-comment" },
				c.avatar ? h("img", { className: "xs-comment-av", src: c.avatar, alt: "" }) : h("div", { className: "xs-comment-av" }),
				h("div", { className: "xs-comment-body" },
					h("div", { className: "xs-comment-nick" }, c.nick || "-", c.liked ? h("span", { className: "xs-muted" }, `  ♥ ${c.liked}`) : null),
					h("div", { className: "xs-comment-text" }, c.content),
					(c.subComments || []).map((s, i) => h("div", { key: i, className: "xs-comment-sub" }, `${s.nick || "-"}：${s.content}`))));
		}

		function NoteDetail({ note, loading, onClose }) {
			if (loading) return h("div", { className: "xs-detail" }, h("p", { className: "xs-loading" }, "正在打开笔记…"));
			if (!note) return null;
			return h("div", { className: "xs-detail" },
				h("div", { className: "xs-detail-head" },
					h("div", null,
						h("div", { className: "xs-detail-title" }, note.title || "(无题)"),
						h("div", { className: "xs-detail-author" }, `@${note.author?.nick || "-"} ｜ ♥${note.interact?.liked || "-"} 收藏${note.interact?.collected || "-"} 评论${note.interact?.comment || "-"}`)),
					h(Button, { variant: "ghost", onClick: onClose }, "关闭")),
				(note.tags || []).length ? h("div", { className: "xs-draft-tags" }, note.tags.map((t, i) => h(react.Fragment, { key: i }, Tag("#" + t, "plain")))) : null,
				h("div", { className: "xs-detail-desc" }, note.desc || "(无正文)"),
				(note.images || []).length > 1 ? h("div", { className: "xs-detail-imgs" }, note.images.map((src, i) => h("img", { key: i, src, loading: "lazy", alt: "" }))) : null,
				h("div", { className: "xs-comments" },
					(note.comments || []).length
						? note.comments.slice(0, 30).map((c, i) => h(Comment, { key: c.id || i, c }))
						: h("p", { className: "xs-muted" }, "（无评论 / 未抓取）")),
				note.url ? h("p", { className: "xs-muted" }, h("a", { href: note.url, target: "_blank", rel: "noreferrer" }, "在网页里打开")) : null);
		}

		function XhsSection() {
			const css = useCss();
			const [cfg, setCfg] = react.useState(null);
			const [status, setStatus] = react.useState(null);
			const [busy, setBusy] = react.useState("");
			const [kwInput, setKwInput] = react.useState("");
			const [search, setSearch] = react.useState(null);
			const [detail, setDetail] = react.useState(null);
			const [detailLoading, setDetailLoading] = react.useState(false);
			const [draftKw, setDraftKw] = react.useState("");
			const [draftStyle, setDraftStyle] = react.useState("");
			const [draftText, setDraftText] = react.useState(null);
			const [toast, setToast] = react.useState(null);

			const notify = (text) => { setToast({ text, key: Date.now() }); setTimeout(() => setToast(null), 2600); };

			const loadState = async () => {
				const r = await api("GET", "/state");
				if (r.ok) { setCfg(r.config || {}); setStatus(r.status || null); }
			};
			react.useEffect(() => { loadState(); }, []);

			const patch = async (p) => {
				const r = await api("POST", "/config", p);
				if (r.ok) { setCfg(r.config || {}); notify("已保存"); } else notify(r.error || "保存失败");
			};

			const openLogin = async () => {
				setBusy("login");
				const r = await api("POST", "/login");
				setBusy("");
				if (r.ok) { notify("已打开小红书窗口，请在其中扫码登录"); loadState(); }
				else notify(r.error || "打开失败");
			};

			const stopBrowser = async () => {
				setBusy("stop");
				await api("POST", "/stop");
				setBusy("");
				notify("已关闭浏览器");
				loadState();
			};

			// 只列表（快）
			const doList = async () => {
				const kw = kwInput.trim();
				if (!kw) return;
				setBusy("list");
				const r = await api("POST", "/list", { keyword: kw });
				setBusy("");
				if (r.ok) { setSearch({ kw, items: r.items, detail: false }); setDraftKw(kw); setDetail(null); notify(`「${kw}」${r.items.length} 条${r.cached ? "（缓存）" : ""}`); }
				else notify(r.error || "搜索失败");
			};

			// 带正文/评论（慢）
			const doSearch = async () => {
				const kw = kwInput.trim();
				if (!kw) return;
				setBusy("search");
				const r = await api("POST", "/search", { keyword: kw });
				setBusy("");
				if (r.ok) { setSearch({ kw, items: r.items, detail: true }); setDraftKw(kw); setDetail(null); notify(`「${kw}」${r.items.length} 条（含正文/评论）`); }
				else notify(r.error || "搜索失败");
			};

			const openNote = async (note) => {
				// 若列表已带正文（detail 模式）直接展示；否则点开再抓
				if (search?.detail && note.desc) { setDetail(note); return; }
				setDetailLoading(true);
				setDetail({ title: note.title });
				const r = await api("POST", "/note", { id: note.id, xsecToken: note.xsecToken, url: note.url });
				setDetailLoading(false);
				if (r.ok) setDetail(r.note);
				else { setDetail(null); notify(r.error || "打开笔记失败"); }
			};

			const makeDraft = async () => {
				const kw = String(draftKw || "").trim();
				if (!kw) { notify("先输入要出稿的关键词"); return; }
				setBusy("draft");
				const r = await api("POST", "/draft", { keyword: kw, style: draftStyle, topN: cfg?.draftTopN });
				setBusy("");
				if (r.ok) { setDraftText(r.draft); notify("已生成草稿"); }
				else notify(r.error || "生成失败");
			};

			if (css === null) return null;
			if (cfg === null) {
				return h("div", { className: "xs" },
					css === "" ? null : h("style", { "data-plugin-css": `${PLUGIN_ID}/panel.css` }, css),
					h("p", { className: "xs-muted" }, "加载中…"));
			}

			const schedule = cfg.schedule || {};
			const keywords = Array.isArray(cfg.keywords) ? cfg.keywords : [];
			const st = status || {};
			const connected = st.connected === true;

			return h("div", { className: "xs" },
				css === "" ? null : h("style", { "data-plugin-css": `${PLUGIN_ID}/panel.css` }, css),

				// 连接 / 登录
				h(Group, { title: "连接与登录" },
					h(Row, { title: "浏览器", desc: connected ? `已连接（端口 ${st.port}）` : "未连接 · 点「打开登录窗口」启动" },
						State(connected ? "connected" : "off", connected ? "已连接" : "未连接"),
						h(Button, { variant: "primary", disabled: busy === "login", onClick: openLogin }, busy === "login" ? "启动中…" : "打开登录窗口"),
						connected ? h(Button, { disabled: busy === "stop", onClick: stopBrowser }, "关闭浏览器") : null),
					h(Row, { title: "说明", desc: "小红书搜索需要真实浏览器签名；登录一次后登录态留在插件自己的浏览器 profile 里，之后免登录。" })),

				// 采集设置
				h(Group, { title: "采集设置" },
					h(Row, { title: "每次搜索条数", desc: "1~60" },
						h(Num, { value: cfg.searchLimit ?? 20, min: 1, max: 60, onChange: (e) => setCfg({ ...cfg, searchLimit: Number(e.target.value) }), onBlur: (e) => patch({ searchLimit: Number(e.target.value) }) })),
					h(Row, { title: "自动抓正文/评论条数", desc: "搜『含正文』时对前 N 条抓详情；0=只拿列表" },
						h(Num, { value: cfg.noteDetailLimit ?? 8, min: 0, max: 30, onChange: (e) => setCfg({ ...cfg, noteDetailLimit: Number(e.target.value) }), onBlur: (e) => patch({ noteDetailLimit: Number(e.target.value) }) })),
					h(Row, { title: "抓详情时附带评论", desc: "关掉更快" },
						h(Switch, { checked: cfg.withComments !== false, label: "附带评论", onChange: (v) => patch({ withComments: v }) })),
					h(Row, { title: "出稿参考条数", desc: "生成草稿时参考前 N 条笔记" },
						h(Num, { value: cfg.draftTopN ?? 8, min: 3, max: 20, onChange: (e) => setCfg({ ...cfg, draftTopN: Number(e.target.value) }), onBlur: (e) => patch({ draftTopN: Number(e.target.value) }) }))),

				// 常用关键词
				h(Group, { title: "常用关键词" },
					h(Row, { title: "关键词 chips", desc: "点一下直接搜；可在后面输入框加新词（回车添加）", stack: true },
						h("div", { className: "xs-chips" },
							keywords.map((k, i) => h("span", { key: i, className: "xs-chip", onClick: () => { setKwInput(k); } }, k,
								h("span", { className: "x", onClick: (e) => { e.stopPropagation(); patch({ keywords: keywords.filter((_, j) => j !== i) }); } }, "×"))),
							h(Input, { placeholder: "输入后回车添加", onKeyDown: (e) => { if (e.key === "Enter" && e.target.value.trim()) { patch({ keywords: [...keywords, e.target.value.trim()] }); e.target.value = ""; } } })))),

				// 搜索
				h(Group, { title: "搜索笔记" },
					h(Row, { title: "搜一条看看", stack: true },
						h(Input, { value: kwInput, placeholder: "输入关键词，如 穿搭 / 露营", onChange: (e) => setKwInput(e.target.value), onKeyDown: (e) => { if (e.key === "Enter") doList(); } }),
						h("div", { className: "xs-ctl" },
							h(Button, { disabled: busy === "list" || !kwInput.trim(), onClick: doList }, busy === "list" ? "搜索中…" : "搜索（快）"),
							h(Button, { variant: "primary", disabled: busy === "search" || !kwInput.trim(), onClick: doSearch }, busy === "search" ? "抓取中…" : "搜索并抓正文/评论"))),
					search ? h("div", null,
						h("h4", { className: "xs-group-head" }, `「${search.kw}」${search.items.length} 条${search.detail ? "（含正文）" : ""}`),
						h(NoteGrid, { items: search.items, onOpen: openNote })) : null,
					detail || detailLoading ? h(NoteDetail, { note: detail, loading: detailLoading, onClose: () => { setDetail(null); setDetailLoading(false); } }) : null),

				// 生成草稿
				h(Group, { title: "生成发布草稿" },
					h(Row, { title: "按关键词写一篇小红书笔记", desc: draftKw ? `将据「${draftKw}」的搜索结果写成可发布正文` : "先在上面搜索或直接填关键词", stack: true },
						h(Input, { value: draftKw, placeholder: "输入出稿关键词，如 穿搭", onChange: (e) => setDraftKw(e.target.value) })),
					h(Row, { title: "风格 / 角度（可选）", desc: "控制文风，如：真诚、干货、带点幽默、极简", stack: true },
						h(Input, { value: draftStyle, placeholder: "例如：真诚、干货、带点幽默（留空则自然文风）", onChange: (e) => setDraftStyle(e.target.value) })),
					h("div", { className: "xs-ctl" },
						h(Button, { variant: "primary", disabled: busy === "draft", onClick: makeDraft }, busy === "draft" ? "生成中…" : "生成小红书笔记")),
					draftText ? h("div", { className: "xs-draft" },
						h("div", { className: "xs-draft-title" }, draftText.title),
						h("p", { className: "xs-muted" }, draftText.generatedByAi ? `（模型据「${draftText.keyword}」撰写${draftText.style?.length ? "｜文风：" + draftText.style.join("、") : ""}）` : "（模型不可用·素材提纲）"),
						h("div", { className: "xs-draft-tags" }, (draftText.tags || []).map((t, i) => h(react.Fragment, { key: i }, Tag("#" + t, "plain")))),
						h("div", { className: "xs-draft-body" }, draftText.bodyText),
						(draftText.refs || []).length ? h("div", { className: "xs-refs" },
							"参考笔记：",
							draftText.refs.map((r, i) => h("div", { key: i }, `${i + 1}. `, r.url ? h("a", { href: r.url, target: "_blank", rel: "noreferrer" }, r.title) : r.title, r.author ? ` @${r.author}` : ""))) : null) : null),

				// 定时
				h(Group, { title: "定时搜索" },
					h(Row, { title: "开启定时", desc: schedule.enabled ? `每 ${schedule.intervalMinutes || 60} 分钟搜「${schedule.keyword || keywords[0] || "未设关键词"}」` : "到点按关键词搜一次（结果记在状态里）" },
						h(Switch, { checked: schedule.enabled === true, label: "定时搜索", onChange: (v) => patch({ schedule: { ...schedule, enabled: v } }) })),
					h(Row, { title: "间隔（分钟）", desc: "5~1440" },
						h(Num, { value: schedule.intervalMinutes ?? 60, min: 5, max: 1440, disabled: !schedule.enabled,
							onChange: (e) => setCfg({ ...cfg, schedule: { ...schedule, intervalMinutes: Number(e.target.value) } }),
							onBlur: (e) => patch({ schedule: { ...schedule, intervalMinutes: Number(e.target.value) } }) })),
					h(Row, { title: "定时关键词", desc: "留空用第一个常用关键词", stack: true },
						h(Input, { value: schedule.keyword || "", placeholder: "如 穿搭", disabled: !schedule.enabled,
							onChange: (e) => setCfg({ ...cfg, schedule: { ...schedule, keyword: e.target.value } }),
							onBlur: (e) => patch({ schedule: { ...schedule, keyword: e.target.value } }) }))),

				toast ? h("div", { className: "xs-toast", role: "status", key: toast.key }, toast.text) : null);
		}

		function apply(ctx) {
			ctx.effect(() => ctx.slots.inject("settings.section", () => ctx.slots.register({
				name: "settings.section",
				id: "dsh-xhs",
				order: 63,
				label: () => "小红书"
			}, XhsSection)), `${PLUGIN_ID}: panel`);
		}

		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	}
});
