/**
 * The browser half's contract, checked by executing the built bundle.
 *
 * There is no browser here, so the bundle is run in a `vm` context against a
 * stub of the two globals the harness provides — the module loader and a React
 * that records elements instead of rendering them. That is enough to pin the
 * properties that would otherwise only fail in a page:
 *
 *  - the file is a classic script that registers itself exactly once;
 *  - its factory hands back a Cordis plugin whose `apply` takes both seats;
 *  - every string those seats draw comes from one bilingual dictionary rather
 *    than from a literal in the render tree;
 *  - every colour it draws is a theme token, so it cannot break in the other
 *    theme;
 *  - and rendering with no data does not throw.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const source = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8');

/** Run the bundle with a loader stub, and hand back what it registered. */
function loadBundle(options = {}) {
	const registrations = [];
	const styles = [];
	const sandbox = {
		window: {
			__ModuleLoader__: { load: (registration) => registrations.push(registration) },
			// The panel polls while it is on screen and fetches its snapshot; a seat
			// must be mountable with neither, so both are stubs here.
			fetch: options.fetch,
			setInterval: () => 0,
			clearInterval: () => undefined,
		},
		document: {
			querySelector: () => null,
			createElement: () => ({ dataset: {}, textContent: '' }),
			head: { appendChild: (element) => styles.push(element) },
		},
		Intl,
		URLSearchParams,
		Symbol,
		Object,
		Array,
		Number,
		String,
		Math,
		JSON,
		console,
	};
	vm.createContext(sandbox);
	vm.runInContext(source, sandbox);
	return { registrations, styles };
}

/** A React that records the tree instead of rendering it. */
function reactStub() {
	return {
		createElement: (...args) => ({ type: args[0], props: args[1] ?? null, children: args.slice(2) }),
		useState: (initial) => [initial, () => undefined],
		useEffect: () => undefined,
	};
}

/**
 * Build the plugin the factory returns, plus a `slots` and a `locale` that record
 * what the plugin asks of them. The locale stub keeps the locale runtime's one
 * contract that matters here: `bind` reads the active locale when it is CALLED,
 * so a dictionary swap needs no re-registration.
 */
function buildPlugin(options = {}) {
	const { registrations, styles } = loadBundle(options);
	assert.equal(registrations.length, 1, 'the bundle registers itself exactly once');
	const registration = registrations[0];
	const exports = registration.factory((spec) => {
		if (spec === 'react') return options.react ?? reactStub();
		throw new Error(`the bundle asked for an undeclared module: ${spec}`);
	});
	const registered = [];
	const injected = [];
	const effects = [];
	/** "ns|locale" -> dictionary, as the real registry stores it. */
	const dictionaries = new Map();
	let active = options.locale ?? 'en';
	const ctx = {
		effect: (callback, label) => {
			effects.push(label);
			const dispose = callback();
			return () => {
				if (typeof dispose === 'function') dispose();
			};
		},
		locale: {
			register: (ns, localeOrDicts, dict) => {
				const pairs = typeof localeOrDicts === 'string' ? [[localeOrDicts, dict]] : Object.entries(localeOrDicts);
				for (const [id, entries] of pairs) dictionaries.set(`${ns}|${id}`, entries);
				return () => {
					for (const [id] of pairs) dictionaries.delete(`${ns}|${id}`);
				};
			},
			bind: (ns) => (key, params) => {
				const template = (dictionaries.get(`${ns}|${active}`) ?? {})[key] ?? key;
				if (!params) return template;
				return template.replace(/\{(\w+)\}/g, (match, name) => (name in params ? String(params[name]) : match));
			},
		},
		slots: {
			inject: (name, callback) => {
				injected.push(name);
				callback();
			},
			register: (options) => {
				registered.push(options);
				return () => undefined;
			},
		},
	};
	return { registration, exports, ctx, registered, injected, effects, dictionaries, setActive: (id) => { active = id; }, styles };
}

test('the bundle is a classic script that names itself as the package', () => {
	assert.match(source, /__ModuleLoader__\.load\(/);
	assert.doesNotMatch(source, /^\s*(import|export)\s/m, 'a classic script may carry no ESM syntax');
	const { registration } = buildPlugin();
	assert.equal(registration.id, 'dsh-plugin-context');
});

test('the factory returns a Cordis plugin that needs the slot and locale registries', () => {
	const { exports } = buildPlugin();
	assert.equal(typeof exports.apply, 'function');
	// The array was built inside the vm realm, so it is copied back before comparing.
	assert.deepEqual(Array.from(exports.inject), ['slots', 'locale']);
});

test('apply takes two additive seats, and replaces nothing', () => {
	const { exports, ctx, registered, injected } = buildPlugin();
	exports.apply(ctx);
	assert.deepEqual(injected, ['conversation.view', 'conversation.session.header.utilities']);
	assert.deepEqual(
		registered.map((options) => `${options.name}#${options.id}`),
		['conversation.view#context-control', 'conversation.session.header.utilities#context-control-meter'],
	);
	// A fresh id beside the shipped entries, never in one of their cells.
	for (const options of registered) {
		assert.equal(typeof options.order, 'number');
		assert.equal(typeof options.label, 'function', 'the label is a thunk so a locale change needs no re-register');
	}
});

test('every colour it draws is a theme token', () => {
	const { styles } = buildPlugin();
	assert.equal(styles.length, 1);
	const tag = styles[0];
	assert.equal(tag.dataset.plugin, 'dsh-plugin-context', 'HMR removes owned styles by this exact attribute');
	assert.match(tag.textContent, /--dsw-alias-/);
	assert.doesNotMatch(tag.textContent, /#[0-9a-fA-F]{3,8}\b/, 'no hard-coded hex colour');
	assert.doesNotMatch(tag.textContent, /\brgba?\(|\bhsla?\(/, 'no hard-coded colour function');
});

test('both components render with no data instead of throwing', () => {
	const { exports } = buildPlugin();
	const view = exports.ContextControlView({ sessionId: 'session-1' });
	assert.ok(view !== null && view !== undefined);
	const tree = JSON.stringify(view, (key, value) => (typeof value === 'function' ? '[fn]' : value));
	assert.match(tree, /Reading this session's context/, 'the empty state is stated, not blank');

	const meter = exports.ContextMeter({ sessionId: 'session-1' });
	assert.ok(meter !== null && meter !== undefined);
	const meterTree = JSON.stringify(meter, (key, value) => (typeof value === 'function' ? '[fn]' : value));
	assert.match(meterTree, /ctx –/, 'the meter admits it has not read anything yet');
});

test('a session-less seat renders the explained empty state rather than fetching', () => {
	const { exports } = buildPlugin();
	const view = exports.ContextControlView({});
	const tree = JSON.stringify(view, (key, value) => (typeof value === 'function' ? '[fn]' : value));
	assert.ok(tree.length > 0);
});

/** One populated snapshot, so every card can be exercised without a host. */
const SNAPSHOT = {
	model: 'deepseek-flash',
	contextWindow: 128000,
	policyOptions: ['identity', 'head-tail'],
	config: {
		enabled: true,
		kinds: {
			'tool-result': { enabled: true, maxChars: 12000, onOver: 'rewrite' },
			reasoning: { enabled: true, maxChars: 16000, onOver: 'report' },
			output: { enabled: true, maxChars: 16000, onOver: 'report' },
		},
		policies: { 'tool-result': 'head-tail', reasoning: 'identity', output: 'identity' },
		topN: 12,
		logLimit: 200,
	},
	totals: { tokens: 100000, surfaceTokens: 40100, surfaceDeltaTokens: 0, baselineTokens: 100000, baselineKind: 'usage', nodes: 4, calls: 2, subCalls: 1 },
	composition: [
		{ key: 'prefix', label: 'Fixed request overhead', tokens: 59900 },
		{ key: 'tool-result', label: 'Tool results', tokens: 20100 },
		{ key: 'reasoning', label: 'Reasoning (CoT)', tokens: 15000 },
		{ key: 'user', label: 'User messages', tokens: 5000 },
		{ key: 'system', label: 'System prompt', tokens: 1463 },
	],
	stack: [
		{ seq: 1, kind: 'tool-result', label: 'bash', tokens: 20000, chars: 80000, turn: 1, step: 1, toolName: 'bash', callId: 'c1', over: true },
		{ seq: 2, kind: 'reasoning', label: 'thinking about it', tokens: 15000, chars: 60000, turn: 1, step: 2, toolName: null, callId: null, over: true },
		{ seq: 3, kind: 'user', label: 'hi', tokens: 5000, chars: 2, turn: 1, step: 1, toolName: null, callId: null, over: false },
		{ seq: 4, kind: 'tool-result', label: 'memo', tokens: 100, chars: 400, turn: 2, step: 1, toolName: 'memo', callId: 'c2', over: false },
	],
	// Root calls and one `run_code` sub-dispatch: the traffic table is both.
	calls: [
		{ callId: 'c1', toolName: 'run_code', nested: false, parentCallId: null, inContext: true, turn: 1, step: 1, argsChars: 120, resultChars: 80000, resultTokens: 20000, isError: false, durationMs: 900, over: true },
		{ callId: 'c1:ptc:1', toolName: 'bash', nested: true, parentCallId: 'c1', inContext: false, turn: 1, step: 1, argsChars: 30, resultChars: 79000, resultTokens: null, isError: false, durationMs: 40, over: false },
		{ callId: 'c2', toolName: 'run_code', nested: false, parentCallId: null, inContext: true, turn: 2, step: 1, argsChars: 10, resultChars: 400, resultTokens: 100, isError: true, durationMs: 1500, over: false },
	],
	interventions: [{
		time: 1,
		kind: 'tool-result',
		policy: 'head-tail',
		reason: 'manual',
		sessionId: 's',
		callId: 'c1',
		toolName: 'bash',
		turn: 1,
		step: 1,
		charsBefore: 80000,
		charsAfter: 4000,
		blocksBefore: 1,
		blocksAfter: 1,
		changed: true,
		applied: false,
	}],
};

/** A finished batch outcome, as the host answers one. */
const BATCH = {
	phase: 'idle',
	kind: 'preview',
	error: null,
	showRows: true,
	result: {
		totals: { nodes: 2, changed: 1, refused: 1, charsBefore: 80000, charsAfter: 4000 },
		rows: [
			{ ok: true, changed: true, intervention: { ...SNAPSHOT.interventions[0] } },
			{ ok: false, changed: false, error: 'node 9 is not in this session\'s surface' },
		],
	},
};

/**
 * Compare a list the bundle built with one written here.
 *
 * The bundle runs in a `vm`, so its arrays carry that realm's prototype and a
 * strict deep equal would fail on the prototype alone.
 */
function same(actual, expected, message) {
	assert.deepEqual([...actual], expected, message);
}


/** Flatten a render tree to text, dropping functions the way JSON would drop them. */
function flat(node) {
	return JSON.stringify(node, (key, value) => (typeof value === 'function' ? '[fn]' : value));
}


test('the query filters, sorts, groups and pages — over rows, with no host', () => {
	const { exports } = buildPlugin();
	const { query } = exports;
	const rows = SNAPSHOT.stack.map(query.nodeRow);
	const base = query.defaultQuery();

	const all = query.applyQuery(rows, base, 10);
	assert.equal(all.total, 4);
	assert.equal(all.matched, 4);
	same(all.all.map((row) => row.seq), [1, 2, 3, 4], 'biggest first by default');

	// A preset is not a second filtering mechanism: it compiles to conditions.
	const actionable = query.applyQuery(rows, { ...base, presets: ['actionable'] }, 10);
	assert.equal(actionable.conditions.length, 1, 'a preset compiles to exactly one condition');
	assert.equal(actionable.conditions[0].field, 'actionable');
	assert.equal(actionable.conditions[0].op, 'is');
	assert.equal(actionable.conditions[0].value, true);
	same(actionable.all.map((row) => row.seq), [1, 4]);

	const big = query.applyQuery(rows, { ...base, conditions: [{ field: 'chars', op: 'gte', value: 1000 }] }, 10);
	same(big.all.map((row) => row.seq), [1, 2]);

	// "reasoning & output" spans two kinds, which is why `in` exists.
	const reason = query.applyQuery(rows, { ...base, presets: ['reasoning'] }, 10);
	same(reason.all.map((row) => row.seq), [2]);

	const paged = query.applyQuery(rows, { ...base, page: 99 }, 2);
	assert.equal(paged.pages, 2);
	assert.equal(paged.page, 1, 'a page past the end clamps to the last one');
	assert.equal(paged.from, 3);
	assert.equal(paged.to, 4);
	assert.equal(paged.shown.length, 2);

	const grouped = query.applyQuery(rows, { ...base, group: 'kind' }, 10);
	assert.equal(grouped.groups[0].key, 'tool-result');
	assert.equal(grouped.groups[0].metric, 20100, 'a group totals its rows');
	assert.equal(grouped.groups[0].count, 2);

	const sorted = query.applyQuery(rows, { ...base, sort: { field: 'kind', dir: 'asc' } }, 10);
	same(sorted.all.map((row) => row.kind), ['reasoning', 'tool-result', 'tool-result', 'user']);

	const empty = query.applyQuery(rows, { ...base, conditions: [{ field: 'chars', op: 'gte', value: 1e9 }] }, 10);
	assert.equal(empty.matched, 0);
	assert.equal(empty.from, 0);
});

test('the calls domain reads the log, and says which half reached the context', () => {
	const { exports } = buildPlugin();
	const { query } = exports;
	const rows = SNAPSHOT.calls.map(query.callRow);
	const base = { ...query.defaultQuery(), domain: 'call', sort: { field: 'traffic', dir: 'desc' } };

	// Traffic sorts the wrapper first here: 80,120 bytes against the sub-call's 79,030.
	same(query.applyQuery(rows, base, 10).all.map((row) => row.toolName), ['run_code', 'bash', 'run_code']);

	const nested = query.applyQuery(rows, { ...base, presets: ['nested'] }, 10);
	assert.equal(nested.matched, 1);
	assert.equal(nested.all[0].inContext, false, 'a sub-dispatch is traffic the context never saw');
	assert.equal(nested.all[0].resultTokens, null, 'and it is never priced');

	const roots = query.applyQuery(rows, { ...base, presets: ['root'] }, 10);
	assert.equal(roots.matched, 2);
	assert.ok(roots.all.every((row) => row.inContext), 'a root call\'s result is on the surface');

	const errors = query.applyQuery(rows, { ...base, presets: ['errors'] }, 10);
	assert.equal(errors.matched, 1);
	assert.equal(errors.all[0].id, 'c2');

	const slow = query.applyQuery(rows, { ...base, presets: ['slow'] }, 10);
	assert.equal(slow.matched, 1);
	assert.equal(slow.all[0].durationMs, 1500);
});

test('every string the panel draws comes from the dictionary', () => {
	const { exports } = buildPlugin();
	// A `t` seat that answers with a marker: whatever the tree still says in
	// English is a literal that never asked the dictionary.
	const marker = (key) => `⟦${key}⟧`;
	const { cards, copy, query } = exports;
	const base = query.defaultQuery();
	const nodeRows = SNAPSHOT.stack.map(query.nodeRow);
	const callRows = SNAPSHOT.calls.map(query.callRow);
	const nodeResult = query.applyQuery(nodeRows, base, 10);
	const callResult = query.applyQuery(callRows, { ...base, domain: 'call', sort: { field: 'traffic', dir: 'desc' } }, 10);
	const drawn = [
		cards.compositionCard(SNAPSHOT, marker, 'tool-result', () => undefined),
		cards.queryCard(marker, base, () => undefined, nodeResult),
		cards.rowsTable(marker, 'node', nodeResult, false, () => undefined),
		cards.rowsTable(marker, 'call', callResult, false, () => undefined),
		cards.rowsRanking(marker, 'node', nodeResult),
		cards.rowsRanking(marker, 'call', callResult),
		cards.rowsSummary(marker, 'node', 'kind', query.applyQuery(nodeRows, { ...base, group: 'kind' }, 10)),
		cards.batchCard(marker, BATCH, [1, 9], false, { preview: () => undefined, apply: () => undefined, toggleRows: () => undefined }),
		cards.interventionsCard(marker, SNAPSHOT, true, () => undefined),
		cards.configCard(SNAPSHOT, SNAPSHOT.config, () => undefined, { busy: false, armed: ['tool-result'] }, {}, marker),
		exports.ContextMeter({ sessionId: 'session-1', t: marker }),
	].map(flat).join('\n');

	const asked = [...drawn.matchAll(/⟦([^⟧]+)⟧/g)].map((match) => match[1]);
	assert.ok(new Set(asked).size >= 45, `the panel asks the dictionary for its copy (${new Set(asked).size} keys)`);
	const unknown = [...new Set(asked)].filter((key) => copy.DICT.en[key] === undefined);
	assert.deepEqual(unknown, [], 'no call site names a key the dictionary does not have');

	// Markers, class names and the two props that carry machine codes rather than
	// copy (a React key and a form value must NOT be translated) are stripped, so
	// any English left is real copy.
	const bare = drawn
		.replace(/⟦[^⟧]*⟧/g, ' ')
		.replace(/cc[A-Za-z]+/g, ' ')
		.replace(/"key":"[^"]*"/g, ' ')
		.replace(/"value":"[^"]*"/g, ' ');
	// Host data is rendered verbatim — a tool name, a node label, an error the host
	// wrote — so a dictionary value that also occurs in the fixture proves nothing.
	const data = JSON.stringify([SNAPSHOT.stack, SNAPSHOT.calls, SNAPSHOT.composition, SNAPSHOT.config, SNAPSHOT.interventions, BATCH]);
	const leaked = Object.entries(copy.DICT.en)
		.filter(([key, value]) => value.length >= 4 && bare.includes(value) && !data.includes(value))
		.map(([key]) => key);
	assert.deepEqual(leaked, [], 'no literal bypasses the dictionary');
});

test('the batch strip shows a dry run row by row, refusals included', () => {
	const { exports } = buildPlugin();
	const t = exports.translator(undefined);
	const tree = flat(exports.cards.batchCard(t, BATCH, [1, 9], false, {}));
	assert.match(tree, /80,000 → 4,000/, 'the projection leads with what would be given back');
	assert.match(tree, /not in this session\'s surface/, 'a refused node is a row, not a silence');
	assert.match(tree, /dry run/);
	assert.match(tree, /2 rewritable|\\{count\\}/);
});

test('the composition bar offers every segment as a filter, except the one that is not a node', () => {
	const { exports } = buildPlugin();
	const t = exports.translator(undefined);
	const picked = [];
	const tree = exports.cards.compositionCard(SNAPSHOT, t, null, (key) => picked.push(key));
	assert.ok(tree !== null);
	const text = flat(tree);
	assert.match(text, /Fixed request overhead/, 'the residual is named for what it is');
	assert.match(text, /System prompt/, 'and the system prompt is named as itself');
	assert.match(text, /onClick/, 'segments are buttons');

	// "Except the one that is not a node" is the promise of this card: the residual
	// is drawn like the rest, and is the one entry that cannot filter anything.
	const disabled = [];
	walkTree(tree, (element) => {
		if (element.type === 'button' && element.props !== null && element.props.disabled === true) disabled.push(element.props.key);
	});
	assert.deepEqual(disabled, ['prefix', 'prefix'], 'the residual is disabled in the bar and in the legend');
	assert.equal(picked.length, 0, 'and nothing was picked while drawing it');
});

test('the legend does not claim the system prompt twice', () => {
	const { exports } = buildPlugin();
	const { DICT } = exports.copy;
	// A system/message IS the system prompt: the harness's SystemPromptProjection
	// is the only thing that appends one, and compaction calls the node at surface
	// zero exactly that. The legend used to call it "Injected context" while the
	// residual claimed "System prompt & tool schemas" — so a reader saw the system
	// prompt twice, once under a name that hid it.
	assert.equal(DICT.en['kind.system'], 'System prompt');
	assert.equal(DICT.zh['kind.system'], '系统提示词');
	assert.equal(DICT.en['bucket.system'], 'System prompt');
	assert.equal(DICT.zh['bucket.system'], '系统提示词');
	assert.doesNotMatch(DICT.en['bucket.prefix'], /system prompt/i);
	assert.doesNotMatch(DICT.zh['bucket.prefix'], /系统提示/);
	assert.match(DICT.en['tip.prefix'], /total minus the surface/i, 'the residual admits it is a subtraction');
	assert.match(DICT.zh['tip.prefix'], /total 减 surface/);
});

test('a component rendered without the locale seat still speaks English', () => {
	const { exports } = buildPlugin();
	const view = exports.ContextControlView({ sessionId: 'session-1' });
	assert.match(flat(view), /Reading this session\'s context/, 'the build\'s own copy is the fallback');
	const translated = exports.translator((key) => `⟦${key}⟧`);
	assert.equal(translated('view.label'), '⟦view.label⟧', 'an injected seat is used as-is');
	assert.equal(exports.translator(undefined)('meter.tip.headroom', { tokens: '3' }), '3 tokens of headroom', 'placeholders interpolate on the fallback path');
});

/**
 * A React that keeps state, so the panel can be driven past its first frame.
 *
 * The stub above renders one frame of an empty panel and stops — which is exactly
 * the frame in which a table that is never drawn cannot be missed. This one
 * expands function components and remembers useState values, so what the panel
 * does with a matched result is checked rather than assumed.
 */
function drivableReact() {
	const instance = { values: [] };
	let cursor = 0;
	const expand = (node) =>
		node !== null && typeof node === 'object' && typeof node.type === 'function' ? expand(node.type(node.props || {})) : node;
	return {
		api: {
			createElement: (type, props, ...children) => ({ type, props: props ?? null, children }),
			useState: (initial) => {
				const at = cursor++;
				if (instance.values.length <= at) instance.values[at] = typeof initial === 'function' ? initial() : initial;
				return [
					instance.values[at],
					(value) => {
						instance.values[at] = typeof value === 'function' ? value(instance.values[at]) : value;
					},
				];
			},
			useEffect: (callback) => {
				const dispose = callback();
				if (typeof dispose === 'function') dispose();
			},
		},
		render: (component, props) => {
			cursor = 0;
			return expand(component(props));
		},
	};
}

/** One turn of the event loop, so a fetch answer lands before the next render. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 1));

/** Every element in an already-expanded tree. */
function walkTree(node, visit) {
	if (node === null || node === undefined || typeof node !== 'object') return;
	if (Array.isArray(node)) {
		for (const child of node) walkTree(child, visit);
		return;
	}
	visit(node);
	for (const child of node.children || []) walkTree(child, visit);
}

/** Everything a subtree says, in draw order. */
function treeText(node) {
	const out = [];
	const collect = (value) => {
		if (typeof value === 'string') out.push(value);
		else if (Array.isArray(value)) for (const entry of value) collect(entry);
		else if (value !== null && typeof value === 'object' && value.children) collect(value.children);
	};
	walkTree(node, (element) => collect(element.children));
	return out.join(' ');
}

/** The drawn rows of one table, named by the class that says which table it is. */
function drawnRows(node, className) {
	const rows = [];
	walkTree(node, (element) => {
		const own = element.props === null || element.props === undefined ? '' : String(element.props.className || '');
		if (own.includes(className) && !own.includes('ccRowHead')) rows.push(treeText(element));
	});
	return rows;
}

/** Press the button wearing this exact label. */
function clickButton(node, label) {
	let hit = null;
	walkTree(node, (element) => {
		if (element.type !== 'button' || element.props === null || typeof element.props.onClick !== 'function') return;
		if (treeText(element) === label) hit = element;
	});
	assert.ok(hit !== null, 'the panel draws a button labelled ' + label);
	hit.props.onClick();
}

test('the panel draws the rows its query matched, in every domain and presentation', async () => {
	const drivable = drivableReact();
	const answer = () => Promise.resolve({ json: () => Promise.resolve({ ok: true, snapshot: SNAPSHOT }) });
	const { exports } = buildPlugin({ react: drivable.api, fetch: answer });
	const props = { sessionId: 'session-1', t: (key) => key };
	drivable.render(exports.ContextControlView, props);
	await settle();
	const render = () => drivable.render(exports.ContextControlView, props);

	// Nodes, as a table: a header that names the columns, and one row per node.
	let tree = render();
	assert.match(treeText(tree), /col\.seq/, 'the table header is drawn');
	assert.equal(drawnRows(tree, 'ccNodeTable').length, SNAPSHOT.stack.length, 'and a row per matched node with it');
	assert.match(treeText(tree), /row\.apply/, 'a rewritable node offers its action');

	// Switching to the calls domain draws the log instead — and must not throw.
	clickButton(tree, 'domain.calls');
	tree = render();
	assert.match(treeText(tree), /col\.tool/, 'the calls table has its own columns');
	assert.equal(drawnRows(tree, 'ccCallTable').length, SNAPSHOT.calls.length, 'one row per call, sub-dispatches included');
	assert.match(treeText(tree), /chip\.nested/, 'a sub-dispatch says so');

	// Summary totals the matched rows, and arms the grouping it needs to do it.
	clickButton(tree, 'form.summary');
	tree = render();
	const groups = drawnRows(tree, 'ccSummaryRow');
	assert.equal(groups.length, 2, 'one row per tool: the grouping armed itself');
	assert.match(groups[0], /run_code/, 'the biggest group leads');
	assert.match(treeText(tree), /summary\.share/);

	// Ranking reads the same result, so it draws the same rows as bars.
	clickButton(tree, 'form.ranking');
	tree = render();
	assert.equal(drawnRows(tree, 'ccSummaryRow').length, SNAPSHOT.calls.length, 'every matched call, as a bar');

	// And the table comes back, action and all, on the way back to nodes.
	clickButton(tree, 'domain.nodes');
	tree = render();
	clickButton(tree, 'form.table');
	tree = render();
	assert.equal(drawnRows(tree, 'ccNodeTable').length, SNAPSHOT.stack.length);
	assert.match(treeText(tree), /row\.apply/);
});

test('a grouping is drawn only from a field that can be named, and summary arms one', () => {
	const { exports } = buildPlugin();
	const { FIELDS, GROUP_FIELDS, withPresentationGroup, defaultQuery } = exports.query;
	// A groupable key that is not a named field renders the group select as
	// null.label and takes the whole view down with it — the calls domain shipped
	// that way once, and every test called a card directly instead of the view.
	for (const domain of Object.keys(FIELDS)) {
		const named = FIELDS[domain].map((field) => field.key);
		for (const key of GROUP_FIELDS[domain] || []) {
			assert.ok(named.includes(key), domain + ' groups by ' + key + ', so ' + key + ' must be a named field');
		}
	}
	assert.equal(withPresentationGroup({ ...defaultQuery(), form: 'summary' }).group, 'kind', 'summary arms the first groupable field of its domain');
	assert.equal(withPresentationGroup({ ...defaultQuery(), domain: 'call', form: 'summary' }).group, 'toolName');
	assert.equal(withPresentationGroup({ ...defaultQuery(), form: 'table' }).group, 'none', 'a table needs no grouping and is left alone');
	assert.equal(withPresentationGroup({ ...defaultQuery(), form: 'summary', group: 'turn' }).group, 'turn', 'an explicit grouping is never overwritten');
});
