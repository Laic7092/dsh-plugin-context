/**
 * The control pipeline's contract, which is the plugin's whole safety story:
 *
 *  - a fresh install arms nothing that can change a request;
 *  - `report` mode runs the policy as a dry run and applies nothing;
 *  - `rewrite` mode applies exactly what the policy answered;
 *  - and the generation-time guard is a genuine no-op under the identity policy.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { ContextControl, argumentsChars } from '../lib/control.js';
import { DEFAULTS } from '../lib/config.js';

const big = (chars = 400) => [{ type: 'text', text: 'x'.repeat(chars) }];

/** A live-session stand-in: records appends, and hands back exactly one node. */
function fakeSession(seq, event, derived) {
	const appended = [];
	return {
		id: 'session-1',
		header: { cwd: '/work' },
		seq: seq + 1,
		surface: { nodes: [seq] },
		eventAt: (wanted) => (wanted === seq ? event : undefined),
		deriveEventMessage: () => derived,
		snapshotEvents: () => [event],
		requestContext: () => ({ provider: 'p', model: 'm', contextWindow: 1000 }),
		append: (type, data, options) => {
			appended.push({ type, data, options });
			return { seq: 900 + appended.length, type };
		},
		appended,
	};
}

const toolResultEvent = (seq) => ({
	type: 'tool/result',
	seq,
	data: {
		turn: 3,
		step: 4,
		message: {
			id: 'm1',
			role: 'user',
			source: { kind: 'tool', callId: 'c1' },
			content: [{ type: 'tool-result', toolCallId: 'c1', content: big(400), isError: false }],
		},
	},
});

const derivedMessage = () => ({
	id: 'm1',
	role: 'user',
	source: { kind: 'tool', callId: 'c1' },
	content: [{ type: 'tool-result', toolCallId: 'c1', content: big(400), isError: false }],
});

const tokenMeter = { estimateMessage: () => 42 };

async function collect(iterable) {
	const out = [];
	for await (const chunk of iterable) out.push(chunk);
	return out;
}

const source = (chunks) => (async function* generate() {
	for (const chunk of chunks) yield chunk;
})();

test('a fresh install arms nothing that can change a request', () => {
	const control = new ContextControl({ config: {} });
	assert.equal(control.needsToolResultSeam(), false);
	assert.equal(control.needsStreamSeam(), false);
	assert.match(control.describe(), /report-only/);
	assert.equal(control.configuration().kinds['tool-result'].onOver, 'report');
});

test('rewrite is a configuration flip, and the host is told to re-arm', () => {
	const control = new ContextControl({ config: {} });
	const patched = control.patch({ kinds: { 'tool-result': { onOver: 'rewrite' } } });
	assert.equal(patched.ok, true);
	assert.equal(patched.rearm, true, 'moving a seam must be reported so the host can re-register');
	assert.equal(control.needsToolResultSeam(), true);

	// Changing only the strategy moves no seam, but must still be in force.
	const renamed = control.patch({ policies: { 'tool-result': 'head-tail' } });
	assert.equal(renamed.ok, true);
	assert.equal(renamed.rearm, false);
	assert.deepEqual(control.policies.names()['tool-result'], 'head-tail');

	// A refused patch leaves the previous configuration in force.
	const refused = control.patch({ policies: { 'tool-result': 'does-not-exist' } });
	assert.equal(refused.ok, false);
	assert.equal(control.policies.names()['tool-result'], 'head-tail');
});

test('nothing is rewritten while the seam is unarmed', async () => {
	const control = new ContextControl({ config: { kinds: { 'tool-result': { maxChars: 10 } } } });
	assert.equal(await control.decideToolResult({ callId: 'c1', name: 'read' }, big(400), false), null);
	assert.equal(await control.decidePtcDispatch({ subCallId: 's1', name: 'read', content: big(400) }), null);
});

test('a result within budget is never offered to a policy', async () => {
	const control = new ContextControl({
		config: { kinds: { 'tool-result': { maxChars: 10_000, onOver: 'rewrite' } }, policies: { 'tool-result': 'head-tail' } },
	});
	assert.equal(await control.decideToolResult({ callId: 'c1', name: 'read' }, big(20), false), null);
});

test('an over-budget result is rewritten when the seam is armed, and the log says so', async () => {
	const control = new ContextControl({
		config: { kinds: { 'tool-result': { maxChars: 100, onOver: 'rewrite' } }, policies: { 'tool-result': 'head-tail' } },
	});
	const decision = await control.decideToolResult({ callId: 'c1', name: 'bash' }, big(4000), false);
	assert.ok(decision !== null);
	assert.ok(decision.content[0].text.length < 4000);
	const entry = control.log()[0];
	assert.equal(entry.applied, true);
	assert.equal(entry.changed, true);
	assert.equal(entry.kind, 'tool-result');
	assert.equal(entry.toolName, 'bash');
	assert.ok(entry.charsAfter < entry.charsBefore);
});

test('a nested run_code sub-dispatch is left to the PTC seam, and that seam rewrites', async () => {
	const control = new ContextControl({
		config: { kinds: { 'tool-result': { maxChars: 100, onOver: 'rewrite' } }, policies: { 'tool-result': 'head-tail' } },
	});
	// post-execute must not touch a nested dispatch: it would rewrite the same
	// result twice, once for the runtime and once for the durable log copy.
	assert.equal(await control.decideToolResult({ callId: 'c1', name: 'read', parent: Symbol('parent') }, big(4000), false), null);
	const ptc = await control.decidePtcDispatch({ subCallId: 'run:ptc:1', name: 'read', content: big(4000) });
	assert.ok(ptc !== null);
	assert.ok(ptc.content[0].text.length < 4000);
});

test('report mode is a dry run: the policy runs, and not one byte moves', async () => {
	const control = new ContextControl({
		config: { kinds: { 'tool-result': { maxChars: 100, onOver: 'report' } }, policies: { 'tool-result': 'head-tail' } },
	});
	await control.finishCall({ callId: 'c1', name: 'read' }, { content: big(4000), isError: false });
	const entry = control.log()[0];
	assert.equal(entry.applied, false, 'a report is not an application');
	assert.equal(entry.changed, true, 'a dry run still tells you what would change');
	assert.ok(entry.charsAfter < entry.charsBefore);
	// The same item offered to the armed path is still refused, because the seam
	// is not registered in report mode.
	assert.equal(await control.decideToolResult({ callId: 'c1', name: 'read' }, big(4000), false), null);
});

test('a report-mode call within budget records nothing', async () => {
	const control = new ContextControl({ config: {} });
	await control.finishCall({ callId: 'c1', name: 'read' }, { content: big(10), isError: false });
	assert.equal(control.log().length, 0);
});

test('the live watch records a duration and survives a call with no start', async () => {
	const control = new ContextControl({ config: {} });
	control.startCall({ callId: 'c1', name: 'bash', arguments: { command: 'ls' } });
	await control.finishCall({ callId: 'c1', name: 'bash' }, { content: big(5), isError: false });
	const [call] = control.liveCalls();
	assert.equal(call.toolName, 'bash');
	assert.equal(call.resultChars, 5);
	assert.ok(call.endedAt >= call.startedAt);
	assert.equal(argumentsChars({ command: 'ls' }), '{"command":"ls"}'.length);
	assert.equal(argumentsChars(undefined), 0);
});

test('the generation guard under the identity policy passes the stream through untouched', async () => {
	const control = new ContextControl({
		config: { kinds: { output: { maxChars: 5, onOver: 'rewrite' } } },
	});
	const chunks = [
		{ type: 'block-start', index: 0, blockType: 'text' },
		{ type: 'text-delta', index: 0, text: 'a'.repeat(50) },
		{ type: 'text-delta', index: 0, text: 'b'.repeat(50) },
		{ type: 'tool-call-delta', index: 1, id: 'c1', argumentsDelta: '{}' },
		{ type: 'finish', reason: { kind: 'stop' } },
	];
	const out = await collect(control.guardStream(source(chunks)));
	assert.deepEqual(out, chunks, 'identity must be a genuine no-op, not a silent cap');
	// It still records that the budget was crossed.
	assert.equal(control.log()[0].changed, false);
});

test('the generation guard stops an over-long block where the policy says', async () => {
	const control = new ContextControl({
		config: { kinds: { output: { maxChars: 100, onOver: 'rewrite' }, reasoning: { enabled: false } }, policies: { output: 'head-tail' } },
	});
	const chunks = [
		{ type: 'text-delta', index: 0, text: 'a'.repeat(60) },
		{ type: 'text-delta', index: 0, text: 'b'.repeat(60) },
		{ type: 'text-delta', index: 0, text: 'c'.repeat(60) },
		{ type: 'block-end', index: 0, block: { type: 'text', text: '' } },
		{ type: 'finish', reason: { kind: 'stop' } },
	];
	const out = await collect(control.guardStream(source(chunks)));
	const emitted = out.filter((chunk) => chunk.type === 'text-delta').map((chunk) => chunk.text).join('');
	assert.ok(emitted.length < 180, 'the block was cut short');
	assert.ok(emitted.startsWith('aaaa'), 'what was already streaming is not retracted');
	assert.equal(out.filter((chunk) => chunk.type === 'finish').length, 1, 'the finish chunk still arrives');
	assert.equal(out.filter((chunk) => chunk.type === 'block-end').length, 1);
	const entry = control.log()[0];
	assert.equal(entry.kind, 'output');
	assert.equal(entry.applied, true);
	assert.equal(entry.changed, true);
});

test('a disabled kind is not guarded at all', async () => {
	const control = new ContextControl({
		config: { kinds: { output: { maxChars: 5, enabled: false, onOver: 'rewrite' } } },
	});
	const chunks = [{ type: 'text-delta', index: 0, text: 'a'.repeat(500) }];
	assert.deepEqual(await collect(control.guardStream(source(chunks))), chunks);
	assert.equal(control.log().length, 0);
});

test('the manual intervention is a no-op under the identity policy', async () => {
	const session = fakeSession(7, toolResultEvent(7), derivedMessage());
	const control = new ContextControl({ config: {} });
	const outcome = await control.interveneOnNode({ session, tokenMeter }, 7);
	assert.equal(outcome.ok, true);
	assert.equal(outcome.changed, false);
	assert.equal(session.appended.length, 0, 'identity must write nothing');
});

test('the manual intervention commits the policy answer to the surface', async () => {
	const session = fakeSession(7, toolResultEvent(7), derivedMessage());
	const control = new ContextControl({
		config: { kinds: { 'tool-result': { maxChars: 100, onOver: 'rewrite' } }, policies: { 'tool-result': 'head-tail' } },
	});
	const outcome = await control.interveneOnNode({ session, tokenMeter }, 7);
	assert.equal(outcome.ok, true);
	assert.equal(outcome.changed, true);
	assert.equal(session.appended.length, 2);
	assert.equal(session.appended[0].type, 'compaction/prune');
	assert.equal(session.appended[1].type, 'tool/result');
	assert.equal(control.log()[0].applied, true);
});

test('the panel snapshot is built from a live-shaped session, and names its options', () => {
	const session = fakeSession(7, toolResultEvent(7), derivedMessage());
	const control = new ContextControl({ config: {} });
	const snapshot = control.snapshotFor(session, {
		baselineKind: 'usage',
		baselineTokens: 900,
		totalTokens: 1200,
		surfaceTokens: 300,
		surfaceDeltaTokens: 10,
		nodes: new Map([[7, 300]]),
	});
	assert.equal(snapshot.sessionId, 'session-1');
	assert.equal(snapshot.cwd, '/work');
	assert.equal(snapshot.model, 'm');
	assert.equal(snapshot.contextWindow, 1000);
	assert.equal(snapshot.stack.length, 1);
	assert.equal(snapshot.stack[0].tokens, 300);
	assert.equal(snapshot.calls.length, 0, 'a result with no matching call event is not a call row');
	assert.ok(snapshot.policyOptions.includes('identity'));
	assert.ok(snapshot.policyOptions.includes('head-tail'));
	assert.equal(snapshot.config.kinds['tool-result'].maxChars, DEFAULTS.kinds['tool-result'].maxChars);
});

test('a session nobody can identify yields an explained empty snapshot, not a throw', () => {
	const control = new ContextControl({ config: {} });
	const snapshot = control.snapshotFor(null, null);
	assert.equal(snapshot.sessionId, '');
	assert.deepEqual(snapshot.stack, []);
	assert.ok(typeof snapshot.measurementError === 'string');
});
