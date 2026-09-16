/**
 * The policy layer's contract: identity is a real no-op, a policy can shorten
 * text without touching anything it did not look at, and a policy can never
 * corrupt the content it was shown.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { PolicyRegistry, applyPolicyBlocks, codePoints, describeBlocks, identity, runPolicy } from '../lib/policies.js';

const toolResultBlocks = () => [
	{ type: 'text', text: 'x'.repeat(1000) },
	{ type: 'image', attachment: { attachmentId: 'a1', mediaType: 'image/png', bytes: 10, width: 4, height: 4 } },
];

test('identity returns the input it was given and changes nothing', async () => {
	const registry = new PolicyRegistry();
	assert.deepEqual(registry.names(), { 'tool-result': 'identity', reasoning: 'identity', output: 'identity' });
	const blocks = toolResultBlocks();
	const described = describeBlocks(blocks);
	const input = {
		kind: 'tool-result',
		sessionId: 's1',
		turn: 1,
		step: 1,
		callId: 'c1',
		toolName: 'read',
		blocks: described,
		chars: 1000,
		tokens: 250,
		maxChars: 100,
		over: true,
		reason: 'threshold',
	};
	const run = await runPolicy(registry.get('tool-result'), input, 42);
	assert.equal(run.application.changed, false);
	assert.equal(run.application.charsAfter, 1000);
	assert.deepEqual(run.application.blocks, blocks);
	assert.equal(run.intervention.changed, false);
	assert.equal(run.intervention.policy, 'identity');
	assert.equal(run.intervention.time, 42);
	assert.equal(run.intervention.error, undefined);
});

test('a policy that shortens a text block keeps every other field of the content', () => {
	const blocks = toolResultBlocks();
	const answer = applyPolicyBlocks(blocks, {
		blocks: [
			{ ...describeBlocks(blocks)[0], text: 'short' },
			{ ...describeBlocks(blocks)[1] },
		],
	});
	assert.equal(answer.changed, true);
	assert.equal(answer.charsAfter, 5);
	assert.equal(answer.blocks.length, 2);
	assert.equal(answer.blocks[0].text, 'short');
	// The rich block is the very same object, so its attachment survives.
	assert.equal(answer.blocks[1], blocks[1]);
});

test('a policy may drop a text block', () => {
	const blocks = [{ type: 'text', text: 'aaa' }, { type: 'text', text: 'bbb' }];
	const described = describeBlocks(blocks);
	const answer = applyPolicyBlocks(blocks, { blocks: [{ ...described[0], drop: true }, { ...described[1] }] });
	assert.equal(answer.changed, true);
	assert.equal(answer.blocks.length, 1);
	assert.equal(answer.blocks[0].text, 'bbb');
});

test('a policy may not drop a non-text block', () => {
	const blocks = toolResultBlocks();
	const described = describeBlocks(blocks);
	const answer = applyPolicyBlocks(blocks, { blocks: [described[0], { ...described[1], drop: true }] });
	assert.equal(answer.changed, false);
	assert.match(answer.error, /non-text/);
	assert.deepEqual(answer.blocks, blocks);
});

test('a policy may not renumber blocks or change a block type', () => {
	const blocks = [{ type: 'text', text: 'aaa' }];
	const described = describeBlocks(blocks);
	const renumbered = applyPolicyBlocks(blocks, { blocks: [{ ...described[0], index: 7 }] });
	assert.equal(renumbered.changed, false);
	assert.match(renumbered.error, /never shown/);

	const retyped = applyPolicyBlocks(blocks, { blocks: [{ ...described[0], type: 'reasoning' }] });
	assert.equal(retyped.changed, false);
	assert.match(retyped.error, /changed block 0/);
});

test('a policy may not invent text for a non-text block', () => {
	const blocks = [{ type: 'image', attachment: {} }];
	const described = describeBlocks(blocks);
	const answer = applyPolicyBlocks(blocks, { blocks: [{ ...described[0], text: 'fabricated' }] });
	assert.equal(answer.changed, false);
	assert.match(answer.error, /text it did not have/);
});

test('a policy that throws, rejects, or answers nonsense leaves the content alone', async () => {
	const blocks = [{ type: 'text', text: 'keep me' }];
	const described = describeBlocks(blocks);
	const base = {
		kind: 'reasoning',
		sessionId: null,
		turn: null,
		step: null,
		callId: null,
		toolName: null,
		blocks: described,
		chars: 7,
		tokens: 2,
		maxChars: 1,
		over: true,
		reason: 'manual',
	};

	const throws = await runPolicy({ name: 'boom', policy: () => { throw new Error('bad policy'); } }, base, 1);
	assert.equal(throws.application.changed, false);
	assert.deepEqual(throws.application.blocks, blocks);
	assert.match(throws.intervention.error, /policy threw: bad policy/);

	const rejects = await runPolicy({ name: 'async-boom', policy: async () => { throw new Error('nope'); } }, base, 1);
	assert.match(rejects.intervention.error, /nope/);
	assert.deepEqual(rejects.application.blocks, blocks);

	const nonsense = await runPolicy({ name: 'nonsense', policy: () => ({ blocks: 'not an array' }) }, base, 1);
	assert.equal(nonsense.application.changed, false);
	assert.equal(nonsense.intervention.error, 'policy returned no blocks array');
	assert.deepEqual(nonsense.application.blocks, blocks);

	const nothing = await runPolicy({ name: 'nothing', policy: () => undefined }, base, 1);
	assert.match(nothing.intervention.error, /nothing usable/);
});

test('registering a replacement is reversible and the panel sees the new name', () => {
	const registry = new PolicyRegistry();
	const restore = registry.set('output', (input) => input, 'trim-output');
	assert.equal(registry.names().output, 'trim-output');
	restore();
	assert.equal(registry.names().output, 'identity');
});

test('registering a non-function is refused rather than silently accepted', () => {
	const registry = new PolicyRegistry();
	assert.throws(() => registry.set('output', 'not a function'), TypeError);
});

test('code points are counted, not UTF-16 units', () => {
	assert.equal(codePoints('汉字'), 2);
	assert.equal(codePoints('👩‍🚀'), 3);
	assert.equal(codePoints(''), 0);
	assert.equal(identity({ chars: 1 }).chars, 1);
});
