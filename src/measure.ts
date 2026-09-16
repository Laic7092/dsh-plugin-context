/**
 * dsh-plugin-context — measurement.
 *
 * This module is pure: it is handed the narrow slices of a session it is allowed
 * to read, and it returns one owned JSON value. It never holds a live object,
 * never serializes one as a whole, and never walks a structure it did not ask
 * for. Two consequences that matter:
 *
 *  - a snapshot can be cached, diffed and sent to the browser with no risk of
 *    leaking a Cordis Service through `JSON.stringify`;
 *  - the whole panel's data model can be tested without a host, which is how the
 *    numbers on screen are kept honest.
 *
 * **Where each number comes from** — the distinction is the reason this file
 * refuses to invent a single total:
 *
 *  - `tokens` on a node and the `baseline` are the official `tokenMeter`
 *    projection, so the panel always agrees with the composer's own context
 *    ring;
 *  - `chars` is this plugin's own count of Unicode code points, because a budget
 *    has to be in a unit a person can reason about and a policy can slice;
 *  - `estimateTokens` exists only for content the official meter does not price
 *    on its own (a tool call's arguments) and is labelled as an estimate
 *    everywhere it surfaces.
 *
 * @module dsh-plugin-context/measure
 */
import { POLICY_NAMES } from './policies.ts';
import type { CallPair, CompositionBucket, ContextConfig, ContextSnapshot, Intervention, PolicyKind, StackNode } from './types.ts';

/** A node's own facts, read from one session event. */
export interface NodeFacts {
	readonly seq: number;
	readonly kind: StackNode['kind'];
	readonly label: string;
	readonly chars: number;
	readonly turn: number | null;
	readonly step: number | null;
	readonly toolName: string | null;
	readonly callId: string | null;
}

/** A tool call as the log recorded it. */
export interface CallFacts {
	readonly callId: string;
	readonly toolName: string;
	readonly turn: number | null;
	readonly step: number | null;
	readonly argsChars: number;
}

/** A tool result as the log recorded it, before it is joined to its call. */
export interface ResultFacts {
	readonly callId: string;
	readonly seq: number;
	readonly chars: number;
	readonly isError: boolean;
}

/** Count Unicode code points the way every budget in this plugin does. */
export function countChars(text: string | null | undefined): number {
	if (typeof text !== 'string' || text.length === 0) return 0;
	return [...text].length;
}

/**
 * A rough token price for content the official meter does not itemize.
 *
 * Deliberately crude and deliberately labelled: ~4 code points per token is the
 * same guess the framework's own estimator falls back to before usage arrives.
 * No total in this plugin is built from it.
 */
export function estimateTokens(chars: number): number {
	if (!Number.isFinite(chars) || chars <= 0) return 0;
	return Math.ceil(chars / 4);
}

/** The text payload of one content block, or null when it carries none. */
export function textOfBlock(block: unknown): string | null {
	if (block === null || typeof block !== 'object') return null;
	const any: any = block;
	switch (any.type) {
		case 'text':
		case 'reasoning':
			return typeof any.text === 'string' ? any.text : null;
		case 'tool-result': {
			// The block's own content is a nested array of blocks; only its text
			// contributes to a budget, exactly as the framework's pruner measures it.
			const inner = Array.isArray(any.content) ? any.content : [];
			let joined = '';
			for (const part of inner) {
				const text = textOfBlock(part);
				if (text !== null) joined += text;
			}
			return joined;
		}
		case 'tool-call':
			return typeof any.arguments === 'string' ? any.arguments : null;
		default:
			return null;
	}
}

/**
 * The arguments text as the log wrote it.
 *
 * The field is a JSON STRING on `tool/call` and on a few old `tool/ptc-dispatch`
 * events, and a JSON VALUE on the rest — a real log of 324 dispatches held 322
 * objects and 2 strings. Reading only the string form is how a traffic table ends
 * up quietly reporting zero argument bytes for every sub-call, so both shapes are
 * read here, once, and everything downstream sees the same serialized size.
 */
export function argsTextOf(value: unknown): string {
	if (typeof value === 'string') return value;
	if (value === undefined || value === null) return '';
	try {
		return JSON.stringify(value);
	} catch {
		return '';
	}
}

/** Code points across a content array's text-bearing blocks. */
export function charsOfContent(blocks: readonly unknown[]): number {
	let total = 0;
	for (const block of Array.isArray(blocks) ? blocks : []) total += countChars(textOfBlock(block));
	return total;
}

/** The tool call an assistant message asks for, when it asks for one. */
function toolCallOf(blocks: readonly unknown[]): { callId: string | null; name: string | null } {
	for (const block of Array.isArray(blocks) ? blocks : []) {
		const any: any = block;
		if (any && any.type === 'tool-call') {
			return {
				callId: typeof any.toolCallId === 'string' ? any.toolCallId : null,
				name: typeof any.name === 'string' ? any.name : null,
			};
		}
	}
	return { callId: null, name: null };
}

/**
 * Short, human label for a node.
 *
 * A tool result is named by the tool that produced it when the caller has the
 * call map; otherwise by its call id. A message is named by its first words,
 * which is what a person recognizes it by in the stack.
 */
function labelOf(kind: StackNode['kind'], text: string, fallback: string): string {
	const collapsed = text.replace(/\s+/g, ' ').trim();
	if (collapsed.length === 0) return fallback;
	return collapsed.length > 48 ? `${collapsed.slice(0, 46)}…` : collapsed;
}

/**
 * Read one current-surface node's facts from its session event.
 *
 * Only the four surface event types mean anything here; anything else on the
 * surface is reported as `other` rather than dropped, so a node the panel cannot
 * classify still appears in the stack with its real token price instead of
 * vanishing from the total.
 */
export function nodeFactsFromEvent(seq: number, event: unknown, toolNames?: ReadonlyMap<string, string>): NodeFacts {
	const any: any = event && typeof event === 'object' ? event : {};
	const type = typeof any.type === 'string' ? any.type : '';
	const data: any = any.data && typeof any.data === 'object' ? any.data : {};
	const turn = typeof data.turn === 'number' ? data.turn : null;
	const step = typeof data.step === 'number' ? data.step : null;

	if (type === 'tool/result') {
		const message: any = data.message ?? {};
		const blocks: any[] = Array.isArray(message.content) ? message.content : [];
		const block: any = blocks[0] ?? {};
		const callId = typeof block.toolCallId === 'string' ? block.toolCallId : null;
		const inner: unknown[] = Array.isArray(block.content) ? block.content : [];
		const text = textOfBlock(block) ?? '';
		const name = callId !== null && toolNames ? toolNames.get(callId) ?? null : null;
		return {
			seq,
			kind: 'tool-result',
			label: labelOf('tool-result', '', name ?? (callId === null ? 'tool result' : `tool ${callId}`)),
			chars: charsOfContent(inner),
			turn,
			step,
			toolName: name,
			callId,
		};
	}

	const message: any = data.message ?? (type === 'user/message' ? data : {});
	const blocks: any[] = Array.isArray(message.content) ? message.content : [];
	const chars = charsOfContent(blocks);
	if (type === 'system/message') {
		return { seq, kind: 'system', label: labelOf('system', textOfBlock(blocks[0]) ?? '', 'system prompt'), chars, turn, step, toolName: null, callId: null };
	}
	if (type === 'user/message') {
		return { seq, kind: 'user', label: labelOf('user', textOfBlock(blocks[0]) ?? '', 'user message'), chars, turn, step, toolName: null, callId: null };
	}
	if (type === 'assistant/message') {
		// One node, one colour: the bucket with the larger text share wins, and
		// the split is reported in the tooltip rather than faked as two nodes.
		let reasoningChars = 0;
		let textChars = 0;
		for (const block of blocks) {
			const text = textOfBlock(block);
			if (text === null) continue;
			if (block && (block as any).type === 'reasoning') reasoningChars += countChars(text);
			else if (block && (block as any).type === 'text') textChars += countChars(text);
		}
		const call = toolCallOf(blocks);
		const kind: StackNode['kind'] = reasoningChars > textChars ? 'reasoning' : 'assistant';
		// The label is the model's prose, never a tool call's serialized
		// arguments: an assistant message that only calls a tool is named by the
		// tool, which is what a person recognizes it by.
		const body: string[] = [];
		for (const block of blocks) {
			if (!block || (block as any).type !== 'text') continue;
			const text = textOfBlock(block);
			if (text !== null) body.push(text);
		}
		const fallback = call.name === null ? (kind === 'reasoning' ? 'reasoning step' : 'assistant reply') : `call ${call.name}`;
		return {
			seq,
			kind,
			label: labelOf(kind, body.join(' '), fallback),
			chars,
			turn,
			step,
			toolName: call.name,
			callId: call.callId,
		};
	}
	return { seq, kind: 'other', label: type.length > 0 ? type : 'unclassified node', chars, turn, step, toolName: null, callId: null };
}

/** Read a `tool/call` event's facts, or null when it is not one. */
export function callFactsFromEvent(event: unknown): CallFacts | null {
	const any: any = event && typeof event === 'object' ? event : {};
	if (any.type !== 'tool/call') return null;
	const data: any = any.data && typeof any.data === 'object' ? any.data : {};
	const callId = typeof data.callId === 'string' ? data.callId : null;
	if (callId === null) return null;
	const args = argsTextOf(data.arguments);
	return {
		callId,
		toolName: typeof data.name === 'string' && data.name.length > 0 ? data.name : 'unknown',
		turn: typeof data.turn === 'number' ? data.turn : null,
		step: typeof data.step === 'number' ? data.step : null,
		argsChars: countChars(args),
	};
}

/** Read a `tool/result` event's facts, or null when it is not one. */
export function resultFactsFromEvent(seq: number, event: unknown): ResultFacts | null {
	const any: any = event && typeof event === 'object' ? event : {};
	if (any.type !== 'tool/result') return null;
	const data: any = any.data && typeof any.data === 'object' ? any.data : {};
	const message: any = data.message ?? {};
	const block: any = Array.isArray(message.content) ? message.content[0] ?? {} : {};
	const callId = typeof block.toolCallId === 'string' ? block.toolCallId : null;
	if (callId === null) return null;
	const inner: unknown[] = Array.isArray(block.content) ? block.content : [];
	return {
		callId,
		seq,
		chars: charsOfContent(inner),
		isError: block.isError === true || (data.error !== undefined && data.error !== null),
	};
}

/** One nested sub-dispatch as the log recorded it, before start/settle pair up. */
export interface SubCallEventFacts {
	readonly subCallId: string;
	readonly parentCallId: string | null;
	readonly toolName: string;
	readonly argsChars: number;
	readonly contentChars: number;
	readonly isError: boolean;
	/** True for the settle event, which is the one that carries the outcome. */
	readonly settled: boolean;
	readonly time: number | null;
	readonly seq: number;
}

/** One nested sub-dispatch, start and settle joined. */
export interface SubCallFacts {
	readonly subCallId: string;
	/** The `run_code` call the sub-dispatch ran inside. */
	readonly parentCallId: string | null;
	readonly toolName: string;
	readonly argsChars: number;
	readonly resultChars: number;
	readonly isError: boolean;
	/** Wall-clock duration, from the two events' own times. */
	readonly durationMs: number | null;
	/** Position in dispatch order, so an unstable sort still has an order. */
	readonly order: number;
}

/**
 * Read a `tool/ptc-dispatch-start` / `tool/ptc-dispatch` event.
 *
 * These two events are log-only — the framework's `deriveMessages()` ignores
 * them, and a sub-call's content therefore never enters the model context — but
 * they are the only place the log records what actually RAN inside a `run_code`
 * program, and they carry the dispatched arguments as a JSON string. The runtime
 * waterfall's own dispatch object carries a name and no arguments; the durable
 * event carries both. Under the `min-ptc` preset this is the difference between
 * a tool table that says `run_code` three hundred times and one that says bash,
 * write and memo.
 */
export function subCallFactsFromEvent(seq: number, event: unknown): SubCallEventFacts | null {
	const any: any = event && typeof event === 'object' ? event : {};
	const type = typeof any.type === 'string' ? any.type : '';
	if (type !== 'tool/ptc-dispatch-start' && type !== 'tool/ptc-dispatch') return null;
	const data: any = any.data && typeof any.data === 'object' ? any.data : {};
	const subCallId = typeof data.subCallId === 'string' && data.subCallId.length > 0 ? data.subCallId : null;
	if (subCallId === null) return null;
	const args = argsTextOf(data.arguments);
	const content = Array.isArray(data.content) ? data.content : [];
	return {
		subCallId,
		parentCallId: typeof data.parentCallId === 'string' ? data.parentCallId : (typeof data.rootCallId === 'string' ? data.rootCallId : null),
		toolName: typeof data.name === 'string' && data.name.length > 0 ? data.name : 'unknown',
		argsChars: countChars(args),
		contentChars: charsOfContent(content),
		isError: data.isError === true || (data.error !== undefined && data.error !== null),
		settled: type === 'tool/ptc-dispatch',
		time: typeof any.time === 'number' ? any.time : null,
		seq,
	};
}

/**
 * Join each sub-dispatch's start to its settle.
 *
 * A start with no settle is a sub-call that never finished (its parent was
 * cancelled): it is kept with zero result characters rather than dropped, because
 * "this call produced nothing" is exactly what a traffic table is for.
 */
export function joinSubCalls(events: readonly SubCallEventFacts[]): SubCallFacts[] {
	const byId = new Map<string, { start: SubCallEventFacts | null; settle: SubCallEventFacts | null; order: number }>();
	for (const event of events) {
		const entry = byId.get(event.subCallId) ?? { start: null, settle: null, order: byId.size };
		if (event.settled) entry.settle = entry.settle === null ? event : entry.settle;
		else entry.start = entry.start === null ? event : entry.start;
		byId.set(event.subCallId, entry);
	}
	const subs: SubCallFacts[] = [];
	for (const [subCallId, entry] of byId) {
		const start = entry.start;
		const settle = entry.settle;
		const first = start ?? settle;
		// A duration needs BOTH ends: a start with no settle is a sub-call that
		// never finished, and reporting "0 ms" for it would be a measurement of
		// nothing dressed up as a measurement.
		const startedAt = start === null ? null : start.time;
		const endedAt = settle === null ? null : settle.time;
		subs.push({
			subCallId,
			parentCallId: first === null ? null : first.parentCallId,
			toolName: first === null ? 'unknown' : first.toolName,
			argsChars: Math.max(start === null ? 0 : start.argsChars, settle === null ? 0 : settle.argsChars),
			resultChars: settle === null ? 0 : settle.contentChars,
			isError: settle === null ? false : settle.isError,
			durationMs: startedAt === null || endedAt === null ? null : Math.max(0, endedAt - startedAt),
			order: entry.order,
		});
	}
	return subs.sort((a, b) => a.order - b.order);
}

/**
 * A sub-dispatch as a panel row: log-only, so never on the surface and never
 * priced. It inherits its parent `run_code` call's turn and step, because the
 * dispatch event itself carries neither and "which turn was this" is a filter a
 * person actually wants.
 */
export function subCallPair(sub: SubCallFacts, parent: { turn: number | null; step: number | null } | null = null): CallPair {
	return {
		callId: sub.subCallId,
		toolName: sub.toolName,
		nested: true,
		parentCallId: sub.parentCallId,
		inContext: false,
		turn: parent === null ? null : parent.turn,
		step: parent === null ? null : parent.step,
		argsChars: sub.argsChars,
		resultChars: sub.resultChars,
		resultTokens: null,
		isError: sub.isError,
		durationMs: sub.durationMs,
		over: false,
	};
}

/** What the caller knows about a call this host watched happen live. */
export interface LiveCall {
	readonly callId: string;
	readonly toolName: string;
	readonly turn: number | null;
	readonly step: number | null;
	readonly argsChars: number;
	readonly startedAt: number;
	readonly endedAt: number | null;
	readonly resultChars: number | null;
	readonly isError: boolean;
}

/**
 * Join calls to their results.
 *
 * The log is the source of truth for what is on the surface; the live watch only
 * adds the one thing the log does not carry — how long the call took. A call
 * whose result never landed (still running, or the turn was cancelled) is
 * reported with a null result rather than omitted: "this call produced nothing"
 * is exactly the kind of thing a context panel should be able to show.
 */
export function joinCalls(
	calls: readonly CallFacts[],
	results: readonly ResultFacts[],
	options: {
		readonly tokensBySeq?: ReadonlyMap<number, number>;
		readonly overResults?: ReadonlySet<string>;
		readonly durations?: ReadonlyMap<string, number>;
	} = {},
): CallPair[] {
	const byCall = new Map<string, ResultFacts>();
	for (const result of results) byCall.set(result.callId, result);
	const pairs: CallPair[] = [];
	for (const call of calls) {
		const result = byCall.get(call.callId);
		const seq = result === undefined ? null : result.seq;
		pairs.push({
			callId: call.callId,
			toolName: call.toolName,
			nested: false,
			parentCallId: null,
			inContext: result !== undefined,
			turn: call.turn,
			step: call.step,
			argsChars: call.argsChars,
			resultChars: result === undefined ? 0 : result.chars,
			resultTokens: seq === null || options.tokensBySeq === undefined ? null : options.tokensBySeq.get(seq) ?? null,
			isError: result === undefined ? false : result.isError,
			durationMs: options.durations?.get(call.callId) ?? null,
			over: options.overResults?.has(call.callId) ?? false,
		});
	}
	return pairs;
}

/** Combine live-watch facts with the log's own call/result facts. */
export function liveCallFacts(live: readonly LiveCall[]): { calls: CallFacts[]; results: ResultFacts[]; durations: Map<string, number> } {
	const calls: CallFacts[] = [];
	const results: ResultFacts[] = [];
	const durations = new Map<string, number>();
	for (const call of live) {
		calls.push({ callId: call.callId, toolName: call.toolName, turn: call.turn, step: call.step, argsChars: call.argsChars });
		if (call.endedAt !== null) durations.set(call.callId, Math.max(0, call.endedAt - call.startedAt));
	}
	return { calls, results, durations };
}

/**
 * The composition buckets, in draw order.
 *
 * `prefix` is what the request carries that no surface node accounts for: the
 * tool schemas, the request framing, and whatever the meter's per-node prices
 * left unaccounted for. The system prompt is NOT in here: a system/message event
 * is a surface node with its own price and its own bucket below. It is derived
 * by SUBTRACTION, because the measurement's own baseline
 * is a whole-request anchor (the framework's meter defines
 * `total = max(0, baseline + surfaceDelta)`), so using it directly as the prefix
 * would count the entire surface a second time — which is exactly what this panel
 * did before, and why its legend used to add up to 183%.
 *
 * The surface figure is the meter's own when it priced anything, and the sum of
 * the nodes' own prices otherwise (a meter that is absent or unpriced must not
 * turn every node into "prefix"). Either way the buckets add up to the total the
 * panel prints at the top.
 */
export function compositionOf(
	totalTokens: number,
	surfaceTokens: number,
	stack: readonly StackNode[],
): CompositionBucket[] {
	const nodeSum = stack.reduce((sum, node) => sum + node.tokens, 0);
	const surface = surfaceTokens > 0 ? surfaceTokens : nodeSum;
	const buckets: Record<string, number> = {
		prefix: Math.max(0, totalTokens - surface),
		system: 0,
		user: 0,
		assistant: 0,
		reasoning: 0,
		'tool-result': 0,
		other: 0,
	};
	for (const node of stack) {
		const key = node.kind === 'tool-result' ? 'tool-result' : node.kind;
		buckets[key] = (buckets[key] ?? 0) + node.tokens;
	}
	return [
		{ key: 'prefix', label: 'Fixed request overhead', tokens: buckets.prefix },
		{ key: 'tool-result', label: 'Tool results', tokens: buckets['tool-result'] },
		{ key: 'assistant', label: 'Assistant output', tokens: buckets.assistant },
		{ key: 'reasoning', label: 'Reasoning (CoT)', tokens: buckets.reasoning },
		{ key: 'user', label: 'User messages', tokens: buckets.user },
		{ key: 'system', label: 'System prompt', tokens: buckets.system },
		{ key: 'other', label: 'Other', tokens: buckets.other },
	];
}

/** The slice of a session this module is allowed to read. */
export interface SessionSlice {
	readonly id: string;
	readonly cwd: string | null;
	readonly surfaceNodes: readonly number[];
	readonly requestContext: { provider: string | null; model: string | null; contextWindow: number | null } | null;
}

/** The slice of a token measurement this module is allowed to read. */
export interface MeasurementSlice {
	readonly baselineKind: 'none' | 'estimated' | 'usage';
	readonly baselineTokens: number;
	readonly totalTokens: number;
	readonly surfaceTokens: number;
	readonly surfaceDeltaTokens: number;
	readonly nodes: ReadonlyMap<number, number>;
}

/** Everything a snapshot is built from. */
export interface SnapshotInput {
	readonly session: SessionSlice;
	readonly measurement: MeasurementSlice | null;
	readonly measurementError?: string;
	readonly stack: readonly StackNode[];
	readonly calls: readonly CallPair[];
	readonly interventions: readonly Intervention[];
	readonly config: ContextConfig;
	readonly policies: Record<PolicyKind, string>;
}

/** Assemble the one value the panel draws. */
export function buildSnapshot(input: SnapshotInput): ContextSnapshot {
	const measurement = input.measurement;
	const baselineTokens = measurement === null ? 0 : measurement.baselineTokens;
	return {
		sessionId: input.session.id,
		cwd: input.session.cwd,
		provider: input.session.requestContext === null ? null : input.session.requestContext.provider,
		model: input.session.requestContext === null ? null : input.session.requestContext.model,
		contextWindow: input.session.requestContext === null ? null : input.session.requestContext.contextWindow,
		totals: {
			tokens: measurement === null ? 0 : measurement.totalTokens,
			surfaceTokens: measurement === null ? 0 : measurement.surfaceTokens,
			surfaceDeltaTokens: measurement === null ? 0 : measurement.surfaceDeltaTokens,
			baselineTokens,
			baselineKind: measurement === null ? 'none' : measurement.baselineKind,
			nodes: input.stack.length,
			calls: input.calls.filter((call) => !call.nested).length,
			subCalls: input.calls.filter((call) => call.nested).length,
		},
		composition: compositionOf(
			measurement === null ? 0 : measurement.totalTokens,
			measurement === null ? 0 : measurement.surfaceTokens,
			input.stack,
		),
		stack: input.stack,
		// No precomputed ranking is sent: the panel's query sorts and groups, and
		// shipping a second copy of the same rows for it to ignore would be the
		// duplication this panel was rebuilt to remove. `topN` is now the page size.
		calls: input.calls,
		interventions: input.interventions,
		config: input.config,
		policies: input.policies,
		policyOptions: [...POLICY_NAMES],
		...(input.measurementError === undefined ? {} : { measurementError: input.measurementError }),
	};
}



/**
 * A bounded, newest-first log of interventions.
 *
 * Bounded because it is the one thing this plugin accumulates while a long
 * session runs: an unbounded log would itself become the leak the plugin exists
 * to prevent.
 */
export class InterventionLog {
	private readonly entries: Intervention[] = [];
	private limit: number;

	constructor(limit: number) {
		this.limit = Math.max(10, limit);
	}

	setLimit(limit: number): void {
		this.limit = Math.max(10, Math.floor(limit));
		this.trim();
	}

	record(intervention: Intervention): void {
		this.entries.push(intervention);
		this.trim();
	}

	/** Newest first, which is the order the panel reads. */
	list(): Intervention[] {
		return [...this.entries].reverse();
	}

	count(): number {
		return this.entries.length;
	}

	private trim(): void {
		const excess = this.entries.length - this.limit;
		if (excess > 0) this.entries.splice(0, excess);
	}
}
