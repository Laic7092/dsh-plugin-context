/**
 * dsh-plugin-context — browser half.
 *
 * Plain JavaScript in the harness's own module format, not a bundler output:
 * `dsh-client-modules` serves this file verbatim, so there is no build tool in
 * this package. React and the `slots` service arrive through `require` and
 * Cordis; every byte of data comes from the host half's own JSON routes over
 * `fetch`, so no live Cordis object ever crosses the wire.
 *
 * It contributes two seats, both additive, and every string it draws comes from
 * the `context-control` dictionary it registers with the harness's locale
 * service — so the panel follows the GUI language (English or Chinese) with no
 * reload:
 *
 *  - a **Conversation View** (`context-control`) beside Chat, Trajectory and the
 *    other views: the full panel — the context as one stacked bar, every surface
 *    node in request order with its own bar, the largest entries ranked, the
 *    toolCall → toolResult table, the interventions log, and the configuration;
 *  - a **header meter** (`cc-meter`) that is readable while the conversation is
 *    on screen, because the number that matters is the one you can see without
 *    leaving the chat.
 *
 * Three rules decide the drawing. **Every colour is a documented theme token**,
 * so the panel follows light and dark without knowing either exists — the
 * categorical distinction comes from mixing four tokens with opacity and one
 * stripe pattern rather than from a hard-coded palette that would break in the
 * other theme. **Bars are proportional to the numbers next to them**, so a wide
 * bar always means a big number and never a decorative one. And **the dry run is
 * drawn like a result**: an intervention that was only measured says so.
 */
// The harness's client loader concatenates module sources and calls each factory
// with a CommonJS-like `require`; nothing here is a bundler output, so there is no
// module id to import and the loader itself is reached off `window`.
(window as unknown as {
	__ModuleLoader__: { load(spec: { id: string; factory: (require: (id: string) => any) => any }): void };
}).__ModuleLoader__.load({
	id: "dsh-plugin-context",
	factory: (require) => {
		var module = { exports: {} };
		var exports: any = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		const react = require("react");
		const h = react.createElement;
		//#region styles
		/**
		 * The panel's appearance, in one self-contained style tag that names its
		 * owner. One measure (a capped, centred column), intrinsic wrapping rather
		 * than viewport media queries, and theme tokens only.
		 */
		const CSS = [
			".ccPane{box-sizing:border-box;display:flex;flex-direction:column;gap:14px;width:100%;max-width:1220px;margin:0 auto;padding:20px 4px;font-size:13px;line-height:1.6;color:var(--dsw-alias-label-primary)}",
			".ccPane *{box-sizing:border-box}",
			".ccRow{display:flex;flex-wrap:wrap;gap:8px;align-items:center}",
			".ccSpacer{flex:1 1 auto}",
			".ccCard{padding:12px 14px;background:var(--dsw-alias-bg-layer-1);border:1px solid var(--dsw-alias-border-l1);border-radius:12px}",
			".ccCard h4{margin:0 0 10px;font-size:12px;font-weight:600;color:var(--dsw-alias-label-secondary);display:flex;flex-wrap:wrap;gap:8px;align-items:center}",
			".ccMuted{color:var(--dsw-alias-label-secondary)}",
			".ccNote{margin:0;padding:6px 10px;border-left:2px solid var(--dsw-alias-border-l2);border-radius:0 8px 8px 0;background:var(--dsw-alias-bg-layer-2);overflow-wrap:anywhere}",
			".ccNoteError{border-left-color:var(--dsw-alias-state-error-primary);color:var(--dsw-alias-state-error-primary)}",
			".ccNoteWarn{border-left-color:var(--dsw-alias-state-warn-primary)}",
			".ccBtn{height:26px;padding:0 10px;color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-layer-2);border:1px solid var(--dsw-alias-border-l1);border-radius:8px;cursor:pointer;font-size:12px;white-space:nowrap}",
			".ccBtn:hover:not(:disabled){border-color:var(--dsw-alias-border-l2)}",
			".ccBtn:disabled{color:var(--dsw-alias-label-secondary);cursor:default;opacity:.55}",
			".ccBtnPrimary{color:var(--dsw-alias-bg-base);background:var(--dsw-alias-brand-primary);border-color:var(--dsw-alias-brand-primary)}",
			".ccBtnTiny{height:20px;padding:0 7px;font-size:11px}",
			".ccInput,.ccSelect{height:26px;padding:0 7px;color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-layer-2);border:1px solid var(--dsw-alias-border-l1);border-radius:8px;font-size:12px}",
			".ccInput{width:96px;font-variant-numeric:tabular-nums}",
			".ccNum{font-variant-numeric:tabular-nums}",
			/* The shell: the working column, and a rail that keeps the controls in view. */
			".ccShell{display:grid;grid-template-columns:minmax(0,1fr) 330px;gap:14px;align-items:start}",
			".ccMain,.ccRail{display:flex;flex-direction:column;gap:14px;min-width:0}",
			".ccRail{position:sticky;top:12px}",
			"@media (max-width:900px){.ccShell{grid-template-columns:minmax(0,1fr)}}",
			/* The composition bar: every segment and legend entry is a filter. */
			".ccBar{display:flex;width:100%;height:26px;overflow:hidden;border:1px solid var(--dsw-alias-border-l1);border-radius:8px;background:var(--dsw-alias-bg-layer-2)}",
			".ccSeg{height:100%;min-width:1px;padding:0;border:0;cursor:pointer}",
			".ccSeg:hover{outline:2px solid var(--dsw-alias-label-secondary);outline-offset:-2px}",
			".ccSegOn{outline:2px solid var(--dsw-alias-label-primary);outline-offset:-2px}",
			".ccSeg:disabled{cursor:default}",
			".ccLegendItem:disabled{cursor:default;opacity:.7}",
			".ccFree{height:100%;flex:1 1 auto;background:repeating-linear-gradient(45deg,transparent,transparent 4px,var(--dsw-alias-border-l1) 4px,var(--dsw-alias-border-l1) 5px)}",
			".ccLegend{display:flex;flex-wrap:wrap;gap:6px 14px;margin-top:10px}",
			".ccLegendItem{display:flex;gap:6px;align-items:center;font-size:12px;padding:0;border:0;background:transparent;color:inherit;cursor:pointer;font-family:inherit}",
			".ccLegendItem:hover{color:var(--dsw-alias-label-primary);text-decoration:underline}",
			".ccSwatch{width:10px;height:10px;flex:none;border:1px solid var(--dsw-alias-border-l1);border-radius:2px}",
			/* The query bar. */
			".ccQuery{display:flex;flex-direction:column;gap:8px}",
			".ccChips{display:flex;flex-wrap:wrap;gap:6px;align-items:center}",
			".ccToggle{height:24px;padding:0 9px;font-size:11px;border-radius:999px;border:1px solid var(--dsw-alias-border-l1);background:transparent;color:var(--dsw-alias-label-secondary);cursor:pointer;white-space:nowrap}",
			".ccToggle:hover{border-color:var(--dsw-alias-border-l2);color:var(--dsw-alias-label-primary)}",
			".ccToggleOn{background:var(--dsw-alias-bg-layer-2);border-color:var(--dsw-alias-border-l2);color:var(--dsw-alias-label-primary);font-weight:600}",
			".ccCond{display:flex;gap:6px;align-items:center}",
			/* The one table. */
			".ccRowHead{font-size:11px;color:var(--dsw-alias-label-secondary)}",
			".ccTableRow{display:grid;gap:6px 10px;align-items:center;padding:4px 0;border-top:1px solid var(--dsw-alias-border-l1)}",
			".ccTableRow:first-child{border-top:none}",
			".ccNodeTable{grid-template-columns:56px 92px minmax(0,1fr) 74px 84px minmax(0,148px) 74px}",
			".ccCallTable{grid-template-columns:minmax(0,1fr) 74px 84px 92px 74px minmax(0,110px)}",
			"@media (max-width:1180px){.ccNodeTable{grid-template-columns:56px 92px minmax(0,1fr) 74px 84px 74px}.ccNodeTable .ccColChars{display:none}.ccCallTable{grid-template-columns:minmax(0,1fr) 74px 74px}.ccCallTable .ccColResultTok,.ccCallTable .ccColMs,.ccCallTable .ccColResult,.ccCallTable .ccColStatus{display:none}}",
			".ccCell{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}",
			".ccChip{flex:none;padding:1px 6px;border:1px solid var(--dsw-alias-border-l1);border-radius:999px;font-size:11px;color:var(--dsw-alias-label-secondary)}",
			".ccChipOver{border-color:var(--dsw-alias-state-warn-primary);color:var(--dsw-alias-state-warn-primary)}",
			".ccChipError{border-color:var(--dsw-alias-state-error-primary);color:var(--dsw-alias-state-error-primary)}",
			".ccChipOk{border-color:var(--dsw-alias-state-success-primary);color:var(--dsw-alias-state-success-primary)}",
			".ccMini{height:8px;overflow:hidden;background:var(--dsw-alias-bg-layer-2);border-radius:4px}",
			".ccMiniFill{height:100%}",
			".ccScroll{max-height:340px;overflow:auto}",
			".ccMono{font-family:var(--dsw-font-mono);font-size:12px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}",
			/* The summary projection. */
			".ccSummaryRow{display:grid;grid-template-columns:minmax(0,132px) minmax(0,1fr) 92px;gap:10px;align-items:center;padding:4px 0;border-top:1px solid var(--dsw-alias-border-l1)}",
			".ccSummaryRow:first-child{border-top:none}",
			/* The batch strip, and the log rows. */
			".ccLogRow{display:flex;flex-wrap:wrap;gap:8px;align-items:center;padding:4px 0;border-top:1px solid var(--dsw-alias-border-l1)}",
			".ccLogRow:first-child{border-top:none}",
			/* The configuration form. */
			".ccKind{display:grid;grid-template-columns:76px minmax(0,1fr);gap:8px 12px;align-items:center;padding:8px 0;border-top:1px solid var(--dsw-alias-border-l1)}",
			".ccKind:first-child{border-top:none}",
			".ccKindName{font-weight:600}",
			"@media (max-width:640px){.ccNodeTable,.ccCallTable,.ccSummaryRow{grid-template-columns:minmax(0,1fr)}}",
		].join("");
		const CSS_ID = "dsh-plugin-context/panel.css";
		if (typeof document !== "undefined" && document.querySelector("style[data-plugin-css=" + JSON.stringify(CSS_ID) + "]") === null) {
			const tag = document.createElement("style");
			tag.dataset.plugin = "dsh-plugin-context";
			tag.dataset.pluginCss = CSS_ID;
			tag.textContent = CSS;
			document.head.appendChild(tag);
		}
		//#endregion
		//#region helpers
		const numberFormat = new Intl.NumberFormat("en-US");
		const num = (value) => (typeof value === "number" && Number.isFinite(value) ? numberFormat.format(value) : "–");
		/** Compact token figures: 12.3k reads faster than 12,345 and keeps a row narrow. */
		const compact = (value) => {
			if (typeof value !== "number" || !Number.isFinite(value)) return "–";
			if (value < 1000) return String(value);
			if (value < 1_000_000) return `${(value / 1000).toFixed(value < 10_000 ? 1 : 0)}k`;
			return `${(value / 1_000_000).toFixed(1)}M`;
		};
		const pct = (part, whole) => (whole > 0 ? Math.max(0, Math.min(100, (part / whole) * 100)) : 0);
		const clamp = (text, max) => (typeof text === "string" && text.length > max ? `${text.slice(0, max - 1)}…` : text || "");

		/** A proportion bar: the width is the number, and the number is written next to it. */
		function miniBar(fraction, style) {
			return h("div", { className: "ccMini" }, h("div", { className: "ccMiniFill", style: { width: `${Math.max(1, fraction * 100)}%`, ...style } }));
		}

		/** A small status pill. The variant picks the theme token it borrows. */
		function chip(text, variant) {
			return h("span", { className: `ccChip${variant ? ` ccChip${variant}` : ""}` }, text);
		}

		/**
		 * The categorical encoding, in theme tokens.
		 *
		 * There is no categorical palette in the theme, so the distinction is made
		 * out of the four tokens that exist plus opacity and one stripe pattern.
		 * Every one of these reads correctly on both the light and the dark theme
		 * because none of them names a colour.
		 */
		const SEGMENT_STYLE = {
			prefix: { background: "var(--dsw-alias-border-l2)" },
			"tool-result": { background: "var(--dsw-alias-brand-primary)" },
			assistant: { background: "var(--dsw-alias-state-success-primary)" },
			reasoning: { background: "var(--dsw-alias-state-warn-primary)" },
			user: { background: "var(--dsw-alias-label-secondary)" },
			system: { background: "repeating-linear-gradient(45deg,transparent,transparent 3px,var(--dsw-alias-brand-primary) 3px,var(--dsw-alias-brand-primary) 4px)" },
			other: { background: "var(--dsw-alias-border-l1)" },
		};
		const KIND_ORDER = ["tool-result", "reasoning", "output"];

		/**
		 * Every string this package draws, English and Chinese side by side.
		 *
		 * One table rather than two dictionaries, so a translation cannot be added
		 * to one language and forgotten in the other: DICT is projected from this
		 * table, and the key sets are therefore equal by construction.
		 *
		 * Column order is [English, 中文]. {name} is interpolated by the locale
		 * service, so a translation may reorder a sentence without touching the call
		 * site that renders it.
		 */
		const COPY = {
			// The two seats this package takes.
			"view.label": ["Context Control", "上下文管控"],
			"meter.label": ["Context pressure", "上下文压力"],
			// The header meter.
			"meter.empty": ["ctx –", "ctx –"],
			"meter.reading": ["reading context…", "正在读取上下文…"],
			"meter.failed": ["the context panel could not be read", "读不到上下文面板"],
			"meter.tip.tokens": ["{tokens} tokens in the next request", "下一次请求里有 {tokens} tokens"],
			"meter.tip.noWindow": ["the model window is unknown here", "这里读不到模型的窗口大小"],
			"meter.tip.headroom": ["{tokens} tokens of headroom", "还有 {tokens} tokens 余量"],
			"meter.tip.armed": ["rewriting is armed", "改写已武装"],
			"meter.tip.reportOnly": ["report only: nothing is being rewritten", "仅报告：不会改写任何东西"],
			"meter.tip.reportOnlyShort": ["report only", "仅报告"],
			"tip.bucket": ["{label}: {tokens} tokens", "{label}：{tokens} tokens"],
			"tip.prefix": ["Not a surface node: the request's own overhead (tool schemas, framing) plus whatever the per-node prices did not account for. It is total minus the surface, so the system prompt — a row of its own below — is not in it.", "不是一个节点：请求自身的开销（工具 schema、请求框架）加上逐节点计价没算到的部分。它是 total 减 surface 的差，所以系统提示词（图例里单独那一行）不在这里面。"],
			"tip.headroom": ["free headroom: {tokens} tokens", "空闲余量：{tokens} tokens"],
			// The panel frame.
			"panel.title": ["Context Control", "上下文管控"],
			"panel.refresh": ["Refresh", "刷新"],
			"panel.refreshing": ["reading…", "读取中…"],
			"panel.unknownModel": ["unknown model", "未知模型"],
			"panel.window": ["window", "窗口"],
			"panel.reading": ["Reading this session's context…", "正在读取本会话的上下文…"],
			// The composition bar.
			"section.current": ["Current context", "当前上下文"],
			"current.tokens": ["{tokens} tokens", "{tokens} tokens"],
			"current.ofWindow": [" of {window}", " / 共 {window}"],
			"current.baseline": ["baseline {kind}", "基线 {kind}"],
			"current.unmeasured": ["unmeasured", "未测量"],
			"current.surface": ["surface {tokens} tok · since baseline {delta} · {nodes} nodes", "surface {tokens} tok · 相对基线 {delta} · {nodes} 个节点"],
			"bar.hint": ["click a segment or a legend entry to filter the table below", "点击某一段或图例即可筛选下面的表"],
			// The query bar.
			"query.presets": ["Presets", "预设"],
			"query.conditions": ["Conditions", "条件"],
			"query.addCondition": ["Add a condition", "添加条件"],
			"query.clear": ["Clear", "清空"],
			"query.matched": ["{matched} matched", "匹配 {matched} 条"],
			"query.ofTotal": ["of {total}", "共 {total} 条"],
			"query.showing": ["showing {from}–{to}", "显示 {from}–{to}"],
			"query.pagePrev": ["Prev", "上一页"],
			"query.pageNext": ["Next", "下一页"],
			"query.page": ["page {page}/{pages}", "第 {page}/{pages} 页"],
			"query.none": ["Nothing matches this query.", "没有符合条件的条目。"],
			"query.domain": ["Look at", "范围"],
			"query.form": ["Show as", "展现为"],
			"query.sort": ["Sort", "排序"],
			"query.group": ["Group", "分组"],
			"query.desc": ["desc", "降序"],
			"query.asc": ["asc", "升序"],
			"condition.remove": ["Remove this condition", "移除这个条件"],
			// Domains, presentations, operators.
			"domain.nodes": ["Nodes", "节点"],
			"domain.calls": ["Calls", "调用"],
			"form.table": ["Table", "表"],
			"form.ranking": ["Ranking", "排行"],
			"form.summary": ["Summary", "汇总"],
			"group.none": ["none", "不分组"],
			"op.is": ["is", "是"],
			"op.gte": ["≥", "≥"],
			"op.lte": ["≤", "≤"],
			"op.contains": ["contains", "包含"],
			"value.true": ["yes", "是"],
			"value.false": ["no", "否"],
			// Fields a condition can name.
			"field.metric": ["tokens", "tokens"],
			"field.traffic": ["traffic", "流量"],
			"field.kind": ["kind", "类型"],
			"field.toolName": ["tool", "工具"],
			"field.chars": ["chars", "字符"],
			"field.over": ["over budget", "超预算"],
			"field.turn": ["turn", "turn"],
			"field.actionable": ["rewritable", "可改写"],
			"field.resultChars": ["result ch", "结果字符"],
			"field.durationMs": ["duration ms", "耗时毫秒"],
			"field.isError": ["error", "出错"],
			"field.nested": ["nested", "子调用"],
			"field.inContext": ["in context", "在 context 内"],
			// One-click presets.
			"preset.all": ["Everything", "全部"],
			"preset.actionable": ["Rewritable", "可改写"],
			"preset.over": ["Over budget", "超预算"],
			"preset.toolResult": ["Tool results", "工具结果"],
			"preset.reasoningOutput": ["Reasoning & output", "推理与输出"],
			"preset.lastTurn": ["Last turn", "最后一轮"],
			"preset.errors": ["Errors", "出错"],
			"preset.nested": ["Sub-calls", "子调用"],
			"preset.root": ["run_code calls", "run_code 调用"],
			"preset.big": ["Big (≥10k ch)", "大条目（≥10k 字符）"],
			"preset.slow": ["Slow (≥1 s)", "慢（≥1 秒）"],
			// Table columns and status chips.
			"col.seq": ["#", "#"],
			"col.kind": ["kind", "类型"],
			"col.node": ["node", "节点"],
			"col.tokens": ["tok", "tok"],
			"col.chars": ["ch", "字符"],
			"col.tool": ["tool", "工具"],
			"col.args": ["args ch", "参数字符"],
			"col.resultChars": ["result ch", "结果字符"],
			"col.resultTokens": ["result tok", "结果 token"],
			"col.ms": ["ms", "毫秒"],
			"col.status": ["status", "状态"],
			"col.action": ["action", "动作"],
			"chip.over": ["over budget", "超预算"],
			"chip.error": ["error", "错误"],
			"chip.nested": ["nested", "子调用"],
			"chip.root": ["run_code", "run_code"],
			"chip.logOnly": ["log only", "未进 context"],
			"chip.leftCtx": ["left ctx", "已离开上下文"],
			"chip.actionable": ["rewritable", "可改写"],
			"chip.wouldChange": ["would change", "本可改动"],
			"rank.chars": ["{chars} ch", "{chars} 字符"],
			"summary.count": ["{count} rows", "{count} 条"],
			"summary.share": ["{share}%", "{share}%"],
			"row.apply": ["Apply", "应用"],
			"row.applyTitle": ["Run the policy on this node now; the identity policy keeps it unchanged", "立刻对这个节点跑一次策略；identity 策略会原样保留它"],
			// The batch over a selection.
			"batch.title": ["Selection", "选中"],
			"batch.selected": ["{count} rewritable node(s) in this result", "当前结果里有 {count} 个可改写节点"],
			"batch.none": ["Nothing here can be rewritten: only tool results still on the surface qualify.", "当前结果里没有可改写的：只有在 surface 上的工具结果可以改。"],
			"batch.limit": ["at most {limit} per run", "一次最多 {limit} 个"],
			"batch.preview": ["Dry run", "预演"],
			"batch.apply": ["Apply", "应用"],
			"batch.previewing": ["pricing…", "计算中…"],
			"batch.applying": ["applying…", "应用中…"],
			"batch.totals": ["{before} → {after} ch · saves {saved} ch · {changed}/{nodes} rows change", "{before} → {after} 字符 · 省下 {saved} 字符 · {changed}/{nodes} 条会变"],
			"batch.done": ["applied {applied}, refused {refused}", "已应用 {applied} 条，被拒绝 {refused} 条"],
			"batch.rows": ["Rows", "逐条"],
			"batch.hideRows": ["Hide rows", "收起逐条"],
			"batch.notLogged": ["a dry run is not written to the intervention log", "预演不会写进干预日志"],
			"batch.failed": ["the host refused the batch", "宿主拒绝了这批操作"],
			"batch.turnNote": ["a node can only be rewritten while its turn is open", "只有在回合打开时才能改写节点"],
			// The interventions log.
			"int.title": ["Interventions", "干预记录"],
			"int.none": ["none yet", "还没有"],
			"int.recorded": ["{count} recorded", "已记录 {count} 条"],
			"int.chars": ["{before} → {after} ch", "{before} → {after} 字符"],
			"int.wouldChange": ["would change", "本可改动"],
			"int.empty": ["Nothing has crossed a budget yet. On the shipped defaults an over-budget item is measured, priced and left exactly where it was.", "还没有任何东西越过预算。按出厂的默认值，越预算的条目只被测量、计价，然后原封不动地留在原处。"],
			"chip.refused": ["refused", "已拒绝"],
			"chip.applied": ["applied", "已应用"],
			"chip.dryRun": ["dry run", "预演"],
			"int.show": ["Show", "展开"],
			"int.hide": ["Hide", "收起"],
			// The configuration rail.
			"cfg.title": ["Configuration", "配置"],
			"cfg.reportOnly": ["report only", "仅报告"],
			"cfg.rewriting": ["rewriting: {kinds}", "正在改写：{kinds}"],
			"cfg.live": ["live, for this process", "本进程内实时生效"],
			"cfg.enabled": ["Measure and intervene at all", "总开关：测量并干预"],
			"cfg.watch": ["watch", "监视"],
			"cfg.budget": ["budget", "预算"],
			"cfg.chars": ["chars", "字符"],
			"cfg.onOver.report": ["report only", "仅报告"],
			"cfg.onOver.rewrite": ["rewrite", "改写"],
			"cfg.generationOnly": ["generation-time only", "仅在生成时"],
			"cfg.generationTitle": ["Reasoning and output are bound at generation time: a committed assistant message can never be rewritten.", "推理和输出在生成时就已定死：已经落盘的 assistant 消息不可能被改写。"],
			"cfg.pageSize": ["rows per page", "每页条数"],
			"cfg.log": ["log", "日志"],
			"cfg.save": ["Save", "保存"],
			"cfg.discard": ["Discard", "放弃"],
			"cfg.dirty": ["Unsaved changes. Nothing takes effect until Save, and the host refuses a patch it cannot validate.", "有未保存的改动。按下保存之前什么都不生效，宿主会拒绝它无法校验的补丁。"],
			"cfg.prune": ["Prune oversized results now", "立刻裁掉过大的结果"],
			"cfg.pruneTitle": ["Run the framework's own deterministic tool-result pruner over this session's surface", "用框架自带的确定性 toolResult 裁剪器扫一遍本会话的 surface"],
			// What the host asks for and reports back.
			"note.noSession": ["This view is not attached to a session yet.", "这个视图还没有挂到任何会话上。"],
			"note.noSnapshot": ["the host returned no snapshot", "宿主没有返回快照"],
			"note.saved": ["Configuration saved for this process.", "配置已在本进程内保存。"],
			"note.patchRefused": ["the host refused the patch", "宿主拒绝了这次补丁"],
			"note.pruned": ["The official pruner rewrote {results} result(s), removing {chars} characters.", "官方裁剪器改写了 {results} 条结果，去掉了 {chars} 个字符。"],
			"note.pruneRefused": ["the host refused the prune", "宿主拒绝了这次裁剪"],
			"note.intervened": ["Node #{seq} rewritten as #{newSeq}.", "节点 #{seq} 已改写为 #{newSeq}。"],
			"note.kept": ["Node #{seq}: the policy kept everything (identity does nothing by design).", "节点 #{seq}：策略原样保留了全部内容（identity 按设计什么都不做）。"],
			"note.interveneRefused": ["the host refused the intervention", "宿主拒绝了这次干预"],
			// Host-named keys the panel owns the copy for.
			"kind.tool-result": ["Tool results", "工具结果"],
			"kind.assistant": ["Assistant output", "助手输出"],
			"kind.user": ["User message", "用户消息"],
			"kind.system": ["System prompt", "系统提示词"],
			"kind.other": ["Other", "其他"],
			"kind.reasoning": ["Reasoning (CoT)", "推理（CoT）"],
			"kind.output": ["Model output", "模型输出"],
			"bucket.prefix": ["Fixed request overhead", "固定请求开销"],
			"bucket.tool-result": ["Tool results", "工具结果"],
			"bucket.assistant": ["Assistant output", "助手输出"],
			"bucket.reasoning": ["Reasoning (CoT)", "推理（CoT）"],
			"bucket.user": ["User messages", "用户消息"],
			"bucket.system": ["System prompt", "系统提示词"],
			"bucket.other": ["Other", "其他"],
			"baseline.usage": ["usage", "实测"],
			"baseline.estimated": ["estimated", "估算"],
			"baseline.none": ["none", "无"],
		};
		/**
		 * The two shipped dictionaries, projected from COPY so neither language can
		 * drift. English doubles as this build's own fallback when no t seat reaches
		 * a component.
		 */
		const DICT = {
			en: Object.fromEntries(Object.entries(COPY).map(([key, pair]) => [key, pair[0]])),
			zh: Object.fromEntries(Object.entries(COPY).map(([key, pair]) => [key, pair[1]])),
		};
		/** The dictionary namespace this package owns on the locale service. */
		const NS = "context-control";

		/** The {name} substitution the locale service performs, for the fallback path. */
		function interpolate(template, params) {
			if (!params) return template;
			return template.replace(/\{(\w+)\}/g, (match, name) => (name in params ? String(params[name]) : match));
		}

		/**
		 * The translate function a component draws with: the renderer's injected t
		 * seat when there is one, otherwise this build's English — so a component
		 * rendered outside the harness still speaks instead of throwing.
		 */
		function translator(injected) {
			if (typeof injected === "function") return injected;
			return (key, params) => interpolate(DICT.en[key] === undefined ? key : DICT.en[key], params);
		}

		/**
		 * Translate a key the host named but does not own. The host sends a stable
		 * key beside its English label, so an unmapped or untranslated key falls back
		 * to the host's own wording rather than to a raw key.
		 */
		function translated(t, key, fallback) {
			const value = t(key);
			return value === key ? fallback : value;
		}
		const kindLabel = (t, kind) => translated(t, "kind." + kind, kind);
		const bucketLabel = (t, bucket) => translated(t, "bucket." + bucket.key, bucket.label);
		/**
		 * The tooltip one bucket wears.
		 *
		 * The residual gets its own sentence instead of the usual "label: n tokens",
		 * because it is the one entry that is not a node: the useful thing to say
		 * about it is what it is made of.
		 */
		const bucketTip = (t, bucket) =>
			bucket.key === "prefix" ? t("tip.prefix") : t("tip.bucket", { label: bucketLabel(t, bucket), tokens: num(bucket.tokens) });
		const baselineLabel = (t, kind) => translated(t, "baseline." + kind, kind);

		/**
		 * One request against the host half's own routes.
		 *
		 * Same-origin, no remote namespace, no live object. A non-JSON body or a
		 * network failure is reported as a note in the panel rather than thrown at
		 * the render tree, because a panel that crashes takes the view with it.
		 */
		function ask(path, options: any = {}) {
			const query = new URLSearchParams();
			for (const [key, value] of Object.entries(options.query || {})) {
				if (value !== undefined && value !== null && String(value).length > 0) query.set(key, String(value));
			}
			const suffix = query.toString();
			const init: any = { method: options.method || "GET", credentials: "same-origin" };
			if (options.body !== undefined) {
				init.headers = { "content-type": "application/json" };
				init.body = JSON.stringify(options.body);
			}
			return window
				.fetch(`${path}${suffix.length > 0 ? `?${suffix}` : ""}`, init)
				.then((response) => response.json().catch(() => ({ ok: false, error: `HTTP ${response.status}` })))
				.catch((error) => ({ ok: false, error: String((error && error.message) || error) }));
		}
		//#endregion
		//#region query
		/**
		 * The query vocabulary.
		 *
		 * One table — filtered, sorted, grouped and re-projected — instead of four
		 * fixed cards drawing the same rows four different ways. The vocabulary is
		 * DATA so the query bar, the table headers, the ranking and the summary cannot
		 * drift apart: all four read these lists.
		 */
		const FIELDS = {
			node: [
				{ key: "metric", label: "field.metric", type: "number" },
				{ key: "chars", label: "field.chars", type: "number" },
				{ key: "kind", label: "field.kind", type: "string" },
				{ key: "toolName", label: "field.toolName", type: "string" },
				{ key: "turn", label: "field.turn", type: "number" },
				{ key: "over", label: "field.over", type: "boolean" },
				{ key: "actionable", label: "field.actionable", type: "boolean" },
			],
			call: [
				{ key: "traffic", label: "field.traffic", type: "number" },
				{ key: "resultChars", label: "field.resultChars", type: "number" },
				{ key: "argsChars", label: "field.argsChars", type: "number" },
				{ key: "durationMs", label: "field.durationMs", type: "number" },
				// Call rows carry their turn, and GROUP_FIELDS.call groups by it: a
				// groupable key that is not a named field renders as null.label and
				// takes the whole view down with it.
				{ key: "turn", label: "field.turn", type: "number" },
				{ key: "toolName", label: "field.toolName", type: "string" },
				{ key: "isError", label: "field.isError", type: "boolean" },
				{ key: "nested", label: "field.nested", type: "boolean" },
				{ key: "inContext", label: "field.inContext", type: "boolean" },
			],
		};
		/** Which fields a grouping can use: the ones with a handful of distinct values. */
		const GROUP_FIELDS = { node: ["kind", "toolName", "turn"], call: ["toolName", "turn"] };
		/** The one-click presets, per domain. */
		const PRESETS = {
			node: [
				{ id: "all", label: "preset.all" },
				{ id: "actionable", label: "preset.actionable" },
				{ id: "over", label: "preset.over" },
				{ id: "tool-result", label: "preset.toolResult" },
				{ id: "reasoning", label: "preset.reasoningOutput" },
				{ id: "lastTurn", label: "preset.lastTurn" },
			],
			call: [
				{ id: "all", label: "preset.all" },
				{ id: "errors", label: "preset.errors" },
				{ id: "nested", label: "preset.nested" },
				{ id: "root", label: "preset.root" },
				{ id: "big", label: "preset.big" },
				{ id: "slow", label: "preset.slow" },
			],
		};
		/** Big means this many characters of traffic, in the calls domain. */
		const BIG_TRAFFIC = 10_000;
		/** Slow means this many milliseconds, in the calls domain. */
		const SLOW_MS = 1_000;

		const fieldSpec = (domain, key) => (FIELDS[domain] || []).find((field) => field.key === key) || null;

		/**
		 * Turn the selected presets into conditions.
		 *
		 * Presets are not a second filtering mechanism: they compile down to the same
		 * conditions the advanced editor writes, so "Rewritable" and an explicit
		 * `actionable is yes` can never disagree — the chip simply shows both.
		 */
		function presetConditions(domain, ids, rows) {
			const conditions = [];
			const lastTurn = rows.reduce((max, row) => (typeof row.turn === "number" && row.turn > max ? row.turn : max), -1);
			for (const id of Array.isArray(ids) ? ids : []) {
				if (id === "all") continue;
				if (domain === "node") {
					if (id === "actionable") conditions.push({ field: "actionable", op: "is", value: true });
					else if (id === "over") conditions.push({ field: "over", op: "is", value: true });
					else if (id === "tool-result") conditions.push({ field: "kind", op: "is", value: "tool-result" });
					else if (id === "reasoning") conditions.push({ field: "kind", op: "in", value: ["reasoning", "assistant"] });
					else if (id === "lastTurn" && lastTurn >= 0) conditions.push({ field: "turn", op: "is", value: lastTurn });
				} else {
					if (id === "errors") conditions.push({ field: "isError", op: "is", value: true });
					else if (id === "nested") conditions.push({ field: "nested", op: "is", value: true });
					else if (id === "root") conditions.push({ field: "nested", op: "is", value: false });
					else if (id === "big") conditions.push({ field: "traffic", op: "gte", value: BIG_TRAFFIC });
					else if (id === "slow") conditions.push({ field: "durationMs", op: "gte", value: SLOW_MS });
				}
			}
			return conditions;
		}

		/** One condition against one row. An absent value never satisfies a comparison. */
		function matchesCondition(row, condition) {
			const value = row[condition.field];
			if (condition.op === "is") return value === condition.value;
			if (condition.op === "in") return Array.isArray(condition.value) && condition.value.indexOf(value) >= 0;
			if (condition.op === "contains") {
				return typeof value === "string" && value.toLowerCase().indexOf(String(condition.value).toLowerCase()) >= 0;
			}
			if (value === null || value === undefined) return false;
			if (condition.op === "gte") return Number(value) >= Number(condition.value);
			if (condition.op === "lte") return Number(value) <= Number(condition.value);
			return false;
		}

		/** Sort two rows by one field, falling back to the order they arrived in. */
		function compareRows(a, b, sort) {
			const av = a[sort.field];
			const bv = b[sort.field];
			let order;
			if (typeof av === "number" || typeof bv === "number") order = (Number(av) || 0) - (Number(bv) || 0);
			else if (typeof av === "boolean" || typeof bv === "boolean") order = (av === true ? 1 : 0) - (bv === true ? 1 : 0);
			else order = String(av === null || av === undefined ? "" : av).localeCompare(String(bv === null || bv === undefined ? "" : bv));
			if (order === 0) order = (a.order || 0) - (b.order || 0);
			return sort.dir === "asc" ? order : -order;
		}

		/** Group matched rows and total each group, largest first. */
		function groupRows(rows, field, metricKey) {
			const groups = new Map();
			for (const row of rows) {
				const key = row[field] === null || row[field] === undefined ? "–" : String(row[field]);
				let group = groups.get(key);
				if (group === undefined) {
					group = { key, count: 0, metric: 0 };
					groups.set(key, group);
				}
				group.count += 1;
				group.metric += Number(row[metricKey]) || 0;
			}
			return [...groups.values()].sort((a, b) => b.metric - a.metric || a.key.localeCompare(b.key));
		}

		/**
		 * Run one query over one row list.
		 *
		 * Pure, and the only thing the table, the ranking and the summary call:
		 * "three presentations of one result" is only honest if they cannot disagree
		 * about what matched. Paging is clamped here too, so a query that shrinks
		 * under the user cannot leave them on an empty page.
		 */
		function applyQuery(rows, query, pageSize) {
			const conditions = (query.conditions || []).concat(presetConditions(query.domain, query.presets, rows));
			const matched = rows.filter((row) => conditions.every((condition) => matchesCondition(row, condition)));
			const sorted = [...matched].sort((a, b) => compareRows(a, b, query.sort));
			const size = Math.max(1, Number(pageSize) || 12);
			const pages = Math.max(1, Math.ceil(sorted.length / size));
			const page = Math.min(Math.max(0, query.page || 0), pages - 1);
			return {
				all: sorted,
				matched: sorted.length,
				total: rows.length,
				pages,
				page,
				from: sorted.length === 0 ? 0 : page * size + 1,
				to: Math.min(sorted.length, page * size + size),
				shown: sorted.slice(page * size, page * size + size),
				conditions,
				groups: query.group === "none" || !query.group ? null : groupRows(sorted, query.group, query.domain === "node" ? "metric" : "traffic"),
			};
		}

		/**
		 * A presentation that needs a grouping gets one.
		 *
		 * Summary with group none has nothing to total, and drawing "nothing matches
		 * this query" over a non-empty result is a lie the person looking at it
		 * cannot see through. The grouping is therefore armed on the way to the
		 * render rather than written into the query state behind their back, so the
		 * group select shows the very key the summary is totalling by.
		 */
		function withPresentationGroup(query) {
			if (query.form !== "summary" || query.group !== "none") return query;
			const groupable = GROUP_FIELDS[query.domain] || [];
			return groupable.length === 0 ? query : { ...query, group: groupable[0] };
		}

		/** One surface node as a queryable row. */
		function nodeRow(node) {
			return {
				domain: "node",
				id: "n" + node.seq,
				seq: node.seq,
				kind: node.kind,
				label: node.label,
				toolName: node.toolName,
				tokens: node.tokens,
				metric: node.tokens,
				chars: node.chars,
				over: node.over === true,
				turn: node.turn,
				step: node.step,
				// Rewritable means: a tool result, with a call identity, still on the
				// surface. The host re-checks all of it — this is a promise the panel
				// makes, not one it enforces.
				actionable: node.kind === "tool-result" && node.callId !== null && node.callId !== undefined,
				callId: node.callId === undefined ? null : node.callId,
				order: node.seq,
			};
		}

		/**
		 * One tool call as a queryable row.
		 *
		 * Root calls and `run_code` sub-dispatches share this shape, because a person
		 * asking "what ran" does not care which side of the PTC bridge it happened on
		 * — only whether it is in the context, which is what `inContext` says.
		 */
		function callRow(call, index) {
			return {
				domain: "call",
				id: call.callId,
				toolName: call.toolName,
				nested: call.nested === true,
				inContext: call.inContext === true,
				argsChars: call.argsChars || 0,
				resultChars: call.resultChars || 0,
				traffic: (call.argsChars || 0) + (call.resultChars || 0),
				resultTokens: call.resultTokens === undefined ? null : call.resultTokens,
				durationMs: call.durationMs === undefined ? null : call.durationMs,
				isError: call.isError === true,
				over: call.over === true,
				turn: call.turn,
				order: index,
			};
		}
		//#endregion

		//#region pieces

		/**
		 * The context as one stacked bar, and — because the bar IS the query — every
		 * segment and legend entry is a button that filters the table to that kind.
		 */
		function compositionCard(snapshot, t, picked, onPick) {
			const buckets = (snapshot.composition || []).filter((bucket) => bucket.tokens > 0);
			const window = typeof snapshot.contextWindow === "number" && snapshot.contextWindow > 0 ? snapshot.contextWindow : null;
			const measured = typeof snapshot.totals.tokens === "number" ? snapshot.totals.tokens : 0;
			const share = window === null ? measured : window;
			const scale = window === null ? measured : Math.max(window, measured);
			const segments = buckets.map((bucket) =>
				h("button", {
					key: bucket.key,
					type: "button",
					className: "ccSeg" + (picked === bucket.key ? " ccSegOn" : ""),
					style: { width: pct(bucket.tokens, scale) + "%", ...(SEGMENT_STYLE[bucket.key] || SEGMENT_STYLE.other) },
					title: bucketTip(t, bucket),
					// The residual is not a node, so it is not a filter either: picking it
					// would filter the table to a kind that no row can carry.
					disabled: bucket.key === "prefix",
					onClick: () => onPick(bucket.key),
				}),
			);
			const free = window === null ? null : h("div", { className: "ccFree", title: t("tip.headroom", { tokens: num(Math.max(0, window - measured)) }) });
			return h(
				"div",
				{ className: "ccCard" },
				h(
					"h4",
					null,
					t("section.current"),
					h("span", { className: "ccMuted" }, t("current.tokens", { tokens: compact(snapshot.totals.tokens) }) + (window === null ? "" : t("current.ofWindow", { window: compact(window) }))),
					h("span", { className: "ccChip" }, t("current.baseline", { kind: baselineLabel(t, snapshot.totals.baselineKind) })),
					snapshot.measurementError === undefined ? null : chip(t("current.unmeasured"), "Over"),
				),
				h("div", { className: "ccBar" }, free === null ? segments : segments.concat([free])),
				h(
					"div",
					{ className: "ccLegend" },
					buckets.map((bucket) =>
						h(
							"button",
							{
								key: bucket.key,
								type: "button",
								className: "ccLegendItem",
								disabled: bucket.key === "prefix",
								onClick: () => onPick(bucket.key),
								title: bucketTip(t, bucket),
							},
							h("span", { className: "ccSwatch", style: SEGMENT_STYLE[bucket.key] || SEGMENT_STYLE.other }),
							h("span", null, bucketLabel(t, bucket)),
							h("span", { className: "ccMuted ccNum" }, compact(bucket.tokens) + " · " + Math.round(pct(bucket.tokens, share || 1)) + "%"),
						),
					),
				),
				snapshot.measurementError === undefined ? null : h("p", { className: "ccNote ccNoteWarn", style: { marginTop: "10px" } }, snapshot.measurementError),
				h(
					"p",
					{ className: "ccMuted", style: { marginTop: "10px" } },
					t("current.surface", { tokens: compact(snapshot.totals.surfaceTokens), delta: (snapshot.totals.surfaceDeltaTokens >= 0 ? "+" : "") + compact(snapshot.totals.surfaceDeltaTokens), nodes: num(snapshot.totals.nodes) }) + " · " + t("bar.hint"),
				),
			);
		}
		/** How many nodes one batch may carry; the host enforces the same number. */
		const BATCH_LIMIT = 100;

		/** A segmented control: one button per choice, the active one filled. */
		function segmented(options, active, onPick) {
			return h(
				"div",
				{ className: "ccChips" },
				options.map((option) =>
					h(
						"button",
						{
							key: option.value,
							type: "button",
							className: "ccToggle" + (option.value === active ? " ccToggleOn" : ""),
							onClick: () => onPick(option.value),
						},
						option.label,
					),
				),
			);
		}

		/** The label one row wears in the ranking and the summary. */
		function rowLabel(row) {
			return row.domain === "node" ? "#" + row.seq + " " + row.label : row.toolName;
		}

		/** A grouped key, said the way the row it came from would say it. */
		function groupLabel(t, field, key) {
			if (field === "kind") return kindLabel(t, key);
			if (field === "turn") return "#" + key;
			return key;
		}

		/**
		 * The query bar: what to look at, what to keep, and how to draw it.
		 *
		 * Presets and conditions sit side by side on purpose — a preset is one click,
		 * a condition is the same thing written out, and both are shown as what they
		 * are. The conditions are editable in place rather than behind a dialog,
		 * because filtering is the thing this panel is for.
		 */
		function queryCard(t, query, setQuery, result) {
			const fields = FIELDS[query.domain] || [];
			const set = (change) => setQuery({ ...query, page: 0, ...change });
			const presets = query.presets || [];
			const conditions = query.conditions || [];
			const togglePreset = (id) =>
				set({ presets: presets.indexOf(id) >= 0 ? presets.filter((entry) => entry !== id) : presets.concat([id]) });
			const patchCondition = (index, change) =>
				set({ conditions: conditions.map((condition, at) => (at === index ? { ...condition, ...change } : condition)) });
			const removeCondition = (index) => set({ conditions: conditions.filter((unused, at) => at !== index) });
			const addCondition = () => {
				const first = fields[0];
				const value = first.type === "number" ? 0 : first.type === "boolean" ? true : "";
				set({ conditions: conditions.concat([{ field: first.key, op: first.type === "number" ? "gte" : "is", value }]) });
			};
			const ops = ["is", "in", "gte", "lte", "contains"];
			const valueInput = (condition, index) => {
				const spec = fieldSpec(query.domain, condition.field);
				if (spec !== null && spec.type === "boolean") {
					return h(
						"select",
						{ className: "ccSelect", value: condition.value === true ? "true" : "false", onChange: (event) => patchCondition(index, { value: event.target.value === "true" }) },
						h("option", { key: "true", value: "true" }, t("value.true")),
						h("option", { key: "false", value: "false" }, t("value.false")),
					);
				}
				if (spec !== null && spec.type === "number") {
					return h("input", { className: "ccInput", type: "number", value: Array.isArray(condition.value) ? 0 : condition.value, onChange: (event) => patchCondition(index, { value: Number(event.target.value) }) });
				}
				return h("input", { className: "ccInput", type: "text", value: Array.isArray(condition.value) ? condition.value.join(", ") : condition.value, onChange: (event) => patchCondition(index, { value: event.target.value }) });
			};
			return h(
				"div",
				{ className: "ccCard ccQuery" },
				h(
					"div",
					{ className: "ccRow" },
					h("span", { className: "ccMuted" }, t("query.domain")),
					segmented(
						[{ value: "node", label: t("domain.nodes") }, { value: "call", label: t("domain.calls") }],
						query.domain,
						(value) => setQuery({ domain: value, presets: [], conditions: [], sort: { field: value === "node" ? "metric" : "traffic", dir: "desc" }, group: "none", form: query.form, page: 0 }),
					),
					h("span", { className: "ccSpacer" }),
					h("span", { className: "ccMuted" }, t("query.form")),
					segmented(
						[{ value: "table", label: t("form.table") }, { value: "ranking", label: t("form.ranking") }, { value: "summary", label: t("form.summary") }],
						query.form,
						(value) => set({ form: value }),
					),
				),
				h(
					"div",
					{ className: "ccRow" },
					h("span", { className: "ccMuted" }, t("query.presets")),
					(PRESETS[query.domain] || []).map((preset) =>
						h(
							"button",
							{
								key: preset.id,
								type: "button",
								className: "ccToggle" + (presets.indexOf(preset.id) >= 0 ? " ccToggleOn" : ""),
								onClick: () => togglePreset(preset.id),
							},
							t(preset.label),
						),
					),
				),
				h(
					"div",
					{ className: "ccRow" },
					h("span", { className: "ccMuted" }, t("query.conditions")),
					conditions.map((condition, index) =>
						h(
							"span",
							{ key: "c" + index, className: "ccCond" },
							h(
								"select",
								{ className: "ccSelect", value: condition.field, onChange: (event) => patchCondition(index, { field: event.target.value }) },
								fields.map((field) => h("option", { key: field.key, value: field.key }, t(field.label))),
							),
							h(
								"select",
								{ className: "ccSelect", value: condition.op, onChange: (event) => patchCondition(index, { op: event.target.value }) },
								ops.map((op) => h("option", { key: op, value: op }, t("op." + op))),
							),
							valueInput(condition, index),
							h("button", { type: "button", className: "ccBtn ccBtnTiny", title: t("condition.remove"), onClick: () => removeCondition(index) }, "×"),
						),
					),
					h("button", { type: "button", className: "ccBtn ccBtnTiny", onClick: addCondition }, "+ " + t("query.addCondition")),
					conditions.length === 0 && presets.length === 0 ? null : h("button", { type: "button", className: "ccBtn ccBtnTiny", onClick: () => set({ conditions: [], presets: [] }) }, t("query.clear")),
				),
				h(
					"div",
					{ className: "ccRow" },
					h(
						"span",
						{ className: "ccMuted" },
						t("query.matched", { matched: num(result.matched) }) + " " + t("query.ofTotal", { total: num(result.total) }) + (result.matched === 0 ? "" : " · " + t("query.showing", { from: num(result.from), to: num(result.to) })),
					),
					h("span", { className: "ccSpacer" }),
					h("span", { className: "ccMuted" }, t("query.sort")),
					h(
						"select",
						{ className: "ccSelect", value: query.sort.field, onChange: (event) => set({ sort: { field: event.target.value, dir: query.sort.dir } }) },
						fields.map((field) => h("option", { key: field.key, value: field.key }, t(field.label))),
					),
					segmented([{ value: "desc", label: t("query.desc") }, { value: "asc", label: t("query.asc") }], query.sort.dir, (value) => set({ sort: { field: query.sort.field, dir: value } })),
					h("span", { className: "ccMuted" }, t("query.group")),
					h(
						"select",
						{ className: "ccSelect", value: query.group, onChange: (event) => set({ group: event.target.value }) },
						h("option", { key: "none", value: "none" }, t("group.none")),
						(GROUP_FIELDS[query.domain] || []).map((key) => h("option", { key, value: key }, t(fieldSpec(query.domain, key).label))),
					),
					result.pages <= 1
						? null
						: h(
								"span",
								{ className: "ccChips" },
								h("button", { type: "button", className: "ccBtn ccBtnTiny", disabled: result.page <= 0, onClick: () => set({ page: result.page - 1 }) }, t("query.pagePrev")),
								h("span", { className: "ccMuted" }, t("query.page", { page: num(result.page + 1), pages: num(result.pages) })),
								h("button", { type: "button", className: "ccBtn ccBtnTiny", disabled: result.page >= result.pages - 1, onClick: () => set({ page: result.page + 1 }) }, t("query.pageNext")),
							),
					),
			);
		}
		/** One node row of the table. Only a rewritable node offers the action. */
		function nodeTableRow(t, row, busy, onApply) {
			const flags = [];
			if (row.over) flags.push(chip(t("chip.over"), "Over"));
			if (row.actionable) flags.push(chip(t("chip.actionable"), null));
			return h(
				"div",
				{ key: row.id, className: "ccTableRow ccNodeTable" },
				h("span", { className: "ccMono ccCell" }, "#" + row.seq),
				h("span", { className: "ccCell" }, kindLabel(t, row.kind)),
				h("span", { className: "ccCell", title: row.label }, row.label),
				h("span", { className: "ccNum ccCell" }, compact(row.tokens)),
				h("span", { className: "ccNum ccCell ccColChars" }, num(row.chars)),
				h("span", { className: "ccChips ccCell ccColStatus" }, flags),
				h(
					"span",
					null,
					row.actionable
						? h("button", { type: "button", className: "ccBtn ccBtnTiny", disabled: busy, title: t("row.applyTitle"), onClick: () => onApply(row.seq) }, t("row.apply"))
						: null,
				),
			);
		}

		/**
		 * One tool-call row.
		 *
		 * A `run_code` sub-dispatch says "nested" AND "log only", because both are
		 * true and the pair is the whole explanation of why its bytes are not in the
		 * context the bar above draws.
		 */
		function callTableRow(t, row) {
			const flags = [];
			if (row.isError) flags.push(chip(t("chip.error"), "Error"));
			if (row.over) flags.push(chip(t("chip.over"), "Over"));
			if (row.nested) flags.push(chip(t("chip.nested"), null));
			if (!row.inContext) flags.push(chip(t("chip.logOnly"), null));
			return h(
				"div",
				{ key: row.id, className: "ccTableRow ccCallTable" },
				h("span", { className: "ccMono ccCell", title: row.id }, row.toolName),
				h("span", { className: "ccNum ccCell" }, num(row.argsChars)),
				h("span", { className: "ccNum ccCell ccColResult" }, num(row.resultChars)),
				h("span", { className: "ccNum ccCell ccColResultTok" }, row.resultTokens === null ? "–" : compact(row.resultTokens)),
				h("span", { className: "ccNum ccCell ccColMs" }, row.durationMs === null ? "–" : num(row.durationMs)),
				h("span", { className: "ccChips ccCell ccColStatus" }, flags),
			);
		}

		/** The table presentation: the query result, one row each, in a bounded scroll. */
		function rowsTable(t, domain, result, busy, onApply) {
			const isNode = domain === "node";
			const head = isNode
				? [t("col.seq"), t("col.kind"), t("col.node"), t("col.tokens"), t("col.chars"), t("col.status"), t("col.action")]
				: [t("col.tool"), t("col.args"), t("col.resultChars"), t("col.resultTokens"), t("col.ms"), t("col.status")];
			const grid = isNode ? "ccTableRow ccNodeTable" : "ccTableRow ccCallTable";
			const headCell = isNode ? { 4: "ccCell ccColChars", 5: "ccCell ccColStatus" } : { 2: "ccCell ccColResult", 3: "ccCell ccColResultTok", 4: "ccCell ccColMs", 5: "ccCell ccColStatus" };
			return h(
				"div",
				{ className: "ccScroll" },
				h(
					"div",
					{ className: grid + " ccRowHead" },
					head.map((label, index) => h("span", { key: "h" + index, className: headCell[index] || "ccCell" }, label)),
				),
				result.shown.map((row) => (isNode ? nodeTableRow(t, row, busy, onApply) : callTableRow(t, row))),
				result.matched === 0 ? h("p", { className: "ccMuted" }, t("query.none")) : null,
			);
		}

		/** The ranking presentation: the same rows, as one bar each. */
		function rowsRanking(t, domain, result) {
			const metricKey = domain === "node" ? "metric" : "traffic";
			const largest = result.all.reduce((max, row) => Math.max(max, Number(row[metricKey]) || 0), 1);
			return h(
				"div",
				{ className: "ccScroll" },
				result.shown.map((row) =>
					h(
						"div",
						{ key: row.id, className: "ccSummaryRow" },
						h("span", { className: "ccCell", title: rowLabel(row) }, (domain === "node" ? h("span", { className: "ccMono ccMuted" }, "#" + row.seq + " ") : null), rowLabel(row).replace(/^#\d+ /, "")),
						miniBar((Number(row[metricKey]) || 0) / largest, domain === "node" ? SEGMENT_STYLE[row.kind] || SEGMENT_STYLE.other : SEGMENT_STYLE["tool-result"]),
						h("span", { className: "ccNum ccMuted ccCell" }, domain === "node" ? compact(row.metric) : t("rank.chars", { chars: compact(row.traffic) })),
					),
				),
				result.matched === 0 ? h("p", { className: "ccMuted" }, t("query.none")) : null,
			);
		}

		/**
		 * The summary presentation: the same rows, totalled per group.
		 *
		 * The share is of the matched set, not of the window: this is "who is eating
		 * the result I am looking at", and the window has its own card above.
		 */
		function rowsSummary(t, domain, field, result) {
			const metricKey = domain === "node" ? "metric" : "traffic";
			const groups = result.groups || [];
			const total = groups.reduce((sum, group) => sum + group.metric, 0) || 1;
			const largest = groups.reduce((max, group) => Math.max(max, group.metric), 1);
			return h(
				"div",
				{ className: "ccScroll" },
				groups.map((group) =>
					h(
						"div",
						{ key: group.key, className: "ccSummaryRow" },
						h("span", { className: "ccCell", title: groupLabel(t, field, group.key) }, groupLabel(t, field, group.key) + " · " + t("summary.count", { count: num(group.count) })),
						miniBar(group.metric / largest, domain === "node" ? SEGMENT_STYLE[field === "kind" ? group.key : "other"] || SEGMENT_STYLE.other : SEGMENT_STYLE["tool-result"]),
						h("span", { className: "ccNum ccMuted ccCell" }, (domain === "node" ? compact(group.metric) : t("rank.chars", { chars: compact(group.metric) })) + " · " + t("summary.share", { share: Math.round((group.metric / total) * 100) })),
					),
				),
				groups.length === 0 ? h("p", { className: "ccMuted" }, t("query.none")) : null,
			);
		}
		/**
		 * The selection strip: what a whole filtered set would give back.
		 *
		 * This is the projection the panel used to lack — in `report` posture it is
		 * also the entire story, because the dry run runs the same arithmetic a
		 * rewrite would and writes nothing. Both buttons drive the same host route as
		 * the per-row action, so a preview can never disagree with the apply it
		 * precedes.
		 */
		function batchCard(t, batch, targets, busy, actions) {
			const rows = batch.result === null ? [] : batch.result.rows || [];
			const totals = batch.result === null ? null : batch.result.totals;
			return h(
				"div",
				{ className: "ccCard" },
				h(
					"h4",
					null,
					t("batch.title"),
					h("span", { className: "ccMuted" }, targets.length === 0 ? t("batch.none") : t("batch.selected", { count: num(targets.length) })),
					targets.length > BATCH_LIMIT ? h("span", { className: "ccChip ccChipOver" }, t("batch.limit", { limit: num(BATCH_LIMIT) })) : null,
				),
				batch.error === null ? null : h("p", { className: "ccNote ccNoteError" }, t("batch.failed") + ": " + batch.error),
				totals === null
					? null
					: h(
							"p",
							{ className: "ccMuted" },
							t("batch.totals", {
								before: num(totals.charsBefore),
								after: num(totals.charsAfter),
								saved: num(Math.max(0, totals.charsBefore - totals.charsAfter)),
								changed: num(totals.changed),
								nodes: num(totals.nodes),
							}) +
								" · " +
								(batch.kind === "preview"
									? t("batch.notLogged")
									: t("batch.done", { applied: num(totals.changed), refused: num(totals.refused) })),
						),
				h(
					"div",
					{ className: "ccRow" },
					h(
						"button",
						{ type: "button", className: "ccBtn", disabled: busy || targets.length === 0, onClick: actions.preview },
						batch.phase === "previewing" ? t("batch.previewing") : t("batch.preview"),
					),
					h(
						"button",
						{ type: "button", className: "ccBtn ccBtnPrimary", disabled: busy || targets.length === 0, onClick: actions.apply },
						batch.phase === "applying" ? t("batch.applying") : t("batch.apply"),
					),
					rows.length === 0 ? null : h("button", { type: "button", className: "ccBtn ccBtnTiny", onClick: actions.toggleRows }, batch.showRows ? t("batch.hideRows") : t("batch.rows")),
					h("span", { className: "ccMuted" }, t("batch.turnNote")),
				),
				batch.showRows ? rows.map((row, index) => batchRow(t, row, targets[index], index)) : null,
			);
		}

		/** One row of a batch outcome: kept whether it changed, refused or did nothing. */
		function batchRow(t, row, seq, index) {
			const intervention = row.intervention === undefined ? null : row.intervention;
			const before = intervention === null ? 0 : intervention.charsBefore;
			const after = intervention === null ? before : intervention.charsAfter;
			const mark =
				row.ok === false
					? chip(t("chip.refused"), "Error")
					: row.changed === true
						? intervention !== null && intervention.applied === true
							? chip(t("chip.applied"), "Ok")
							: chip(t("chip.dryRun"), "Over")
						: null;
			return h(
				"div",
				{ key: "batch-row-" + index + "-" + seq, className: "ccLogRow" },
				h("span", { className: "ccMono ccMuted" }, "#" + seq),
				intervention === null ? null : h("span", { className: "ccMono ccMuted" }, intervention.policy),
				h("span", { className: "ccNum" }, num(before) + " → " + num(after)),
				mark,
				row.error === undefined ? null : h("span", { className: "ccMuted ccCell" }, row.error),
			);
		}

		/**
		 * The intervention log, closed by default.
		 *
		 * It is a record, not a thing to read first: the count stays in the header so
		 * "something happened" is never hidden, and the rows are one click away.
		 */
		function interventionsCard(t, snapshot, open, toggle) {
			const entries = snapshot.interventions || [];
			return h(
				"div",
				{ className: "ccCard" },
				h(
					"h4",
					null,
					t("int.title"),
					h("span", { className: "ccMuted" }, entries.length === 0 ? t("int.none") : t("int.recorded", { count: num(entries.length) })),
					h("span", { className: "ccSpacer" }),
					h("button", { type: "button", className: "ccBtn ccBtnTiny", onClick: toggle }, open ? t("int.hide") : t("int.show")),
				),
				open ? null : h("p", { className: "ccMuted" }, t("int.empty")),
				open
					? entries.slice(0, 60).map((entry, index) =>
							h(
								"div",
								{ key: index + "-" + entry.time, className: "ccLogRow" },
								h("span", { className: "ccChip" }, kindLabel(t, entry.kind)),
								h("span", { className: "ccMono ccMuted" }, entry.policy),
								entry.toolName === null ? null : h("span", { className: "ccMono ccMuted" }, entry.toolName),
								h("span", { className: "ccNum" }, t("int.chars", { before: num(entry.charsBefore), after: num(entry.charsAfter) })),
								entry.error !== undefined ? chip(t("chip.refused"), "Error") : entry.applied ? chip(t("chip.applied"), "Ok") : chip(t("chip.dryRun"), "Over"),
								entry.applied === false && entry.changed ? h("span", { className: "ccMuted" }, t("int.wouldChange")) : null,
								entry.error === undefined ? null : h("span", { className: "ccMuted ccCell" }, entry.error),
							),
						)
					: null,
			);
		}

		/**
		 * The configuration, in the rail.
		 *
		 * It used to sit below two hundred rows of stack, which is where a control
		 * goes to be forgotten. What is editable is editable in place; Save and
		 * Discard stay together, and the pruner — the one action that writes to the
		 * session without asking twice — keeps its own row at the bottom.
		 */
		function configCard(snapshot, draft, setDraft, state, actions, t) {
			const config = draft || snapshot.config;
			const patch = (change) => setDraft({ ...config, ...change });
			const patchKind = (kind, change) => patch({ kinds: { ...config.kinds, [kind]: { ...config.kinds[kind], ...change } } });
			const patchPolicy = (kind, name) => patch({ policies: { ...config.policies, [kind]: name } });
			const armed = state.armed;
			return h(
				"div",
				{ className: "ccCard" },
				h(
					"h4",
					null,
					t("cfg.title"),
					h("span", { className: armed.length === 0 ? "ccChip" : "ccChip ccChipOver" }, armed.length === 0 ? t("cfg.reportOnly") : t("cfg.rewriting", { kinds: armed.map((kind) => kindLabel(t, kind)).join(", ") })),
					h("span", { className: "ccMuted" }, t("cfg.live")),
				),
				h(
					"label",
					{ className: "ccRow", style: { marginBottom: "8px" } },
					h("input", { type: "checkbox", checked: config.enabled, onChange: (event) => patch({ enabled: event.target.checked }) }),
					t("cfg.enabled"),
				),
				KIND_ORDER.map((kind) => {
					const kindConfig = config.kinds[kind];
					return h(
						"div",
						{ key: kind, className: "ccKind" },
						h("span", { className: "ccKindName" }, kindLabel(t, kind)),
						h(
							"div",
							{ className: "ccRow" },
							h(
								"label",
								{ className: "ccRow" },
								h("input", { type: "checkbox", checked: kindConfig.enabled, onChange: (event) => patchKind(kind, { enabled: event.target.checked }) }),
								t("cfg.watch"),
							),
							h("span", { className: "ccMuted" }, t("cfg.budget")),
							h("input", { className: "ccInput", type: "number", min: 0, value: kindConfig.maxChars, onChange: (event) => patchKind(kind, { maxChars: Number(event.target.value) }) }),
							h("span", { className: "ccMuted" }, t("cfg.chars")),
							h(
								"select",
								{ className: "ccSelect", value: kindConfig.onOver, onChange: (event) => patchKind(kind, { onOver: event.target.value }) },
								h("option", { value: "report" }, t("cfg.onOver.report")),
								h("option", { value: "rewrite" }, t("cfg.onOver.rewrite")),
							),
							h(
								"select",
								{ className: "ccSelect", value: config.policies[kind], onChange: (event) => patchPolicy(kind, event.target.value) },
								(snapshot.policyOptions || ["identity"]).map((name) => h("option", { key: name, value: name }, name)),
							),
							kind === "reasoning" || kind === "output"
								? h("span", { className: "ccMuted", title: t("cfg.generationTitle") }, t("cfg.generationOnly"))
								: null,
							),
						);
				}),
				h(
					"div",
					{ className: "ccRow", style: { marginTop: "10px" } },
					h("span", { className: "ccMuted" }, t("cfg.pageSize")),
					h("input", { className: "ccInput", type: "number", min: 3, max: 50, value: config.topN, onChange: (event) => patch({ topN: Number(event.target.value) }) }),
					h("span", { className: "ccMuted" }, t("cfg.log")),
					h("input", { className: "ccInput", type: "number", min: 10, max: 2000, value: config.logLimit, onChange: (event) => patch({ logLimit: Number(event.target.value) }) }),
				),
				h(
					"div",
					{ className: "ccRow", style: { marginTop: "10px" } },
					h(
						"button",
						{ type: "button", className: "ccBtn ccBtnPrimary", disabled: state.busy || draft === null, onClick: actions.save },
						t("cfg.save"),
					),
					draft === null ? null : h("button", { type: "button", className: "ccBtn", disabled: state.busy, onClick: () => setDraft(null) }, t("cfg.discard")),
				),
				h(
					"div",
					{ className: "ccRow", style: { marginTop: "10px" } },
					h(
						"button",
						{ type: "button", className: "ccBtn ccBtnTiny", disabled: state.busy, title: t("cfg.pruneTitle"), onClick: actions.pruneOfficial },
						t("cfg.prune"),
					),
				),
				draft === null ? null : h("p", { className: "ccNote ccNoteWarn", style: { marginTop: "8px" } }, t("cfg.dirty")),
			);
		}
		//#endregion
		//#region views

		/** The query a fresh panel opens with: everything, biggest first. */
		function defaultQuery() {
			return {
				domain: "node",
				presets: [],
				conditions: [],
				sort: { field: "metric", dir: "desc" },
				group: "none",
				form: "table",
				page: 0,
			};
		}

		/**
		 * The panel: one session's context, one query over it, and the switches that
		 * decide what may be done to it.
		 *
		 * Two things about the shape. The bar and the query come first because they
		 * are the question, the batch strip follows because it is the answer, and the
		 * configuration rides in a rail so it is never scrolled away. And the table is
		 * ONE table: the stack, the largest entries and the tool traffic used to be
		 * three cards drawing the same rows, and a filter over three near-copies is
		 * three filters.
		 */
		function ContextControlView(props) {
			const t = translator(props.t);
			const sessionId = props.sessionId;
			const [load, setLoad] = react.useState({ snapshot: null, error: null, busy: false });
			const [draft, setDraft] = react.useState(null);
			const [notice, setNotice] = react.useState(null);
			const [query, setQuery] = react.useState(null);
			const [batch, setBatch] = react.useState({ phase: "idle", kind: "preview", result: null, error: null, showRows: false });
			const [logOpen, setLogOpen] = react.useState(false);

			const refresh = () => {
				if (sessionId === undefined || sessionId === null) {
					setLoad({ snapshot: null, error: t("note.noSession"), busy: false });
					return Promise.resolve();
				}
				return ask("/context/state", { query: { sessionId } }).then((response) => {
					if (response && response.ok === true) setLoad({ snapshot: response.snapshot, error: null, busy: false });
					else setLoad({ snapshot: null, error: (response && response.error) || t("note.noSnapshot"), busy: false });
				});
			};

			// One poll while the view is on screen, and one on mount. The view is only
			// mounted while it is selected, so this costs nothing while Chat is open.
			react.useEffect(() => {
				let alive = true;
				const tick = () => {
					if (alive) refresh();
				};
				tick();
				const handle = window.setInterval(tick, 6000);
				return () => {
					alive = false;
					window.clearInterval(handle);
				};
			}, [sessionId]);

			const snapshot = load.snapshot;
			const busy = load.busy;
			const activeQuery = withPresentationGroup(query === null ? defaultQuery() : query);
			const nodeRows = snapshot === null ? [] : (snapshot.stack || []).map(nodeRow);
			const callRows = snapshot === null ? [] : (snapshot.calls || []).map(callRow);
			const rows = activeQuery.domain === "node" ? nodeRows : callRows;
			const pageSize = snapshot === null ? 12 : snapshot.config.topN;
			const result = applyQuery(rows, activeQuery, pageSize);
			// The batch acts on what the query matched, not on a separate selection:
			// "these twelve" IS the result the person is looking at.
			const targets = activeQuery.domain === "node" ? result.all.filter((row) => row.actionable).map((row) => row.seq) : [];
			const kindCondition = (activeQuery.conditions || []).find((condition) => condition.field === "kind" && condition.op === "is");
			const picked = kindCondition === undefined ? null : kindCondition.value;
			// Which kinds are armed to rewrite, as the host would report it.
			const armedKinds = snapshot === null
				? []
				: KIND_ORDER.filter((kind) => {
						const kindConfig = snapshot.config.kinds[kind];
						return snapshot.config.enabled && kindConfig.enabled && kindConfig.onOver === "rewrite";
					});

			const runBatch = (action) => {
				const seqs = targets.slice(0, BATCH_LIMIT);
				setBatch((previous) => ({ ...previous, phase: action === "preview" ? "previewing" : "applying", error: null }));
				ask("/context/action", { method: "POST", body: { sessionId, action, seqs } }).then((response) => {
					const ok = response && response.ok === true;
					setBatch({
						phase: "idle",
						kind: action === "preview" ? "preview" : "apply",
						result: ok ? response.batch : null,
						error: ok ? null : (response && response.error) || t("batch.failed"),
						showRows: ok,
					});
					if (action !== "preview") refresh();
				});
			};

			const actions = {
				save: () => {
					if (draft === null) return;
					setLoad({ ...load, busy: true });
					ask("/context/config", { method: "POST", body: draft }).then((response) => {
						if (response && response.ok === true) {
							setDraft(null);
							setNotice({ kind: "ok", text: t("note.saved") });
						} else {
							setNotice({ kind: "error", text: (response && response.error) || t("note.patchRefused") });
						}
						setLoad((previous) => ({ ...previous, busy: false }));
						refresh();
					});
				},
				pruneOfficial: () => {
					setLoad((previous) => ({ ...previous, busy: true }));
					ask("/context/action", { method: "POST", body: { sessionId, action: "prune-official" } }).then((response) => {
						setNotice(
							response && response.ok === true
								? { kind: "ok", text: t("note.pruned", { results: num(response.pruned), chars: num(response.charsRemoved) }) }
								: { kind: "error", text: (response && response.error) || t("note.pruneRefused") },
						);
						setLoad((previous) => ({ ...previous, busy: false }));
						refresh();
					});
				},
				intervene: (seq) => {
					setLoad((previous) => ({ ...previous, busy: true }));
					ask("/context/action", { method: "POST", body: { sessionId, action: "intervene", seq } }).then((response) => {
						const outcome = response && response.outcome;
						if (response && response.ok === true) {
							setNotice({
								kind: "ok",
								text: outcome && outcome.changed ? t("note.intervened", { seq, newSeq: outcome.seq }) : t("note.kept", { seq }),
							});
						} else {
							setNotice({ kind: "error", text: (response && response.error) || (outcome && outcome.error) || t("note.interveneRefused") });
						}
						setLoad((previous) => ({ ...previous, busy: false }));
						refresh();
					});
				},
				// The bar IS a filter: a segment click writes the same kind condition the
				// advanced editor would.
				pickKind: (key) =>
					setQuery({
						domain: "node",
						presets: [],
						conditions: [{ field: "kind", op: "is", value: key }],
						sort: { field: "metric", dir: "desc" },
						group: "none",
						form: activeQuery.form,
						page: 0,
					}),
				preview: () => runBatch("preview"),
				apply: () => runBatch("intervene-batch"),
				toggleRows: () => setBatch((previous) => ({ ...previous, showRows: !previous.showRows })),
			};

			// The one place the query result is drawn. All three presentations read the
			// same result, so they cannot disagree about what matched.
			const presentation =
				activeQuery.form === "ranking"
					? rowsRanking(t, activeQuery.domain, result)
					: activeQuery.form === "summary"
						? rowsSummary(t, activeQuery.domain, activeQuery.group, result)
						: rowsTable(t, activeQuery.domain, result, busy, actions.intervene);

			return h(
				"div",
				{ className: "ccPane" },
				h(
					"div",
					{ className: "ccRow" },
					h("strong", null, t("panel.title")),
					snapshot === null
						? null
						: h("span", { className: "ccMuted" }, (snapshot.model || t("panel.unknownModel")) + (snapshot.contextWindow === null ? "" : " · " + compact(snapshot.contextWindow) + " " + t("panel.window"))),
					h("span", { className: "ccSpacer" }),
					h(
						"button",
						{
							type: "button",
							className: "ccBtn",
							disabled: busy,
							onClick: () => {
								setLoad((previous) => ({ ...previous, busy: true }));
								refresh().then(() => setLoad((previous) => ({ ...previous, busy: false })));
							},
						},
						busy ? t("panel.refreshing") : t("panel.refresh"),
					),
				),
				load.error === null || load.error === undefined ? null : h("p", { className: "ccNote ccNoteError" }, load.error),
				notice === null ? null : h("p", { className: "ccNote" + (notice.kind === "error" ? " ccNoteError" : "") }, notice.text),
				snapshot === null
					? h("p", { className: "ccMuted" }, t("panel.reading"))
					: h(
							"div",
							{ className: "ccShell" },
							h(
								"div",
								{ className: "ccMain" },
								compositionCard(snapshot, t, picked, actions.pickKind),
								queryCard(t, activeQuery, setQuery, result),
								h("div", { className: "ccCard" }, presentation),
								activeQuery.domain === "node" ? batchCard(t, batch, targets, busy, actions) : null,
								interventionsCard(t, snapshot, logOpen, () => setLogOpen(!logOpen)),
							),
							h("div", { className: "ccRail" }, configCard(snapshot, draft, setDraft, { busy, armed: armedKinds }, actions, t)),
						),
			);
		}

		/**
		 * The session-header meter: the pressure figure and the armed posture, without
		 * leaving the conversation.
		 */
		function ContextMeter(props) {
			const t = translator(props.t);
			const sessionId = props.sessionId;
			const [snapshot, setSnapshot] = react.useState(null);
			const [failed, setFailed] = react.useState(false);
			react.useEffect(() => {
				let alive = true;
				const tick = () => {
					if (sessionId === undefined || sessionId === null) return;
					ask("/context/state", { query: { sessionId } }).then((response) => {
						if (!alive) return;
						if (response && response.ok === true) {
							setSnapshot(response.snapshot);
							setFailed(false);
						} else {
							setFailed(true);
						}
					});
				};
				tick();
				const handle = window.setInterval(tick, 10000);
				return () => {
					alive = false;
					window.clearInterval(handle);
				};
			}, [sessionId]);

			if (snapshot === null) {
				return h(
					"button",
					{ type: "button", className: "ccBtn", disabled: true, title: failed ? t("meter.failed") : t("meter.reading") },
					t("meter.empty"),
				);
			}
			const window_ = typeof snapshot.contextWindow === "number" && snapshot.contextWindow > 0 ? snapshot.contextWindow : null;
			const used = snapshot.totals.tokens;
			const over = window_ === null ? false : used > window_ * 0.8;
			const rewriting = snapshot.config.enabled && KIND_ORDER.some((kind) => snapshot.config.kinds[kind].enabled && snapshot.config.kinds[kind].onOver === "rewrite");
			return h(
				"span",
				{
					className: "ccRow",
					style: { gap: "6px" },
					title: [
						t("meter.tip.tokens", { tokens: num(used) }),
						window_ === null ? t("meter.tip.noWindow") : t("meter.tip.headroom", { tokens: num(Math.max(0, window_ - used)) }),
						rewriting ? t("meter.tip.armed") : t("meter.tip.reportOnly"),
						...(snapshot.composition || []).filter((bucket) => bucket.tokens > 0).map((bucket) => t("tip.bucket", { label: bucketLabel(t, bucket), tokens: num(bucket.tokens) })),
					].join("\n"),
				},
				h(
					"button",
					{ type: "button", className: "ccBtn" + (over ? " ccBtnPrimary" : ""), style: { display: "flex", gap: "6px", alignItems: "center" } },
					h("span", { className: "ccNum" }, window_ === null ? compact(used) : compact(used) + " / " + compact(window_)),
					window_ === null ? null : h("span", { className: "ccMini", style: { width: "42px" } }, h("span", { className: "ccMiniFill", style: { width: pct(used, window_) + "%", background: over ? "var(--dsw-alias-state-warn-primary)" : "var(--dsw-alias-brand-primary)" } })),
					h("span", { style: { color: rewriting ? "var(--dsw-alias-state-warn-primary)" : "var(--dsw-alias-label-secondary)" }, title: rewriting ? t("meter.tip.armed") : t("meter.tip.reportOnlyShort") }, rewriting ? "✎" : "◦"),
				),
			);
		}
		//#endregion
		//#region plugin
		/** Required client services: the slot registry for the two seats, the locale registry for the copy. */
		const inject = ["slots", "locale"];

		/**
		 * Take two additive seats: the panel as a Conversation View and the meter in the
		 * session header. Neither replaces anything: each is a fresh `id` beside the
		 * shipped entries.
		 *
		 * The dictionary is registered before either seat, because a seat that declares
		 * a locale namespace is refused by the renderer when no dictionary answers for
		 * it, and a missing key would show the key itself. Each label is a thunk, so a
		 * locale switch re-reads the copy without re-registering the seat.
		 */
		function apply(ctx) {
			ctx.effect(
				() => {
					const disposeEn = ctx.locale.register(NS, "en", DICT.en);
					const disposeZh = ctx.locale.register(NS, "zh", DICT.zh);
					return () => {
						disposeZh();
						disposeEn();
					};
				},
				"dsh-plugin-context: dictionaries",
			);
			// Bound once: the label thunks below read the active locale at call time.
			const t = ctx.locale.bind(NS);
			ctx.slots.inject("conversation.view", () =>
				ctx.slots.register(
					{
						name: "conversation.view",
						id: "context-control",
						order: 25,
						locale: NS,
						label: () => t("view.label"),
					},
					ContextControlView,
				),
			);
			ctx.slots.inject("conversation.session.header.utilities", () =>
				ctx.slots.register(
					{
						name: "conversation.session.header.utilities",
						id: "context-control-meter",
						order: 5,
						locale: NS,
						label: () => t("meter.label"),
					},
					ContextMeter,
				),
			);
		}
		//#endregion
		// Exported for the browser-less harness in test/client.test.mjs: the cards are
		// pure functions of (data, t) and the dictionaries are plain objects, so the
		// copy can be checked without a renderer, a locale runtime or a fetch.
		exports.cards = { compositionCard, queryCard, rowsTable, rowsRanking, rowsSummary, batchCard, interventionsCard, configCard };
		exports.query = { FIELDS, PRESETS, GROUP_FIELDS, applyQuery, withPresentationGroup, presetConditions, matchesCondition, groupRows, nodeRow, callRow, defaultQuery };
		exports.copy = { NS, DICT, COPY };
		exports.translator = translator;
		exports.apply = apply;
		exports.inject = inject;
		exports.ContextControlView = ContextControlView;
		exports.ContextMeter = ContextMeter;
		exports.segmentStyle = SEGMENT_STYLE;
		exports.ask = ask;
		return module.exports;
	},
});
