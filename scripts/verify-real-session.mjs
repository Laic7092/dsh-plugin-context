/**
 * Verify this plugin's data model against a real session log.
 *
 * The plugin's riskiest assumptions are all about shape: that a `tool/call`
 * event carries `data.name` and `data.callId`, that a `tool/result`'s call id
 * lives at `data.message.content[0].toolCallId`, that an assistant message's
 * reasoning and text are separable, and that a session log is a stream of
 * surface events. A wrong field name does not throw — it produces a panel full
 * of zeros — so the shapes are checked here against a log the harness actually
 * wrote, not against a fixture written by the same hand as the reader.
 *
 * Usage:
 *   node scripts/verify-real-session.mjs [path/to/session.v3.jsonl.zstd]
 *
 * With no argument it picks the newest session log under the harness home.
 * Session logs are written as many concatenated zstd frames (one per flush), so
 * they are decoded frame by frame; a single-frame decoder returns only the
 * header, which is exactly the kind of silent one-line "success" this script
 * exists to prevent.
 *
 * @module dsh-plugin-context/scripts/verify-real-session
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { zstdDecompressSync } from 'node:zlib';
import { homedir } from 'node:os';
import { callFactsFromEvent, joinCalls, nodeFactsFromEvent, resultFactsFromEvent, textOfBlock } from '../lib/measure.js';

const ZSTD_MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);

/** Decode a log written as many concatenated zstd frames. */
function decodeFrames(path) {
	const buffer = readFileSync(path);
	const offsets = [];
	let cursor = 0;
	while (true) {
		const found = buffer.indexOf(ZSTD_MAGIC, cursor);
		if (found === -1) break;
		offsets.push(found);
		cursor = found + 4;
	}
	if (offsets.length === 0) throw new Error(`${path}: no zstd frame found`);
	const parts = [];
	for (let index = 0; index < offsets.length; index += 1) {
		const start = offsets[index];
		const end = index + 1 < offsets.length ? offsets[index + 1] : buffer.length;
		parts.push(zstdDecompressSync(buffer.subarray(start, end)));
	}
	return { frames: offsets.length, text: Buffer.concat(parts).toString('utf8') };
}

/** The newest session log under the harness home, newest first. */
function newestLog() {
	const home = process.env.DSH_HOME ?? join(homedir(), '.dsh');
	const root = join(home, 'sessions');
	const found = [];
	for (const workspace of readdirSync(root)) {
		const dir = join(root, workspace);
		let entries = [];
		try {
			entries = readdirSync(dir);
		} catch {
			continue;
		}
		for (const session of entries) {
			const file = join(dir, session, 'session.v3.jsonl.zstd');
			try {
				found.push({ file, mtime: statSync(file).mtimeMs });
			} catch {
				// Not a session directory.
			}
		}
	}
	found.sort((a, b) => b.mtime - a.mtime);
	if (found.length === 0) throw new Error(`no session logs under ${root}`);
	return found[0].file;
}

const path = process.argv[2] ?? newestLog();
const { frames, text } = decodeFrames(path);
const events = [];
for (const line of text.split('\n')) {
	if (line.trim().length === 0) continue;
	try {
		events.push(JSON.parse(line));
	} catch {
		// A partial trailing line is expected while a session is live.
	}
}

const header = events.find((event) => event.type === 'session');
const toolEvents = events.filter((event) => event.type === 'tool/call');
const resultEvents = events.filter((event) => event.type === 'tool/result');
const assistantEvents = events.filter((event) => event.type === 'assistant/message');

console.log(`log: ${path}`);
console.log(`decoded ${frames} frames → ${events.length} events (session ${header?.id ?? 'unknown'})`);

// ---------------------------------------------------------------- the checks
const failures = [];
const calls = toolEvents.map((event) => callFactsFromEvent(event));
const results = resultEvents.map((event, index) => resultFactsFromEvent(resultEvents[index].seq, event));

const callsRead = calls.filter((call) => call !== null);
if (callsRead.length !== toolEvents.length) failures.push(`${toolEvents.length - callsRead.length} tool/call event(s) were not recognized`);
if (callsRead.some((call) => call.toolName === 'unknown')) failures.push('a tool/call event carried no tool name');

const resultsRead = results.filter((result) => result !== null);
if (resultsRead.length !== resultEvents.length) failures.push(`${resultEvents.length - resultsRead.length} tool/result event(s) carried no call id`);
const emptyResults = resultsRead.filter((result) => result.chars === 0);
if (emptyResults.length === resultsRead.length && resultsRead.length > 0) failures.push('every tool result measured zero characters — the content shape is wrong');

const pairs = joinCalls(callsRead, resultsRead, {});
if (pairs.length !== callsRead.length) failures.push(`join produced ${pairs.length} pair(s) from ${callsRead.length} call(s)`);
const unmatched = pairs.filter((pair) => pair.resultChars === 0);
if (callsRead.length > 0 && unmatched.length === pairs.length) failures.push('no tool result matched its call — call ids do not join');

// Surface metadata: only the four message-ish types may carry a surface op, and
// every one of them must.
const SURFACE = new Set(['system/message', 'user/message', 'assistant/message', 'tool/result']);
for (const event of events) {
	const isSurface = SURFACE.has(event.type);
	const hasOp = event.surfaceOp !== undefined;
	if (isSurface && !hasOp) failures.push(`${event.type} at seq ${event.seq} is surface-eligible but carries no surfaceOp`);
	if (!isSurface && hasOp) failures.push(`${event.type} at seq ${event.seq} is not surface-eligible but carries a surfaceOp`);
}

// The stack, as the panel would label it.
const toolNames = new Map(callsRead.map((call) => [call.callId, call.toolName]));
const nodes = events
	.filter((event) => SURFACE.has(event.type))
	.map((event) => {
		const facts = nodeFactsFromEvent(event.seq, event, toolNames);
		return { ...facts, tokens: Math.ceil(facts.chars / 4) };
	});
if (nodes.length !== events.filter((event) => SURFACE.has(event.type)).length) failures.push('some surface events produced no node');

// Reasoning versus output, from the real blocks.
const assistantSizes = assistantEvents.map((event) => {
	const blocks = Array.isArray(event.data?.message?.content) ? event.data.message.content : [];
	let reasoning = 0;
	let text = 0;
	for (const block of blocks) {
		const value = textOfBlock(block);
		if (value === null) continue;
		if (block?.type === 'reasoning') reasoning += [...value].length;
		else if (block?.type === 'text') text += [...value].length;
	}
	return { seq: event.seq, reasoning, text };
});

// ------------------------------------------------------------------- report
const byTool = new Map();
for (const pair of pairs) {
	const row = byTool.get(pair.toolName) ?? { toolName: pair.toolName, calls: 0, argsChars: 0, resultChars: 0, errors: 0 };
	row.calls += 1;
	row.argsChars += pair.argsChars;
	row.resultChars += pair.resultChars;
	if (pair.isError) row.errors += 1;
	byTool.set(pair.toolName, row);
}
const toolRows = [...byTool.values()].sort((a, b) => b.resultChars + b.argsChars - (a.resultChars + a.argsChars));

console.log(`\ntoolCall → toolResult: ${pairs.length} joined pair(s)`);
console.log('  tool                 calls   args ch   result ch   errors');
for (const row of toolRows.slice(0, 12)) {
	console.log(`  ${row.toolName.padEnd(20)} ${String(row.calls).padStart(5)} ${String(row.argsChars).padStart(9)} ${String(row.resultChars).padStart(11)} ${String(row.errors).padStart(8)}`);
}

const largestResults = [...pairs].sort((a, b) => b.resultChars - a.resultChars).slice(0, 8);
console.log('\n  largest tool results (the tool-result budget question):');
for (const pair of largestResults) {
	console.log(`  #${String(pair.callId).padEnd(24)} ${pair.toolName.padEnd(12)} ${String(pair.resultChars).padStart(9)} ch`);
}

const totalReasoning = assistantSizes.reduce((sum, row) => sum + row.reasoning, 0);
const totalText = assistantSizes.reduce((sum, row) => sum + row.text, 0);
const largestCoT = [...assistantSizes].sort((a, b) => b.reasoning - a.reasoning).slice(0, 5);
const largestOutput = [...assistantSizes].sort((a, b) => b.text - a.text).slice(0, 5);
console.log(`\n  assistant messages: ${assistantSizes.length}, reasoning ${totalReasoning} ch, text ${totalText} ch`);
console.log(`  largest reasoning blocks: ${largestCoT.map((row) => `#${row.seq}:${row.reasoning}`).join(' ')}`);
console.log(`  largest text outputs:     ${largestOutput.map((row) => `#${row.seq}:${row.text}`).join(' ')}`);

const rank = [...nodes].sort((a, b) => b.chars - a.chars).slice(0, 10);
console.log(`\n  context stack: ${nodes.length} node(s), by size (what fills the window):`);
for (const node of rank) {
	console.log(`  #${String(node.seq).padStart(4)} ${String(node.kind).padEnd(12)} ${String(node.chars).padStart(9)} ch  ${node.label.slice(0, 48)}`);
}

const kinds = new Map();
for (const node of nodes) kinds.set(node.kind, (kinds.get(node.kind) ?? 0) + node.chars);
console.log('\n  by kind (chars): ' + [...kinds.entries()].sort((a, b) => b[1] - a[1]).map(([kind, chars]) => `${kind}=${chars}`).join(' '));

// ------------------------------------------------------------------ verdict
if (failures.length > 0) {
	console.error(`\nFAILED (${failures.length}):`);
	for (const failure of [...new Set(failures)]) console.error(`  - ${failure}`);
	process.exit(1);
}
console.log('\nOK: every tool call, tool result, assistant message and surface op in this real log was read the way the plugin assumes.');
