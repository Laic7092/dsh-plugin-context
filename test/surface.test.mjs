/**
 * The single durable write's contract. This is the one operation in the package
 * that changes a session that was already written, so every refusal it can make
 * is pinned here, together with the exact shape the framework's own rewrite
 * assertion requires.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { replaceToolResultContent, resultCharsOf, toolResultBlockOf } from '../lib/surface.js';

const content = (chars) => [{ type: 'text', text: 'y'.repeat(chars) }];

function session(seq, event, derived) {
	const appended = [];
	return {
		appended,
		surface: { nodes: [seq] },
		eventAt: (wanted) => (wanted === seq ? event : undefined),
		deriveEventMessage: () => derived,
		append: (type, data, options) => {
			appended.push({ type, data, options });
			return { seq: 500 + appended.length, type };
		},
	};
}

const event = (seq) => ({
	type: 'tool/result',
	seq,
	data: {
		turn: 2,
		step: 3,
		meta: { tool: 'read' },
		message: {
			id: 'm1',
			role: 'user',
			source: { kind: 'tool', callId: 'c1' },
			content: [{ type: 'tool-result', toolCallId: 'c1', content: content(400), isError: false }],
		},
	},
});

const derived = () => ({
	id: 'm1',
	role: 'user',
	source: { kind: 'tool', callId: 'c1' },
	content: [{ type: 'tool-result', toolCallId: 'c1', content: content(400), isError: false }],
});

const meter = { estimateMessage: () => 42 };

test('a replacement without a token meter is refused rather than written unpriced', () => {
	const live = session(7, event(7), derived());
	const outcome = replaceToolResultContent({ session: live, tokenMeter: undefined }, 7, content(5));
	assert.equal(outcome.ok, false);
	assert.match(outcome.error, /token meter/);
	assert.equal(live.appended.length, 0, 'an unpriced replacement must not land');
});

test('a node that is not a tool result is refused', () => {
	const live = session(7, { type: 'compaction/summary', seq: 7, data: {} }, derived());
	const outcome = replaceToolResultContent({ session: live, tokenMeter: meter }, 7, content(5));
	assert.equal(outcome.ok, false);
	assert.match(outcome.error, /only a tool result/);
	assert.equal(live.appended.length, 0);
});

test('a node that is not in the log is refused', () => {
	const live = session(7, event(7), derived());
	const outcome = replaceToolResultContent({ session: live, tokenMeter: meter }, 99, content(5));
	assert.equal(outcome.ok, false);
	assert.match(outcome.error, /not in this session/);
});

test('a new session that is not a session at all is refused, never thrown at', () => {
	assert.equal(replaceToolResultContent({ session: null, tokenMeter: meter }, 1, content(5)).ok, false);
	assert.equal(replaceToolResultContent({ session: { eventAt() { throw new Error('nope'); } }, tokenMeter: meter }, 1, content(5)).ok, false);
});

test('the write is the framework\'s own pattern: shadow price first, then the replacement', () => {
	const live = session(7, event(7), derived());
	const outcome = replaceToolResultContent({ session: live, tokenMeter: meter }, 7, content(9));
	assert.equal(outcome.ok, true);
	assert.equal(outcome.seq, 502);
	assert.equal(live.appended.length, 2);

	const [prune, replacement] = live.appended;
	// 1. The shadow price, synchronously and immediately before the replacement.
	assert.equal(prune.type, 'compaction/prune');
	assert.deepEqual(prune.data, {
		shadowedRange: { start: 7, end: 7 },
		shadowedSeqs: [7],
		shadowedTokenCount: 42,
	});
	assert.equal(prune.options, undefined, 'a log-only event carries no surface op');

	// 2. The replacement: exactly one node, cited, and the op is exactly three keys.
	assert.equal(replacement.type, 'tool/result');
	assert.deepEqual(replacement.options, {
		surfaceOp: { op: 'replace', startSeq: 7, endSeq: 7 },
		sourceEventSeqs: [7],
	});

	// 3. The durable data differs from the original in `message` only.
	assert.equal(replacement.data.turn, 2);
	assert.equal(replacement.data.step, 3);
	assert.deepEqual(replacement.data.meta, { tool: 'read' });
	assert.equal(replacement.data.message.id, 'm1');
	assert.equal(replacement.data.message.source.callId, 'c1');
	const block = replacement.data.message.content[0];
	assert.equal(block.type, 'tool-result');
	assert.equal(block.toolCallId, 'c1');
	assert.equal(block.isError, false, 'the error flag survives a rewrite that never looked at it');
	assert.deepEqual(block.content, content(9));
});

test('a session that refuses the replacement reports why, and the shadow price stays', () => {
	const live = session(7, event(7), derived());
	live.append = (type, data, options) => {
		live.appended.push({ type, data, options });
		if (type === 'tool/result') throw new Error('surface replace: start seq 7 not found in surface');
		return { seq: 1, type };
	};
	const outcome = replaceToolResultContent({ session: live, tokenMeter: meter }, 7, content(9));
	assert.equal(outcome.ok, false);
	assert.match(outcome.error, /refused the replacement/);
	assert.match(outcome.error, /not found in surface/);
});

test('the block and char helpers read only what a tool result actually holds', () => {
	assert.equal(toolResultBlockOf({ content: [{ type: 'tool-result', toolCallId: 'c' }] }).toolCallId, 'c');
	assert.equal(toolResultBlockOf({ content: [{ type: 'text', text: 'x' }] }), null);
	assert.equal(toolResultBlockOf(null), null);
	assert.equal(toolResultBlockOf({}), null);
	assert.equal(resultCharsOf([{ type: 'text', text: '汉字' }]), 2);
	assert.equal(resultCharsOf([{ type: 'reasoning', text: 'ab' }, { type: 'image', attachment: {} }]), 2);
});
