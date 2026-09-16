/**
 * The measurement layer's contract: every number is attributable, a node is
 * classified from real event data, and a call is joined to its result even when
 * the result never landed.
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
	nodeFactsFromEvent,
	resultFactsFromEvent,
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

test('composition adds up to the baseline plus every node', () => {
	const stack = [
		{ kind: 'tool-result', tokens: 100 },
		{ kind: 'assistant', tokens: 20 },
		{ kind: 'reasoning', tokens: 5 },
		{ kind: 'user', tokens: 30 },
		{ kind: 'other', tokens: 1 },
	];
	const buckets = compositionOf(500, stack);
	const total = buckets.reduce((sum, bucket) => sum + bucket.tokens, 0);
	assert.equal(total, 656);
	assert.equal(buckets[0].tokens, 500);
	assert.equal(buckets[1].tokens, 100);
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
