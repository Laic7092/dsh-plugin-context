/**
 * dsh-plugin-context — browser half.
 *
 * Plain JavaScript in the harness's own module format, not a bundler output:
 * `dsh-client-modules` serves this file verbatim, so there is no build tool in
 * this package. React and the `slots` service arrive through `require` and
 * Cordis; every byte of data comes from the host half's own JSON routes over
 * `fetch`, so no live Cordis object ever crosses the wire.
 *
 * It contributes two seats, both additive:
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
			".ccPane{box-sizing:border-box;display:flex;flex-direction:column;gap:14px;width:100%;max-width:1080px;margin:0 auto;padding:20px 4px;font-size:13px;line-height:1.6;color:var(--dsw-alias-label-primary)}",
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
			/* The stack: a proportional bar whose segments are the composition. */
			".ccBar{display:flex;width:100%;height:26px;overflow:hidden;border:1px solid var(--dsw-alias-border-l1);border-radius:8px;background:var(--dsw-alias-bg-layer-2)}",
			".ccSeg{height:100%;min-width:1px}",
			".ccFree{height:100%;flex:1 1 auto;background:repeating-linear-gradient(45deg,transparent,transparent 4px,var(--dsw-alias-border-l1) 4px,var(--dsw-alias-border-l1) 5px)}",
			".ccLegend{display:flex;flex-wrap:wrap;gap:6px 14px;margin-top:10px}",
			".ccLegendItem{display:flex;gap:6px;align-items:center;font-size:12px}",
			".ccSwatch{width:10px;height:10px;flex:none;border:1px solid var(--dsw-alias-border-l1);border-radius:2px}",
			/* The stack in request order: one row per surface node. */
			".ccNode{display:grid;grid-template-columns:minmax(0,1fr) 132px auto;gap:8px;align-items:center;padding:4px 0;border-top:1px solid var(--dsw-alias-border-l1)}",
			".ccNode:first-child{border-top:none}",
			".ccNodeLabel{display:flex;gap:8px;align-items:center;min-width:0}",
			".ccNodeText{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}",
			".ccChip{flex:none;padding:1px 6px;border:1px solid var(--dsw-alias-border-l1);border-radius:999px;font-size:11px;color:var(--dsw-alias-label-secondary)}",
			".ccChipOver{border-color:var(--dsw-alias-state-warn-primary);color:var(--dsw-alias-state-warn-primary)}",
			".ccChipError{border-color:var(--dsw-alias-state-error-primary);color:var(--dsw-alias-state-error-primary)}",
			".ccChipOk{border-color:var(--dsw-alias-state-success-primary);color:var(--dsw-alias-state-success-primary)}",
			".ccMini{height:8px;overflow:hidden;background:var(--dsw-alias-bg-layer-2);border-radius:4px}",
			".ccMiniFill{height:100%}",
			/* The tool-call table. */
			".ccGrid{display:grid;grid-template-columns:minmax(0,1.4fr) repeat(4,minmax(0,.7fr)) auto;gap:6px 10px;align-items:center}",
			".ccGridHead{font-size:11px;color:var(--dsw-alias-label-secondary)}",
			".ccMono{font-family:var(--dsw-font-mono);font-size:12px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}",
			".ccScroll{max-height:280px;overflow:auto}",
			/* The configuration form. */
			".ccKind{display:grid;grid-template-columns:76px minmax(0,1fr);gap:8px 12px;align-items:center;padding:8px 0;border-top:1px solid var(--dsw-alias-border-l1)}",
			".ccKind:first-child{border-top:none}",
			".ccKindName{font-weight:600}",
			"@media (max-width:640px){.ccNode{grid-template-columns:minmax(0,1fr)}.ccGrid{grid-template-columns:minmax(0,1fr) minmax(0,.6fr)}}",
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
		const NODE_LABEL = {
			"tool-result": "tool result",
			assistant: "assistant",
			reasoning: "reasoning",
			user: "user",
			system: "injected",
			other: "other",
		};
		const KIND_ORDER = ["tool-result", "reasoning", "output"];
		const KIND_LABEL = { "tool-result": "Tool results", reasoning: "Reasoning (CoT)", output: "Model output" };

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
		//#region pieces

		/** A proportion bar: the width is the number, and the number is written next to it. */
		function miniBar(fraction, style) {
			return h("div", { className: "ccMini" }, h("div", { className: "ccMiniFill", style: { width: `${Math.max(1, fraction * 100)}%`, ...style } }));
		}

		function chip(text, variant) {
			return h("span", { className: `ccChip${variant ? ` ccChip${variant}` : ""}` }, text);
		}

		/**
		 * The context as one stacked bar: the baseline first, then every surface
		 * node's bucket, then the window's free headroom.
		 */
		function compositionBar(snapshot) {
			const buckets = (snapshot.composition || []).filter((bucket) => bucket.tokens > 0);
			const window = typeof snapshot.contextWindow === "number" && snapshot.contextWindow > 0 ? snapshot.contextWindow : null;
			const measured = typeof snapshot.totals.tokens === "number" ? snapshot.totals.tokens : 0;
			const scale = window === null ? measured : Math.max(window, measured);
			const segments = buckets.map((bucket) =>
				h("div", {
					key: bucket.key,
					className: "ccSeg",
					style: { width: `${pct(bucket.tokens, scale)}%`, ...(SEGMENT_STYLE[bucket.key] || SEGMENT_STYLE.other) },
					title: `${bucket.label}: ${num(bucket.tokens)} tokens`,
				}),
			);
			const free = window === null ? null : h("div", { className: "ccFree", title: `free headroom: ${num(Math.max(0, window - measured))} tokens` });
			return h(
				"div",
				null,
				h("div", { className: "ccBar" }, free === null ? segments : [...segments, free]),
				h(
					"div",
					{ className: "ccLegend" },
					buckets.map((bucket) =>
						h(
							"div",
							{ key: bucket.key, className: "ccLegendItem" },
							h("span", { className: "ccSwatch", style: SEGMENT_STYLE[bucket.key] || SEGMENT_STYLE.other }),
							h("span", null, bucket.label),
							h("span", { className: "ccMuted ccNum" }, `${compact(bucket.tokens)} · ${Math.round(pct(bucket.tokens, measured || 1))}%`),
						),
					),
				),
			);
		}

		/** Every surface node in request order — the stack itself. */
		function stackList(snapshot, state, onIntervene) {
			const stack = snapshot.stack || [];
		 const shown = stack.length > 200 ? stack.slice(stack.length - 200) : stack;
			const largest = stack.reduce((max, node) => Math.max(max, node.tokens), 1);
			return h(
				"div",
				{ className: "ccCard" },
				h(
					"h4",
					null,
					"Stack in request order",
					h("span", { className: "ccMuted" }, `${num(stack.length)} nodes · ${compact(snapshot.totals.tokens)} tokens`),
					stack.length > shown.length ? h("span", { className: "ccMuted" }, `showing the last ${num(shown.length)}`) : null,
				),
				h(
					"div",
					{ className: "ccScroll" },
					shown.map((node) =>
						h(
							"div",
							{ key: node.seq, className: "ccNode" },
							h(
								"div",
								{ className: "ccNodeLabel" },
								h("span", { className: "ccSwatch", style: SEGMENT_STYLE[node.kind] || SEGMENT_STYLE.other }),
								h("span", { className: "ccMono ccChip" }, `#${node.seq}`),
								h("span", { className: "ccNodeText", title: node.label }, node.label),
								node.over ? chip("over budget", "Over") : null,
							),
							miniBar(pct(node.tokens, largest) / 100, SEGMENT_STYLE[node.kind] || SEGMENT_STYLE.other),
							h(
								"div",
								{ className: "ccRow" },
								h("span", { className: "ccMuted ccNum" }, `${compact(node.tokens)} tok · ${num(node.chars)} ch`),
								node.kind === "tool-result"
									? h(
											"button",
											{
												type: "button",
												className: "ccBtn ccBtnTiny",
												disabled: state.busy,
												title: "Run the policy on this node now; the identity policy keeps it unchanged",
												onClick: () => onIntervene(node.seq),
											},
											"Apply policy",
										)
									: null,
							),
						),
					),
					stack.length === 0 ? h("p", { className: "ccMuted" }, "Nothing is in the context yet.") : null,
				),
			);
		}

		/** The largest entries, ranked — the bar chart the question actually asks for. */
		function rankingCard(snapshot) {
			const nodes = snapshot.top?.nodes || [];
			const calls = snapshot.top?.calls || [];
			const largestNode = nodes.reduce((max, node) => Math.max(max, node.tokens), 1);
			const largestCall = calls.reduce((max, call) => Math.max(max, call.resultChars + call.argsChars), 1);
			return h(
				"div",
				{ className: "ccCard" },
				h("h4", null, "Largest entries"),
				h(
					"div",
					{ className: "ccRow", style: { alignItems: "flex-start", gap: "18px" } },
					h(
						"div",
						{ style: { flex: "1 1 300px", minWidth: "260px" } },
						h("div", { className: "ccMuted", style: { marginBottom: "6px" } }, "By tokens"),
						nodes.map((node) =>
							h(
								"div",
								{ key: `n${node.seq}`, style: { marginBottom: "6px" } },
								h(
									"div",
									{ className: "ccRow" },
									h("span", { className: "ccMono ccChip" }, `#${node.seq}`),
									h("span", { className: "ccNodeText", style: { flex: "1 1 auto" }, title: node.label }, node.label),
									h("span", { className: "ccMuted ccNum" }, compact(node.tokens)),
								),
								miniBar(pct(node.tokens, largestNode) / 100, SEGMENT_STYLE[node.kind] || SEGMENT_STYLE.other),
							),
						),
						nodes.length === 0 ? h("p", { className: "ccMuted" }, "No measured nodes yet.") : null,
					),
					h(
						"div",
						{ style: { flex: "1 1 300px", minWidth: "260px" } },
						h("div", { className: "ccMuted", style: { marginBottom: "6px" } }, "By tool traffic (arguments + result)"),
						calls.map((call) =>
							h(
								"div",
								{ key: `c${call.callId}`, style: { marginBottom: "6px" } },
								h(
									"div",
									{ className: "ccRow" },
									h("span", { className: "ccNodeText", style: { flex: "1 1 auto" }, title: call.toolName }, call.toolName),
									call.isError ? chip("error", "Error") : null,
									call.over ? chip("over", "Over") : null,
									h("span", { className: "ccMuted ccNum" }, `${compact(call.resultChars + call.argsChars)} ch`),
								),
								miniBar(pct(call.resultChars + call.argsChars, largestCall) / 100, SEGMENT_STYLE["tool-result"]),
							),
						),
						calls.length === 0 ? h("p", { className: "ccMuted" }, "No tool calls in the recent log.") : null,
					),
				),
			);
		}

		/** One row per tool call: what went in, what came back, and how long it took. */
		function callsCard(snapshot) {
			const calls = snapshot.calls || [];
			const shown = [...calls].reverse().slice(0, 120);
			return h(
				"div",
				{ className: "ccCard" },
				h("h4", null, "toolCall → toolResult", h("span", { className: "ccMuted" }, `${num(calls.length)} calls`)),
				h(
					"div",
					{ className: "ccScroll" },
					h(
						"div",
						{ className: "ccGrid ccGridHead" },
						h("span", null, "tool"),
						h("span", null, "args ch"),
						h("span", null, "result ch"),
						h("span", null, "result tok"),
						h("span", null, "ms"),
						h("span", null, ""),
					),
					shown.map((call) =>
						h(
							"div",
							{ key: call.callId, className: "ccGrid" },
							h("span", { className: "ccMono", title: call.callId }, call.toolName),
							h("span", { className: "ccNum ccMuted" }, num(call.argsChars)),
							h("span", { className: "ccNum" }, num(call.resultChars)),
							h("span", { className: "ccNum ccMuted" }, call.resultTokens === null ? (call.resultChars > 0 ? "left ctx" : "–") : compact(call.resultTokens)),
							h("span", { className: "ccNum ccMuted" }, call.durationMs === null ? "–" : num(call.durationMs)),
							h(
								"span",
								{ className: "ccRow" },
								call.isError ? chip("error", "Error") : null,
								call.over ? chip("over budget", "Over") : null,
							),
						),
					),
					calls.length === 0 ? h("p", { className: "ccMuted" }, "No tool calls recorded.") : null,
				),
			);
		}

		/** The interventions log: what ran, what it would have saved, what it saved. */
		function interventionsCard(snapshot) {
			const entries = snapshot.interventions || [];
			return h(
				"div",
				{ className: "ccCard" },
				h(
					"h4",
					null,
					"Interventions",
					h("span", { className: "ccMuted" }, entries.length === 0 ? "none yet" : `${num(entries.length)} recorded`),
				),
				entries.slice(0, 60).map((entry, index) =>
					h(
						"div",
						{ key: `${entry.time}-${index}`, className: "ccNode" },
						h(
							"div",
							{ className: "ccNodeLabel" },
							h("span", { className: "ccChip" }, KIND_LABEL[entry.kind] || entry.kind),
							h("span", { className: "ccNodeText", title: entry.policy }, entry.policy),
							entry.toolName === null ? null : h("span", { className: "ccMono ccMuted" }, entry.toolName),
						),
						h(
							"div",
							{ className: "ccRow" },
							h("span", { className: "ccNum" }, `${num(entry.charsBefore)} → ${num(entry.charsAfter)} ch`),
							h("span", { className: "ccMuted ccNum" }, entry.charsBefore > entry.charsAfter ? `−${num(entry.charsBefore - entry.charsAfter)}` : "±0"),
						),
						h(
							"div",
							{ className: "ccRow" },
							entry.error !== undefined ? chip("refused", "Error") : entry.applied ? chip("applied", "Ok") : chip("dry run", "Over"),
							entry.applied === false && entry.changed ? h("span", { className: "ccMuted" }, "would change") : null,
						),
					),
				),
				entries.length === 0
					? h("p", { className: "ccMuted" }, "Nothing has crossed a budget yet. On the shipped defaults an over-budget item is measured, priced and left exactly where it was.")
					: null,
			);
		}

		/**
		 * The configuration form.
		 *
		 * Every control here maps to one validated field on the host. The policy
		 * picker is populated from the host's own list, so the panel can never
		 * offer a strategy this build does not have.
		 */
		function configCard(snapshot, draft, setDraft, state, actions) {
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
					"Configuration",
					h("span", { className: armed.length === 0 ? "ccChip" : "ccChip ccChipOver" }, armed.length === 0 ? "report only" : `rewriting: ${armed.join(", ")}`),
					h("span", { className: "ccMuted" }, "live, for this process"),
				),
				h(
					"label",
					{ className: "ccRow", style: { marginBottom: "8px" } },
					h("input", { type: "checkbox", checked: config.enabled, onChange: (event) => patch({ enabled: event.target.checked }) }),
					"Measure and intervene at all",
				),
				KIND_ORDER.map((kind) => {
					const kindConfig = config.kinds[kind];
					return h(
						"div",
						{ key: kind, className: "ccKind" },
						h("span", { className: "ccKindName" }, KIND_LABEL[kind]),
						h(
							"div",
							{ className: "ccRow" },
							h(
								"label",
								{ className: "ccRow" },
								h("input", { type: "checkbox", checked: kindConfig.enabled, onChange: (event) => patchKind(kind, { enabled: event.target.checked }) }),
								"watch",
							),
							h("span", { className: "ccMuted" }, "budget"),
							h("input", {
								className: "ccInput",
								type: "number",
								min: 0,
								value: kindConfig.maxChars,
								onChange: (event) => patchKind(kind, { maxChars: Number(event.target.value) }),
							}),
							h("span", { className: "ccMuted" }, "chars"),
							h(
								"select",
								{ className: "ccSelect", value: kindConfig.onOver, onChange: (event) => patchKind(kind, { onOver: event.target.value }) },
								h("option", { value: "report" }, "report only"),
								h("option", { value: "rewrite" }, "rewrite"),
							),
							h(
								"select",
								{ className: "ccSelect", value: config.policies[kind], onChange: (event) => patchPolicy(kind, event.target.value) },
								(snapshot.policyOptions || ["identity"]).map((name) => h("option", { key: name, value: name }, name)),
							),
							kind === "reasoning" || kind === "output"
								? h("span", { className: "ccMuted", title: "Reasoning and output are bound at generation time: a committed assistant message can never be rewritten." }, "generation-time only")
								: null,
						),
					);
				}),
				h(
					"div",
					{ className: "ccRow", style: { marginTop: "10px" } },
					h("span", { className: "ccMuted" }, "rank top"),
					h("input", { className: "ccInput", type: "number", min: 3, max: 50, value: config.topN, onChange: (event) => patch({ topN: Number(event.target.value) }) }),
					h("span", { className: "ccMuted" }, "log"),
					h("input", { className: "ccInput", type: "number", min: 10, max: 2000, value: config.logLimit, onChange: (event) => patch({ logLimit: Number(event.target.value) }) }),
					h("span", { className: "ccSpacer" }),
					h(
						"button",
						{ type: "button", className: "ccBtn ccBtnPrimary", disabled: state.busy || draft === null, onClick: actions.save },
						"Save",
					),
					draft === null
						? null
						: h("button", { type: "button", className: "ccBtn", disabled: state.busy, onClick: () => setDraft(null) }, "Discard"),
					h(
						"button",
						{
							type: "button",
							className: "ccBtn",
							disabled: state.busy,
							title: "Run the framework's own deterministic tool-result pruner over this session's surface",
							onClick: actions.pruneOfficial,
						},
						"Prune oversized results now",
					),
				),
				draft === null ? null : h("p", { className: "ccNote ccNoteWarn", style: { marginTop: "8px" } }, "Unsaved changes. Nothing takes effect until Save, and the host refuses a patch it cannot validate."),
			);
		}
		//#endregion
		//#region views

		/**
		 * The panel: one session's context, its largest entries, its tool traffic,
		 * what has been done to it, and the switches that decide what may be done.
		 */
		function ContextControlView(props) {
			const sessionId = props.sessionId;
			const [load, setLoad] = react.useState({ snapshot: null, error: null, busy: false });
			const [draft, setDraft] = react.useState(null);
			const [notice, setNotice] = react.useState(null);

			const refresh = () => {
				if (sessionId === undefined || sessionId === null) {
					setLoad({ snapshot: null, error: "This view is not attached to a session yet.", busy: false });
					return Promise.resolve();
				}
				return ask("/context/state", { query: { sessionId } }).then((response) => {
					if (response && response.ok === true) setLoad({ snapshot: response.snapshot, error: null, busy: false });
					else setLoad({ snapshot: null, error: (response && response.error) || "the host returned no snapshot", busy: false });
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
			// Which kinds are armed to rewrite, as the host would report it.
			const armedKinds = snapshot === null
				? []
				: KIND_ORDER.filter((kind) => {
						const kindConfig = snapshot.config.kinds[kind];
						return snapshot.config.enabled && kindConfig.enabled && kindConfig.onOver === "rewrite";
					});
			const busy = load.busy;

			const actions = {
				save: () => {
					if (draft === null) return;
					setLoad({ ...load, busy: true });
					ask("/context/config", { method: "POST", body: draft }).then((response) => {
						if (response && response.ok === true) {
							setDraft(null);
							setNotice({ kind: "ok", text: "Configuration saved for this process." });
						} else {
							setNotice({ kind: "error", text: (response && response.error) || "the host refused the patch" });
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
								? { kind: "ok", text: `The official pruner rewrote ${num(response.pruned)} result(s), removing ${num(response.charsRemoved)} characters.` }
								: { kind: "error", text: (response && response.error) || "the host refused the prune" },
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
							setNotice(
								outcome && outcome.changed
									? { kind: "ok", text: `Node #${seq} rewritten as #${outcome.seq}.` }
									: { kind: "ok", text: `Node #${seq}: the policy kept everything (identity does nothing by design).` },
							);
						} else {
							setNotice({ kind: "error", text: (response && response.error) || (outcome && outcome.error) || "the host refused the intervention" });
						}
						setLoad((previous) => ({ ...previous, busy: false }));
						refresh();
					});
				},
			};

			return h(
				"div",
				{ className: "ccPane" },
				h(
					"div",
					{ className: "ccRow" },
					h("strong", null, "上下文管控 · Context Control"),
					snapshot === null ? null : h("span", { className: "ccMuted" }, `${snapshot.model || "unknown model"}${snapshot.contextWindow === null ? "" : ` · ${compact(snapshot.contextWindow)} window`}`),
					h("span", { className: "ccSpacer" }),
					h("button", { type: "button", className: "ccBtn", disabled: busy, onClick: () => { setLoad((previous) => ({ ...previous, busy: true })); refresh().then(() => setLoad((previous) => ({ ...previous, busy: false }))); } }, busy ? "reading…" : "Refresh"),
				),
				load.error === null || load.error === undefined ? null : h("p", { className: "ccNote ccNoteError" }, load.error),
				notice === null ? null : h("p", { className: `ccNote${notice.kind === "error" ? " ccNoteError" : ""}` }, notice.text),
				snapshot === null
					? h("p", { className: "ccMuted" }, "Reading this session's context…")
					: h(
							"div",
							{ className: "ccCard" },
							h(
								"h4",
								null,
								"Current context",
								h("span", { className: "ccMuted" }, `${compact(snapshot.totals.tokens)} tokens${snapshot.contextWindow === null ? "" : ` of ${compact(snapshot.contextWindow)}`}`),
								h("span", { className: "ccChip" }, `baseline ${snapshot.totals.baselineKind}`),
								snapshot.measurementError === undefined ? null : chip("unmeasured", "Over"),
							),
							compositionBar(snapshot),
							snapshot.measurementError === undefined ? null : h("p", { className: "ccNote ccNoteWarn", style: { marginTop: "10px" } }, snapshot.measurementError),
							h(
								"p",
								{ className: "ccMuted", style: { marginTop: "10px" } },
								`surface ${compact(snapshot.totals.surfaceTokens)} tok · since baseline ${snapshot.totals.surfaceDeltaTokens >= 0 ? "+" : ""}${compact(snapshot.totals.surfaceDeltaTokens)} · ${num(snapshot.totals.nodes)} nodes`,
							),
						),
				snapshot === null ? null : stackList(snapshot, { busy }, actions.intervene),
				snapshot === null ? null : rankingCard(snapshot),
				snapshot === null ? null : callsCard(snapshot),
				snapshot === null ? null : interventionsCard(snapshot),
				snapshot === null ? null : configCard(snapshot, draft, setDraft, { busy, armed: armedKinds }, actions),
			);
		}

		/**
		 * The header meter: the pressure figure and the armed posture, without
		 * leaving the conversation.
		 */
		function ContextMeter(props) {
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
				return h("button", { type: "button", className: "ccBtn", disabled: true, title: failed ? "the context panel could not be read" : "reading context…" }, "ctx –");
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
						`${num(used)} tokens in the next request`,
						window_ === null ? "the model window is unknown here" : `${num(Math.max(0, window_ - used))} tokens of headroom`,
						rewriting ? "rewriting is armed" : "report only: nothing is being rewritten",
						...(snapshot.composition || []).filter((bucket) => bucket.tokens > 0).map((bucket) => `${bucket.label}: ${num(bucket.tokens)}`),
					].join("\n"),
				},
				h(
					"button",
					{ type: "button", className: `ccBtn${over ? " ccBtnPrimary" : ""}`, style: { display: "flex", gap: "6px", alignItems: "center" } },
					h("span", { className: "ccNum" }, window_ === null ? compact(used) : `${compact(used)} / ${compact(window_)}`),
					window_ === null ? null : h("span", { className: "ccMini", style: { width: "42px" } }, h("span", { className: "ccMiniFill", style: { width: `${pct(used, window_)}%`, background: over ? "var(--dsw-alias-state-warn-primary)" : "var(--dsw-alias-brand-primary)" } })),
					h("span", { style: { color: rewriting ? "var(--dsw-alias-state-warn-primary)" : "var(--dsw-alias-label-secondary)" }, title: rewriting ? "rewriting is armed" : "report only" }, rewriting ? "✎" : "◦"),
				),
			);
		}
		//#endregion
		//#region plugin
		/** Required client services: the slot registry is how a seat gets added. */
		const inject = ["slots"];

		/**
		 * Take two additive seats: the panel as a Conversation View, and the meter
		 * in the session header. Neither replaces anything — a fresh `id` is added
		 * beside the shipped entries.
		 *
		 * `slots.inject` waits for each slot to be declared rather than
		 * registering against a ledger that has not declared it yet, and both
		 * labels are plain functions because this package has no locale face.
		 */
		function apply(ctx) {
			ctx.slots.inject("conversation.view", () =>
				ctx.slots.register(
					{
						name: "conversation.view",
						id: "context-control",
						order: 25,
						label: () => "Context Control",
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
						label: () => "Context pressure",
					},
					ContextMeter,
				),
			);
		}
		//#endregion
		exports.apply = apply;
		exports.inject = inject;
		exports.ContextControlView = ContextControlView;
		exports.ContextMeter = ContextMeter;
		exports.segmentStyle = SEGMENT_STYLE;
		exports.ask = ask;
		return module.exports;
	},
});
