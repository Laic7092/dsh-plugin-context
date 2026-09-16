/**
 * The measurement layer's contract: every number is attributable, a node is
 * classified from real event data, and a call is joined to its result even when
 * the result never landed.
 *
 * The composition and sub-dispatch tests are the two that exist because a number
 * on screen was WRONG: the prefix used to be the measurement's whole-request
 * baseline (so the legend added up to more than 100%), and a `min-ptc` session
 * used to look like one tool called `run_code` three hundred times.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
	InterventionLog,
	callFactsFromEvent,
	charsOfContent,
	compositionOf,
	estimateTokens,
	joinCalls,
	joinSubCalls,
	nodeFactsFromEvent,
	resultFactsFromEvent,
	subCallFactsFromEvent,
	subCallPair,
	textOfBlock,
} from '../lib/measure.js';

const toolResultEvent = (over = {}) => ({
	type: 'tool/result',
	seq: 7,
	data: {
		turn: 2,
		step: 3,
		message: {
			role: 'user',
			source: { kind: 'tool', callId: 'call-1' },
			content: [{ type: 'tool-result', toolCallId: 'call-1', content: [{ type: 'text', text: 'abcd' }], isError: false }],
		},
		...over,
	},
});

test('a tool result node is named by the tool that produced it and priced by its text', () => {
	const facts = nodeFactsFromEvent(7, toolResultEvent(), new Map([['call-1', 'read']]));
	assert.equal(facts.kind, 'tool-result');
	assert.equal(facts.toolName, 'read');
	assert.equal(facts.label, 'read');
	assert.equal(facts.chars, 4);
	assert.equal(facts.callId, 'call-1');
	assert.equal(facts.turn, 2);
	assert.equal(facts.step, 3);
});

test('a tool result without a known call falls back to its call id, not to a blank', () => {
	const facts = nodeFactsFromEvent(7, toolResultEvent());
	assert.equal(facts.label, 'tool call-1');
});

test('an assistant message is bucketed by its larger text share', () => {
	const reasoningHeavy = nodeFactsFromEvent(3, {
		type: 'assistant/message',
		seq: 3,
		data: {
			turn: 1,
			step: 1,
			message: { role: 'assistant', content: [{ type: 'reasoning', text: 'x'.repeat(100) }, { type: 'text', text: 'short' }] },
		},
	});
	assert.equal(reasoningHeavy.kind, 'reasoning');
	assert.equal(reasoningHeavy.chars, 105);

	const outputHeavy = nodeFactsFromEvent(3, {
		type: 'assistant/message',
		seq: 3,
		data: {
			turn: 1,
			step: 1,
			message: { role: 'assistant', content: [{ type: 'reasoning', text: 'x' }, { type: 'text', text: 'a much longer answer' }] },
		},
	});
	assert.equal(outputHeavy.kind, 'assistant');
	assert.equal(outputHeavy.label, 'a much longer answer');
});

test('an assistant message that calls a tool carries the call id', () => {
	const facts = nodeFactsFromEvent(3, {
		type: 'assistant/message',
		seq: 3,
		data: {
			turn: 1,
			step: 2,
			message: {
				role: 'assistant',
				content: [{ type: 'tool-call', toolCallId: 'call-9', name: 'bash', arguments: '{"command":"ls"}' }],
			},
		},
	});
	assert.equal(facts.toolName, 'bash');
	assert.equal(facts.callId, 'call-9');
	assert.equal(facts.label, 'call bash');
});

test('an unknown event on the surface is kept, not dropped from the total', () => {
	const facts = nodeFactsFromEvent(11, { type: 'compaction/summary', seq: 11, data: {} });
	assert.equal(facts.kind, 'other');
	assert.equal(facts.label, 'compaction/summary');
});

test('call and result facts are read from the log shapes', () => {
	const call = callFactsFromEvent({ type: 'tool/call', seq: 1, data: { turn: 1, step: 1, callId: 'c1', name: 'read', arguments: '{"path":"a"}' } });
	assert.deepEqual(call, { callId: 'c1', toolName: 'read', turn: 1, step: 1, argsChars: 12 });
	assert.equal(callFactsFromEvent({ type: 'tool/result', seq: 1, data: {} }), null);

	const result = resultFactsFromEvent(7, toolResultEvent({ error: { name: 'E', code: 'c' } }));
	assert.equal(result.callId, 'call-1');
	assert.equal(result.chars, 4);
	assert.equal(result.isError, true);
	assert.equal(resultFactsFromEvent(7, { type: 'user/message', seq: 7, data: {} }), null);
});

test('a call whose result never landed is reported, not omitted', () => {
	const pairs = joinCalls(
		[{ callId: 'c1', toolName: 'bash', turn: 1, step: 1, argsChars: 40 }],
		[],
		{ durations: new Map([['c1', 120]]) },
	);
	assert.equal(pairs.length, 1);
	assert.equal(pairs[0].resultChars, 0);
	assert.equal(pairs[0].resultTokens, null);
	assert.equal(pairs[0].durationMs, 120);
	assert.equal(pairs[0].over, false);
});

test('a result that left the surface keeps a null price instead of a zero', () => {
	const pairs = joinCalls(
		[{ callId: 'c1', toolName: 'read', turn: 1, step: 1, argsChars: 10 }],
		[{ callId: 'c1', seq: 99, chars: 900, isError: false }],
		{ tokensBySeq: new Map(), durations: new Map() },
	);
	assert.equal(pairs[0].resultTokens, null);
	assert.equal(pairs[0].resultChars, 900);
});

test('the composition is derived, so its buckets add up to the measured total', () => {
	const stack = [
		{ kind: 'tool-result', tokens: 100 },
		{ kind: 'assistant', tokens: 20 },
		{ kind: 'reasoning', tokens: 5 },
		{ kind: 'user', tokens: 30 },
		{ kind: 'other', tokens: 1 },
	];
	// The framework's own arithmetic is total = baseline + surfaceDelta, and its
	// baseline is a whole-request anchor — so the prefix must be what the surface
	// CANNOT account for, never the baseline itself (which counted everything twice).
	const buckets = compositionOf(656, 156, stack);
	assert.equal(buckets[0].key, 'prefix');
	assert.equal(buckets[0].tokens, 500, 'prefix = total − surface');
	assert.equal(buckets[1].tokens, 100);
	assert.equal(
		buckets.reduce((sum, bucket) => sum + bucket.tokens, 0),
		656,
		'the buckets add up to the total the header prints',
	);
});

test('the system prompt is its own bucket, never part of the residual', () => {
	// On this harness the system prompt is a real surface node (a system/message
	// event, appended by the harness's own SystemPromptProjection), so it must be
	// totalled here — the residual is what the surface CANNOT account for.
	const stack = [{ kind: 'system', tokens: 1463 }, { kind: 'user', tokens: 61 }];
	const buckets = compositionOf(2000, 1524, stack);
	assert.equal(buckets.find((bucket) => bucket.key === 'system').tokens, 1463);
	assert.equal(buckets.find((bucket) => bucket.key === 'prefix').tokens, 476);
	assert.equal(buckets.find((bucket) => bucket.key === 'prefix').label, 'Fixed request overhead');
});

test('a meter that priced nothing falls back to the nodes rather than calling it all prefix', () => {
	// Why this matters: an unpriced surface must not turn into a 100% "system prompt".
	const buckets = compositionOf(100, 0, [{ kind: 'tool-result', tokens: 40 }]);
	assert.equal(buckets[0].tokens, 60);
	assert.equal(buckets[1].tokens, 40);
	assert.equal(buckets.reduce((sum, bucket) => sum + bucket.tokens, 0), 100);
});

test('a surface measured larger than the total cannot produce a negative prefix', () => {
	const buckets = compositionOf(10, 999, [{ kind: 'tool-result', tokens: 999 }]);
	assert.equal(buckets[0].tokens, 0);
});

test('a sub-dispatch is named and priced from the log, start through settle', () => {
	const start = {
		type: 'tool/ptc-dispatch-start',
		seq: 18,
		time: 1_000,
		data: { rootCallId: 'c1', parentCallId: 'c1', subCallId: 'c1:ptc:1', name: 'bash', arguments: '{"command":"ls"}' },
	};
	const settle = {
		type: 'tool/ptc-dispatch',
		seq: 19,
		time: 1_012,
		data: {
			rootCallId: 'c1',
			parentCallId: 'c1',
			subCallId: 'c1:ptc:1',
			name: 'bash',
			arguments: '{"command":"ls"}',
			isError: false,
			content: [{ type: 'text', text: 'abcdef' }],
		},
	};
	const facts = [subCallFactsFromEvent(18, start), subCallFactsFromEvent(19, settle)].filter((entry) => entry !== null);
	const subs = joinSubCalls(facts);
	assert.equal(subs.length, 1);
	assert.equal(subs[0].toolName, 'bash', 'the name the runtime waterfall never carries');
	assert.equal(subs[0].argsChars, 16, 'the durable event carries the dispatched arguments');
	assert.equal(subs[0].resultChars, 6);
	assert.equal(subs[0].durationMs, 12);
	assert.equal(subs[0].parentCallId, 'c1');

	const pair = subCallPair(subs[0], { turn: 4, step: 2 });
	assert.equal(pair.nested, true);
	assert.equal(pair.inContext, false, 'a log-only sub-call never reached the model context');
	assert.equal(pair.resultTokens, null, 'so it is never priced');
	assert.equal(pair.over, false, 'the tool-result budget governs the surface, not the log');
	assert.equal(pair.turn, 4, 'it inherits its parent run_code call\'s turn');
});

test('a sub-dispatch that never settled is kept, with nothing to show for it', () => {
	const start = {
		type: 'tool/ptc-dispatch-start',
		seq: 30,
		time: 2_000,
		data: { subCallId: 'c9:ptc:4', parentCallId: 'c9', name: 'write', arguments: '{}' },
	};
	const subs = joinSubCalls([subCallFactsFromEvent(30, start)].filter((entry) => entry !== null));
	assert.equal(subs.length, 1);
	assert.equal(subs[0].toolName, 'write');
	assert.equal(subs[0].resultChars, 0);
	assert.equal(subs[0].durationMs, null);
	assert.equal(subCallPair(subs[0]).inContext, false);
});

test('a root call says whether its own result is still on the surface', () => {
	const calls = [callFactsFromEvent({ type: 'tool/call', data: { callId: 'a', name: 'bash', arguments: 'x' } })].filter(Boolean);
	const landed = joinCalls(calls, [{ callId: 'a', seq: 5, chars: 10, isError: false }]);
	assert.equal(landed[0].inContext, true);
	assert.equal(landed[0].nested, false);
	assert.equal(landed[0].parentCallId, null);
	const missing = joinCalls(calls, []);
	assert.equal(missing[0].inContext, false, 'a call whose result never landed is not in the context');
});

test('nested tool-result content is measured through its inner blocks', () => {
	assert.equal(textOfBlock({ type: 'tool-result', content: [{ type: 'text', text: 'ab' }, { type: 'image', attachment: {} }] }), 'ab');
	assert.equal(charsOfContent([{ type: 'tool-result', content: [{ type: 'text', text: 'abc' }] }, { type: 'image' }]), 3);
	assert.equal(textOfBlock({ type: 'file', attachment: {} }), null);
	assert.equal(estimateTokens(0), 0);
	assert.equal(estimateTokens(9), 3);
});

test('the interventions log is bounded and reads newest first', () => {
	const log = new InterventionLog(10);
	for (let index = 0; index < 25; index += 1) {
		log.record({ time: index, kind: 'output', policy: 'identity', charsBefore: index, charsAfter: index, changed: false });
	}
	const entries = log.list();
	assert.equal(entries.length, 10);
	assert.equal(entries[0].time, 24);
	assert.equal(entries[9].time, 15);
	assert.equal(log.count(), 10);
});
