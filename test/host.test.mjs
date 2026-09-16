/**
 * The host half's wiring contract, exercised through a Cordis-shaped stand-in.
 *
 * `index.ts` is the one file with no other test, and it is where the plugin's
 * two most important promises are actually kept: that a default install puts no
 * listener anywhere on a path that can change a request, and that flipping a
 * kind to `rewrite` adds exactly those listeners and removing the flip takes
 * them away again. Both are checked here by driving the real `apply`.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { apply, name } from '../lib/index.js';

const big = (chars) => [{ type: 'text', text: 'x'.repeat(chars) }];

const toolResultEvent = (seq) => ({
	type: 'tool/result',
	seq,
	data: {
		turn: 1,
		step: 1,
		message: { id: 'm1', role: 'user', source: { kind: 'tool', callId: 'c1' }, content: [{ type: 'tool-result', toolCallId: 'c1', content: big(4000), isError: false }] },
	},
});

function fakeSession(id = 'session-1') {
	const appended = [];
	return {
		id,
		header: { cwd: '/work' },
		seq: 2,
		surface: { nodes: [7] },
		eventAt: (seq) => (seq === 7 ? toolResultEvent(7) : undefined),
		deriveEventMessage: () => toolResultEvent(7).data.message,
		snapshotEvents: () => [toolResultEvent(7)],
		requestContext: () => ({ provider: 'deepseek-official', model: 'deepseek-flash', contextWindow: 128000 }),
		append: (type, data) => {
			appended.push({ type, data });
			return { seq: 20 + appended.length, type };
		},
		appended,
	};
}

/** A `req` that replays a JSON body when the reader attaches its `end` handler. */
function fakeReq({ url = '/', method = 'GET', body } = {}) {
	const handlers = {};
	return {
		url,
		method,
		on(event, callback) {
			handlers[event] = callback;
			// `readBody` attaches data → error → end, so by 'end' the reader is ready.
			if (event === 'end' && body !== undefined) {
				handlers.data?.(Buffer.from(JSON.stringify(body), 'utf8'));
			}
			if (event === 'end') handlers.end?.();
			return this;
		},
		destroy() {},
	};
}

function fakeRes() {
	const captured = { status: 0, body: null };
	return {
		captured,
		writeHead(status) {
			captured.status = status;
		},
		end(payload) {
			captured.body = payload === undefined ? null : JSON.parse(String(payload));
		},
	};
}

/**
 * Build a context that behaves like the parts of Cordis this plugin touches:
 * `on` records listeners, `effect` owns a disposer, `inject` resolves an
 * already-present carrier, and `get` answers from a fixed service table.
 */
function makeHarness() {
	const listeners = [];
	const effects = [];
	const routes = new Map();
	const sessions = new Map([['session-1', fakeSession()]]);
	const prunerCalls = [];

	const webServer = {
		register(route) {
			routes.set(route.path, route.handler);
			return () => routes.delete(route.path);
		},
	};

	const services = {
		sessions: { get: (id) => sessions.get(id) },
		agents: { get: () => undefined },
		tokenMeter: {
			measure: () => ({
				baseline: { kind: 'usage', tokens: 5000 },
				totalTokens: 9000,
				surfaceTokens: 4000,
				surfaceDeltaTokens: 120,
				// The live shape: an array, exactly as `tokenMeter.measure` returns it.
				nodes: [{ seq: 7, tokens: 4000, heuristicTokens: 3900 }],
			}),
			estimateMessage: () => 42,
		},
		toolResultPruner: {
			pruneSession: () => {
				prunerCalls.push(true);
				return { pruned: [{ originalSeq: 7, replacementSeq: 20 }], charsRemoved: 1234 };
			},
		},
		webServer,
	};

	const ctx = {
		logger: { info: () => undefined },
		webServer,
		get: (key) => services[key],
		on(event, listener) {
			const entry = { event, listener, active: true };
			listeners.push(entry);
			return () => {
				entry.active = false;
			};
		},
		effect(callback, label) {
			const dispose = callback();
			const record = { label, dispose, active: true };
			effects.push(record);
			return () => {
				record.active = false;
				if (typeof dispose === 'function') dispose();
			};
		},
		inject(required, callback) {
			// The carrier is already present in this harness, which is the branch
			// the plugin must still survive (it may also arrive later).
			if (required.every((key) => services[key] !== undefined)) callback(ctx);
			return () => undefined;
		},
	};

	const active = (event) => listeners.filter((entry) => entry.event === event && entry.active).map((entry) => entry.listener);
	const call = (path, options) => {
		const handler = routes.get(path);
		if (handler === undefined) throw new Error(`no route registered at ${path}`);
		const req = fakeReq(options);
		const res = fakeRes();
		return Promise.resolve(handler(req, res)).then(() => res.captured);
	};
	const appends = () => [...(sessions.get('session-1')?.appended ?? [])];
	return { ctx, listeners, effects, routes, active, call, prunerCalls, services, sessions, appends };
}

test('the plugin identifies itself and needs no hard dependency', () => {
	assert.equal(name, 'dsh-plugin-context');
	// No `inject` export: the plugin works in a composition without the web
	// carrier, the token meter or the session store, and says so where it matters.
});

test('a default install registers observation only — nothing that can rewrite', () => {
	const harness = makeHarness();
	apply(harness.ctx, {});

	assert.equal(harness.active('tools/pre-execute').length, 1);
	assert.equal(harness.active('tools/result').length, 1);
	for (const event of ['tools/post-execute', 'tools/ptc-dispatch-log', 'llm/stream']) {
		assert.equal(harness.active(event).length, 0, `${event} must not be registered by a default install`);
	}
	// The observation half is grouped in one effect, the panel in others.
	assert.ok(harness.effects.every((effect) => effect.active));
	assert.ok(harness.effects.some((effect) => effect.label === 'dsh-plugin-context: tool observation'));
});

test('the three panel routes are registered behind the optional carrier', () => {
	const harness = makeHarness();
	apply(harness.ctx, {});
	assert.deepEqual([...harness.routes.keys()].sort(), ['/context/action', '/context/config', '/context/state']);
});

test('GET /context/state measures a live session through the token meter', async () => {
	const harness = makeHarness();
	apply(harness.ctx, {});
	const response = await harness.call('/context/state', { url: '/context/state?sessionId=session-1' });
	assert.equal(response.status, 200);
	assert.equal(response.body.ok, true);
	const snapshot = response.body.snapshot;
	assert.equal(snapshot.sessionId, 'session-1');
	assert.equal(snapshot.model, 'deepseek-flash');
	assert.equal(snapshot.contextWindow, 128000);
	assert.equal(snapshot.totals.tokens, 9000);
	assert.equal(snapshot.totals.baselineTokens, 5000);
	assert.equal(snapshot.stack.length, 1);
	assert.equal(snapshot.stack[0].tokens, 4000, 'the node is priced by the official meter');
	assert.equal(snapshot.stack[0].chars, 4000, 'and its size is measured in code points by this plugin');
	assert.equal(snapshot.config.kinds['tool-result'].onOver, 'report');
});

test('GET /context/state explains a missing or unknown session instead of guessing', async () => {
	const harness = makeHarness();
	apply(harness.ctx, {});
	const missing = await harness.call('/context/state', { url: '/context/state' });
	assert.equal(missing.body.ok, false);
	assert.match(missing.body.error, /sessionId is required/);
	const unknown = await harness.call('/context/state', { url: '/context/state?sessionId=nope' });
	assert.equal(unknown.body.ok, false);
	assert.match(unknown.body.error, /not live in this process/);
});

test('a composition config is in force at boot, and arms its seams', () => {
	const harness = makeHarness();
	apply(harness.ctx, { kinds: { 'tool-result': { maxChars: 1000, onOver: 'rewrite' } }, policies: { 'tool-result': 'head-tail' } });
	assert.equal(harness.active('tools/post-execute').length, 1);
	assert.equal(harness.active('tools/ptc-dispatch-log').length, 1);
	// Reasoning and output stay report-only, so the model path is untouched.
	assert.equal(harness.active('llm/stream').length, 0);
});

test('flipping a kind to rewrite adds exactly those listeners, and flipping back removes them', async () => {
	const harness = makeHarness();
	apply(harness.ctx, {});

	const armed = await harness.call('/context/config', {
		url: '/context/config',
		method: 'POST',
		body: { kinds: { 'tool-result': { maxChars: 1000, onOver: 'rewrite' }, output: { onOver: 'rewrite' } } },
	});
	assert.equal(armed.status, 200);
	assert.equal(armed.body.ok, true);
	assert.equal(harness.active('tools/post-execute').length, 1);
	assert.equal(harness.active('tools/ptc-dispatch-log').length, 1);
	assert.equal(harness.active('llm/stream').length, 1);
	assert.equal(harness.active('tools/result').length, 1, 'observation is never re-registered away');

	const disarmed = await harness.call('/context/config', {
		url: '/context/config',
		method: 'POST',
		body: { kinds: { 'tool-result': { onOver: 'report' }, output: { onOver: 'report' } } },
	});
	assert.equal(disarmed.body.ok, true);
	for (const event of ['tools/post-execute', 'tools/ptc-dispatch-log', 'llm/stream']) {
		assert.equal(harness.active(event).length, 0, `${event} must be gone after disarming`);
	}
});

test('a refused patch changes nothing and answers with the configuration still in force', async () => {
	const harness = makeHarness();
	apply(harness.ctx, {});
	const refused = await harness.call('/context/config', {
		url: '/context/config',
		method: 'POST',
		body: { kinds: { 'tool-result': { maxChars: 'lots' } } },
	});
	assert.equal(refused.status, 400);
	assert.equal(refused.body.ok, false);
	assert.match(refused.body.error, /maxChars must be a number/);
	assert.equal(refused.body.config.kinds['tool-result'].maxChars, 24000, 'the config in force is unchanged');
	assert.equal(harness.active('tools/post-execute').length, 0);
});

test('the POST-only routes say so', async () => {
	const harness = makeHarness();
	apply(harness.ctx, {});
	const action = await harness.call('/context/action', { url: '/context/action' });
	assert.equal(action.status, 405);
	assert.match(action.body.error, /POST/);
});

test('the official pruner can be fired from the panel, and its absence is explained', async () => {
	const harness = makeHarness();
	apply(harness.ctx, {});
	const done = await harness.call('/context/action', {
		url: '/context/action',
		method: 'POST',
		body: { sessionId: 'session-1', action: 'prune-official' },
	});
	assert.equal(done.status, 200);
	assert.equal(done.body.pruned, 1);
	assert.equal(done.body.charsRemoved, 1234);
	assert.equal(harness.prunerCalls.length, 1);

	harness.services.toolResultPruner = undefined;
	const absent = await harness.call('/context/action', {
		url: '/context/action',
		method: 'POST',
		body: { sessionId: 'session-1', action: 'prune-official' },
	});
	assert.equal(absent.status, 400);
	assert.match(absent.body.error, /not mounted/);
});

test('the manual intervention reports the identity policy as a no-op, not as a failure', async () => {
	const harness = makeHarness();
	apply(harness.ctx, {});
	const outcome = await harness.call('/context/action', {
		url: '/context/action',
		method: 'POST',
		body: { sessionId: 'session-1', action: 'intervene', seq: 7 },
	});
	assert.equal(outcome.status, 200);
	assert.equal(outcome.body.outcome.ok, true);
	assert.equal(outcome.body.outcome.changed, false);
});

test('an unknown action and a missing seq are refused with a reason', async () => {
	const harness = makeHarness();
	apply(harness.ctx, {});
	const unknown = await harness.call('/context/action', {
		url: '/context/action',
		method: 'POST',
		body: { sessionId: 'session-1', action: 'conjure' },
	});
	assert.equal(unknown.status, 400);
	assert.match(unknown.body.error, /unknown action/);

	const noSeq = await harness.call('/context/action', {
		url: '/context/action',
		method: 'POST',
		body: { sessionId: 'session-1', action: 'intervene' },
	});
	assert.equal(noSeq.status, 400);
	assert.match(noSeq.body.error, /seq is required/);
});

test('a tool call is watched live and reported in the panel data', async () => {
	const harness = makeHarness();
	apply(harness.ctx, {});
	const [watchStart] = harness.active('tools/pre-execute');
	const [watchEnd] = harness.active('tools/result');
	let released = false;
	await watchStart({ callId: 'c1', name: 'bash', arguments: { command: 'ls' }, agent: { session: fakeSession() } }, () => {
		released = true;
		return Promise.resolve({ kind: 'allow' });
	});
	assert.equal(released, true, 'the observation listener must always call next()');
	watchEnd({ callId: 'c1', name: 'bash' }, { content: big(10), isError: false });
	await new Promise((resolve) => setImmediate(resolve));
	const response = await harness.call('/context/state', { url: '/context/state?sessionId=session-1' });
	assert.equal(response.body.ok, true);
});

test('a session registry that throws is a missing session, not a failed request', async () => {
	const harness = makeHarness();
	harness.services.sessions = { get() { throw new Error('registry exploded'); } };
	apply(harness.ctx, {});
	const response = await harness.call('/context/state', { url: '/context/state?sessionId=session-1' });
	assert.equal(response.status, 200);
	assert.equal(response.body.ok, false);
	assert.match(response.body.error, /not live in this process/);
});

test('a composition with no token meter still measures what it can, and says what it cannot', async () => {
	const harness = makeHarness();
	harness.services.tokenMeter = undefined;
	apply(harness.ctx, {});
	const response = await harness.call('/context/state', { url: '/context/state?sessionId=session-1' });
	assert.equal(response.body.ok, true);
	const snapshot = response.body.snapshot;
	assert.match(snapshot.measurementError, /token meter is not mounted/);
	assert.equal(snapshot.totals.tokens, 0);
	assert.equal(snapshot.stack.length, 1, 'the stack is still listed, priced by the fallback estimate');
});

test('a batch preview prices a selection, keeps every row, and commits nothing', async () => {
	const harness = makeHarness();
	apply(harness.ctx, {
		kinds: { 'tool-result': { maxChars: 1000, onOver: 'report' } },
		policies: { 'tool-result': 'head-tail' },
	});
	const response = await harness.call('/context/action', {
		url: '/context/action',
		method: 'POST',
		body: { sessionId: 'session-1', action: 'preview', seqs: [7, 7, 999] },
	});
	assert.equal(response.status, 200);
	assert.equal(response.body.applied, false);
	const batch = response.body.batch;
	assert.equal(batch.totals.nodes, 2, 'duplicates collapse: pricing the same node twice is a lie');
	assert.equal(batch.rows.length, 2);
	assert.equal(batch.rows[0].ok, true);
	assert.equal(batch.rows[0].intervention.charsBefore, 4000);
	assert.ok(batch.rows[0].intervention.charsAfter < 4000, 'the head-tail policy would give bytes back');
	assert.equal(batch.rows[0].changed, true);
	assert.equal(batch.rows[0].blocks, undefined, 'live content never rides a response body');
	assert.equal(batch.rows[1].ok, false);
	assert.match(batch.rows[1].error, /not in this session's surface/);
	assert.equal(batch.totals.refused, 1, 'a refusal is a row, not a silence');
	assert.equal(batch.totals.charsAfter, 1000, 'the projection totals what the writes would leave');
	assert.equal(harness.appends().length, 0, 'a preview is a measurement: nothing is committed');
});

test('a batch apply writes every node it priced, and reports each row', async () => {
	const harness = makeHarness();
	apply(harness.ctx, {
		kinds: { 'tool-result': { maxChars: 1000, onOver: 'report' } },
		policies: { 'tool-result': 'head-tail' },
	});
	const response = await harness.call('/context/action', {
		url: '/context/action',
		method: 'POST',
		body: { sessionId: 'session-1', action: 'intervene-batch', seqs: [7] },
	});
	assert.equal(response.status, 200);
	assert.equal(response.body.applied, true);
	assert.equal(response.body.batch.rows[0].intervention.applied, true);
	assert.ok(harness.appends().length > 0, 'the apply is the half that commits');

	// The preview ran the same arithmetic, so it cannot disagree with the write.
	const preview = await harness.call('/context/action', {
		url: '/context/action',
		method: 'POST',
		body: { sessionId: 'session-1', action: 'preview', seqs: [7] },
	});
	assert.equal(preview.body.batch.rows[0].intervention.charsAfter, response.body.batch.rows[0].intervention.charsAfter);
});

test('a batch is bounded, and an empty or oversized selection is refused with a reason', async () => {
	const harness = makeHarness();
	apply(harness.ctx, {});
	const empty = await harness.call('/context/action', {
		url: '/context/action',
		method: 'POST',
		body: { sessionId: 'session-1', action: 'preview', seqs: [] },
	});
	assert.equal(empty.status, 400);
	assert.match(empty.body.error, /non-empty array/);

	const tooMany = await harness.call('/context/action', {
		url: '/context/action',
		method: 'POST',
		body: { sessionId: 'session-1', action: 'preview', seqs: Array.from({ length: 101 }, (unused, index) => index + 1) },
	});
	assert.equal(tooMany.status, 400);
	assert.match(tooMany.body.error, /at most 100/);
});

test('the snapshot carries no precomputed ranking, and its composition is derived', async () => {
	const harness = makeHarness();
	apply(harness.ctx, {});
	const response = await harness.call('/context/state', { url: '/context/state?sessionId=session-1' });
	const snapshot = response.body.snapshot;
	assert.equal(snapshot.top, undefined, 'the panel queries; the host does not ship a second copy of the rows');
	assert.equal(snapshot.totals.calls, 0, 'this stand-in session has no tool calls in its window');
	assert.equal(snapshot.totals.subCalls, 0);
	// 9000 measured, 4000 on the surface → 5000 the surface cannot account for.
	const prefix = snapshot.composition.find((bucket) => bucket.key === 'prefix');
	assert.equal(prefix.tokens, 5000);
	assert.equal(
		snapshot.composition.reduce((sum, bucket) => sum + bucket.tokens, 0),
		9000,
		'the buckets add up to the total the header prints',
	);
});
