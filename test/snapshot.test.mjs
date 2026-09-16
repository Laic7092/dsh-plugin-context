/**
 * The session-reading layer's contract: the stack is the surface, the call table
 * is joined and priced, and a session shape nobody recognizes degrades into
 * "nothing to show" rather than into a throw.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { LOG_WINDOW, budgetKindOf, collectCalls, collectStack, overBudget, readMeasurement, readRequestContext, sessionReaderOf } from '../lib/snapshot.js';
import { DEFAULTS, applyPatch } from '../lib/config.js';

/** A session-shaped fixture: no live objects, exactly the fields the reader reads. */
function reader(options = {}) {
	const events = new Map(options.events ?? []);
	const seq = options.seq ?? 100;
	return {
		id: options.id ?? 's1',
		cwd: options.cwd ?? '/work',
		seq,
		surface: options.surface ?? [...events.keys()],
		eventAt: (wanted) => events.get(wanted),
		recentEvents: (limit) => [...events.values()].filter((event) => event.seq > seq - limit).sort((a, b) => a.seq - b.seq),
		requestContext: () => ({ provider: 'deepseek-official', model: 'deepseek-flash', contextWindow: 128000 }),
	};
}

function measurement(nodes) {
	return {
		baselineKind: 'usage',
		baselineTokens: 3000,
		totalTokens: 9000,
		surfaceTokens: 6000,
		surfaceDeltaTokens: 100,
		nodes: new Map(Object.entries(nodes).map(([seq, tokens]) => [Number(seq), tokens])),
	};
}

const toolResult = (seq, text, callId = `call-${seq}`) => ({
	type: 'tool/result',
	seq,
	data: {
		turn: 1,
		step: 1,
		message: { role: 'user', content: [{ type: 'tool-result', toolCallId: callId, content: [{ type: 'text', text }], isError: false }] },
	},
});

const toolCall = (seq, callId, name, args) => ({ type: 'tool/call', seq, data: { turn: 1, step: 1, callId, name, arguments: args } });

test('the stack is the surface, so a removed node leaves no ghost', () => {
	const events = new Map([
		[1, toolCall(1, 'call-1', 'read', '{}')],
		[2, toolResult(2, 'kept', 'call-1')],
		[3, toolResult(3, 'compacted away')],
	]);
	// The surface carries node 2 only: node 3 was compaction's casualty.
	const one = reader({ events, surface: [2] });
	const stack = collectStack(one, measurement({ 2: 40 }), DEFAULTS);
	assert.equal(stack.length, 1);
	assert.equal(stack[0].seq, 2);
	assert.equal(stack[0].tokens, 40);
	assert.equal(stack[0].toolName, 'read');
});

test('a node the official meter does not price falls back to an estimate', () => {
	const events = new Map([[9, toolResult(9, 'x'.repeat(400))]]);
	const stack = collectStack(reader({ events }), measurement({}), DEFAULTS);
	assert.equal(stack[0].chars, 400);
	assert.equal(stack[0].tokens, 100);
});

test('a node over its kind budget is flagged, and the flag follows the config', () => {
	const events = new Map([[9, toolResult(9, 'x'.repeat(500))]]);
	const tight = applyPatch(DEFAULTS, { kinds: { 'tool-result': { maxChars: 100 } } }).config;
	assert.equal(collectStack(reader({ events }), measurement({ 9: 125 }), tight)[0].over, true);

	// `report` is measurement, not management: the node is flagged either way.
	assert.equal(collectStack(reader({ events }), measurement({ 9: 125 }), DEFAULTS)[0].over, false);

	const off = applyPatch(DEFAULTS, { kinds: { 'tool-result': { enabled: false } } }).config;
	assert.equal(collectStack(reader({ events }), measurement({ 9: 125 }), off)[0].over, false);
});

test('budget kinds map by node kind, and unmetered kinds have none', () => {
	assert.equal(budgetKindOf({ kind: 'tool-result' }), 'tool-result');
	assert.equal(budgetKindOf({ kind: 'reasoning' }), 'reasoning');
	assert.equal(budgetKindOf({ kind: 'assistant' }), 'output');
	assert.equal(budgetKindOf({ kind: 'user' }), null);
	assert.equal(budgetKindOf({ kind: 'system' }), null);
	assert.equal(overBudget({ kind: 'user', chars: 10_000_000 }, DEFAULTS), false);
});

test('calls are joined to results, priced when on the surface, and flagged when over', () => {
	const events = new Map([
		[1, toolCall(1, 'c1', 'read', '{"path":"a"}')],
		[2, toolResult(2, 'short', 'c1')],
		[3, toolCall(3, 'c2', 'bash', '{"command":"ls"}')],
		[4, toolResult(4, 'y'.repeat(600), 'c2')],
	]);
	const config = applyPatch(DEFAULTS, { kinds: { 'tool-result': { maxChars: 100 } } }).config;
	const calls = collectCalls(reader({ events }), measurement({ 2: 5, 4: 150 }), config, new Map([['c2', 33]]));
	assert.equal(calls.length, 2);
	const bash = calls.find((call) => call.toolName === 'bash');
	assert.equal(bash.resultChars, 600);
	assert.equal(bash.resultTokens, 150);
	assert.equal(bash.over, true);
	assert.equal(bash.durationMs, 33);
	const read = calls.find((call) => call.toolName === 'read');
	assert.equal(read.over, false);
	assert.equal(read.durationMs, null);
});

test('the call table walks a bounded window of the log', () => {
	const events = new Map([
		[1, toolCall(1, 'old', 'read', '{}')],
		[LOG_WINDOW + 10, toolCall(LOG_WINDOW + 10, 'new', 'write', '{}')],
	]);
	const calls = collectCalls(reader({ events, seq: LOG_WINDOW + 10 }), null, DEFAULTS);
	assert.deepEqual(calls.map((call) => call.toolName), ['write']);
});

test('a session with no measurement still produces a stack and a call table', () => {
	const events = new Map([
		[1, toolCall(1, 'c1', 'read', '{}')],
		[2, toolResult(2, 'text', 'c1')],
	]);
	const stack = collectStack(reader({ events }), null, DEFAULTS);
	assert.equal(stack.length, 2);
	assert.equal(stack[0].kind, 'other');
	assert.equal(stack[1].tokens, 1);
	// Without a measurement the call is still joined; only its price is unknown.
	const calls = collectCalls(reader({ events }), null, DEFAULTS);
	assert.equal(calls.length, 1);
	assert.equal(calls[0].resultChars, 4);
	assert.equal(calls[0].resultTokens, null);
});

test('the measurement and request context readers tolerate partial shapes', () => {
	assert.equal(readMeasurement(null), null);
	const read = readMeasurement({ baseline: { kind: 'usage', tokens: 10 }, totalTokens: 20, nodes: [{ seq: 1, tokens: 5 }, { seq: 'x' }] });
	assert.equal(read.baselineKind, 'usage');
	assert.equal(read.baselineTokens, 10);
	assert.equal(read.nodes.get(1), 5);
	assert.equal(read.nodes.size, 1);
	// An unrecognized baseline kind is not guessed into a number.
	assert.equal(readMeasurement({ baseline: { kind: 'weird', tokens: 7 } }).baselineKind, 'none');

	assert.equal(readRequestContext(undefined), null);
	assert.deepEqual(readRequestContext({ provider: 'p', model: 'm' }), { provider: 'p', model: 'm', contextWindow: null });
	assert.equal(readRequestContext({ provider: 'p', contextWindow: 0 }).contextWindow, null);
});

test('the live measurement shape and the normalized shape both price a node', () => {
	// `tokenMeter.measure` hands over an array of priced nodes; everything
	// downstream looks prices up. A regression here once made every panel read
	// "unmeasured", so both shapes are pinned.
	const fromArray = readMeasurement({
		baseline: { kind: 'usage', tokens: 5000 },
		totalTokens: 9000,
		surfaceTokens: 4000,
		surfaceDeltaTokens: 120,
		nodes: [{ seq: 7, tokens: 4000, heuristicTokens: 3900 }],
	});
	assert.ok(fromArray.nodes instanceof Map);
	assert.equal(fromArray.nodes.get(7), 4000);

	const fromMap = readMeasurement({ nodes: new Map([[7, 4000]]) });
	assert.equal(fromMap.nodes.get(7), 4000);
	assert.equal(fromMap.baselineKind, 'none');

	const events = new Map([[7, toolResult(7, 'x'.repeat(400))]]);
	const stack = collectStack(reader({ events, surface: [7] }), fromArray, DEFAULTS);
	assert.equal(stack[0].tokens, 4000, 'the official price is used, not the fallback estimate');
});

test('the adapter reads the real session shape, and refuses one it cannot identify', () => {
	const fake = {
		id: 'session-1',
		seq: 5,
		header: { cwd: '/work' },
		surface: { nodes: [1, 2, 'nope'] },
		eventAt: (seq) => (seq === 1 ? toolResult(1, 'hi') : undefined),
		snapshotEvents: (from, to) => [toolCall(from, 'c1', 'read', '{}')].filter((event) => event.seq < to),
		requestContext: () => ({ provider: 'p', model: 'm', contextWindow: 1000 }),
	};
	const adapted = sessionReaderOf(fake);
	assert.equal(adapted.id, 'session-1');
	assert.equal(adapted.cwd, '/work');
	assert.deepEqual(adapted.surface, [1, 2]);
	assert.equal(adapted.recentEvents(10).length, 1);
	assert.equal(adapted.eventAt(1).seq, 1);

	assert.equal(sessionReaderOf(null), null);
	assert.equal(sessionReaderOf({}), null);
	// A getter that throws is a session this plugin does not understand.
	assert.equal(sessionReaderOf({ get id() { throw new Error('no'); } }), null);

	const hostile = sessionReaderOf({
		id: 's2',
		get surface() { throw new Error('no'); },
		get seq() { throw new Error('no'); },
		eventAt() { throw new Error('no'); },
		snapshotEvents() { throw new Error('no'); },
		requestContext() { throw new Error('no'); },
	});
	assert.deepEqual(hostile.surface, []);
	assert.equal(hostile.seq, 0);
	assert.equal(hostile.eventAt(1), undefined);
	assert.deepEqual(hostile.recentEvents(10), []);
	assert.equal(hostile.requestContext(), undefined);
});
