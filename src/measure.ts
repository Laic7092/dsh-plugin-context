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
		return { seq, kind: 'system', label: labelOf('system', textOfBlock(blocks[0]) ?? '', 'injected context'), chars, turn, step, toolName: null, callId: null };
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
	const args = typeof data.arguments === 'string' ? data.arguments : '';
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

/** The composition buckets, in draw order, from measured nodes. */
export function compositionOf(
	baselineTokens: number,
	stack: readonly StackNode[],
): CompositionBucket[] {
	const buckets: Record<string, number> = {
		prefix: baselineTokens,
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
		{ key: 'prefix', label: 'System prompt & tool schemas', tokens: buckets.prefix },
		{ key: 'tool-result', label: 'Tool results', tokens: buckets['tool-result'] },
		{ key: 'assistant', label: 'Assistant output', tokens: buckets.assistant },
		{ key: 'reasoning', label: 'Reasoning (CoT)', tokens: buckets.reasoning },
		{ key: 'user', label: 'User messages', tokens: buckets.user },
		{ key: 'system', label: 'Injected context', tokens: buckets.system },
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
		},
		composition: compositionOf(baselineTokens, input.stack),
		stack: input.stack,
		calls: input.calls,
		top: {
			nodes: rankByTokens(input.stack, input.config.topN),
			calls: rankCalls(input.calls, input.config.topN),
		},
		interventions: input.interventions,
		config: input.config,
		policies: input.policies,
		policyOptions: [...POLICY_NAMES],
		...(input.measurementError === undefined ? {} : { measurementError: input.measurementError }),
	};
}

/** Rank the largest entries of one list, largest first, ties by the given key. */
export function rankByTokens<T extends { tokens: number }>(items: readonly T[], topN: number): T[] {
	return [...items].sort((a, b) => b.tokens - a.tokens).slice(0, Math.max(1, topN));
}

/** Rank call pairs by the bytes they moved through the context. */
export function rankCalls(calls: readonly CallPair[], topN: number): CallPair[] {
	return [...calls]
		.sort((a, b) => b.resultChars + b.argsChars - (a.resultChars + a.argsChars))
		.slice(0, Math.max(1, topN));
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
