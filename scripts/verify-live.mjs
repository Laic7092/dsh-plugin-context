/**
 * Verify the plugin against the *running* harness.
 *
 * `npm test` proves the logic and `npm run verify` proves the data model against
 * a real log; neither can prove that the profile actually mounted this plugin,
 * because a new bundle only enters the boot graph at startup. This script fills
 * that last gap: it asks the live server for the browser bundle and for the two
 * JSON routes, and reads a real session through them.
 *
 * Run it after restarting the profile:
 *
 *   dsh web                       # restart; a new bundle needs a boot
 *   npm run verify:live           # this script, newest session picked for you
 *   npm run verify:live -- <sessionId>
 *
 * A 404 on the bundle or the routes is not a bug in this script — it is the
 * plugin not being mounted, which is exactly what it reports.
 *
 * @module dsh-plugin-context/scripts/verify-live
 */
import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

const BASE = process.env.DSH_URL ?? 'http://127.0.0.1:3080';
const BUNDLE = '/plugins/??dsh-plugin-context/client.js';

/**
 * The newest live session id, for a run with no argument.
 *
 * The store is per-workspace, and this script is normally run from the plugin
 * directory through `npm run`, so the cwd is the wrong clue: every workspace's
 * store is scanned and the most recently written session wins.
 */
function newestSessionId() {
	const home = process.env.DSH_HOME ?? join(homedir(), '.dsh');
	const root = join(home, 'sessions');
	let newest = null;
	for (const workspace of safeReaddir(root)) {
		const dir = join(root, workspace);
		for (const entry of safeReaddir(dir)) {
			const file = join(dir, entry, 'session.v3.jsonl.zstd');
			try {
				const mtime = statSync(file).mtimeMs;
				if (newest === null || mtime > newest.mtime) newest = { id: entry, mtime };
			} catch {
				// Not a session directory.
			}
		}
	}
	return newest === null ? null : newest.id;
}

function safeReaddir(path) {
	try {
		return readdirSync(path);
	} catch {
		return [];
	}
}

const failures = [];
const notes = [];
let sawSession = false;

/** Fetch, reporting the status instead of throwing. */
async function probe(path, init) {
	try {
		const response = await fetch(`${BASE}${path}`, init);
		const text = await response.text();
		return { status: response.status, text };
	} catch (error) {
		return { status: 0, text: '', error: error instanceof Error ? error.message : String(error) };
	}
}

console.log(`harness: ${BASE}`);

// 1. The browser half.
//
// This deliberately is NOT a hard check. The page and its bundle routes are
// behind the browser's own authenticated session and revision: a plain HTTP
// client gets 401 on `/` and 404 on `/plugins/??<any-plugin>/client.js` — the
// same 404 for the shipped plugins and for this one, so a 404 here proves
// nothing about whether the client half mounted. The only honest place to check
// it is the page itself: reload after the restart and look for the Context
// Control view and the header meter.
const page = await probe('/');
if (page.status === 200 && page.text.includes('dsh-plugin-context')) {
	console.log('  client half:        present in the page\'s boot graph');
} else {
	notes.push(
		`client half not checkable from here (/ → HTTP ${page.status || page.error}; the bundle route needs the page's own auth and graph revision) — ` +
			'reload the page and look for the "Context Control" view and the header meter',
	);
}

// 2. The host half: the configuration actually in force.
const config = await probe('/context/config');
if (config.status !== 200) {
	failures.push(`GET /context/config → ${config.status || config.error}`);
	notes.push('the host half is not mounted either: no row for this plugin in the running process');
} else {
	let body = null;
	try {
		body = JSON.parse(config.text);
	} catch {
		failures.push('GET /context/config did not answer with JSON');
	}
	if (body !== null) {
		if (body.ok !== true) failures.push(`GET /context/config answered ok:false (${body.error ?? 'no reason given'})`);
		else {
			const kinds = body.config.kinds;
			const armed = ['tool-result', 'reasoning', 'output'].filter((kind) => kinds[kind].enabled && kinds[kind].onOver === 'rewrite');
			console.log(`  host half mounted:  budgets tool-result=${kinds['tool-result'].maxChars} reasoning=${kinds.reasoning.maxChars} output=${kinds.output.maxChars}`);
			console.log(`  rewriting:          ${armed.length === 0 ? 'nothing (report-only, the shipped default)' : armed.join(', ')}`);
		}
	}
}

// 3. A real session, read through the plugin's own route.
const sessionId = process.argv[2] ?? newestSessionId();
if (sessionId === null) {
	notes.push('no session log found for this workspace; pass a session id to check the panel data');
} else {
	const state = await probe(`/context/state?sessionId=${encodeURIComponent(sessionId)}`);
	if (state.status !== 200) {
		failures.push(`GET /context/state → ${state.status || state.error}`);
	} else {
		let body = null;
		try {
			body = JSON.parse(state.text);
		} catch {
			failures.push('GET /context/state did not answer with JSON');
		}
		if (body !== null && body.ok !== true) {
			failures.push(`GET /context/state answered ok:false (${body.error ?? 'no reason given'})`);
		} else if (body !== null) {
			const snapshot = body.snapshot;
			if (snapshot.sessionId !== sessionId) failures.push('the snapshot describes a different session');
			if (!Array.isArray(snapshot.stack) || snapshot.stack.length === 0) failures.push('the context stack is empty for a session with a log');
			if (typeof snapshot.totals.tokens !== 'number' || snapshot.totals.tokens <= 0) failures.push('the measured context pressure is zero — the token meter was not read');
			if (!Array.isArray(snapshot.top.nodes) || snapshot.top.nodes.length === 0) failures.push('the ranked list is empty');
			console.log(`  session ${sessionId}:`);
			console.log(`    pressure:         ${snapshot.totals.tokens} tok${snapshot.contextWindow === null ? '' : ` of ${snapshot.contextWindow}`}, baseline ${snapshot.totals.baselineKind}`);
			console.log(`    stack:            ${snapshot.stack.length} node(s), ${snapshot.calls.length} tool call(s) paired`);
			console.log(`    largest node:     #${snapshot.top.nodes[0].seq} ${snapshot.top.nodes[0].kind} ${snapshot.top.nodes[0].tokens} tok — ${snapshot.top.nodes[0].label.slice(0, 40)}`);
			console.log(`    policies:         ${Object.values(snapshot.policies).join(' / ')} (offered: ${snapshot.policyOptions.join(', ')})`);
			if (snapshot.measurementError !== undefined) notes.push(`measurement note: ${snapshot.measurementError}`);
			const overBudget = snapshot.stack.filter((node) => node.over).length;
			console.log(`    over budget now:  ${overBudget} node(s)`);
			sawSession = true;
		}
	}
}

for (const note of notes) console.log(`note: ${note}`);
if (failures.length > 0) {
	console.error(`\nNOT MOUNTED / FAILING (${failures.length}):`);
	for (const failure of failures) console.error(`  - ${failure}`);
	console.error('\nrestart the profile (`dsh web`) and run this again — a new bundle only enters the boot graph at startup.');
	process.exit(1);
}
console.log(`\nOK: the running harness mounted the host half${sawSession ? ' and answered with real measured context for a live session' : ''}.`);
