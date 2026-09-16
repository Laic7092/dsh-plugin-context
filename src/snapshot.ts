/**
 * dsh-plugin-context — reading one session into the panel's model.
 *
 * `measure.ts` is pure arithmetic over facts; this file is the adapter that
 * reads those facts out of a live session, and it is the only place that touches
 * a session object. It reads through a narrow `SessionReader` interface rather
 * than the `Session` class for two reasons: a test can hand it a plain object,
 * and the set of things this plugin is allowed to look at is written down in one
 * place instead of scattered through the host half.
 *
 * Two boundaries are deliberate.
 *
 * **The stack is the surface, not the log.** What a context panel should show is
 * what the next request will carry, and the surface is exactly that set — a
 * compaction that removed forty messages should make the stack shorter, not
 * leave forty ghosts in it.
 *
 * **The call table reads the log, bounded.** A tool call's arguments and its
 * result are two events, and the call itself is not on the surface at all, so
 * the table walks a bounded window of the log (the last `LOG_WINDOW` events)
 * instead of a whole session. A call whose result is no longer on the surface
 * keeps a null `resultTokens`, which the panel shows as "no longer in context"
 * rather than as zero.
 *
 * @module dsh-plugin-context/snapshot
 */
import { estimateTokens, callFactsFromEvent, charsOfContent, joinCalls, resultFactsFromEvent, nodeFactsFromEvent, type CallFacts, type ResultFacts } from './measure.ts';
import type { CallPair, ContextConfig, PolicyKind, StackNode } from './types.ts';

/** How many of a session's most recent events the call table walks. */
export const LOG_WINDOW = 1_200;

/** The slice of a live session this module reads. */
export interface SessionReader {
	readonly id: string;
	readonly cwd: string | null;
	/** The session log's current length, used to bound the window. */
	readonly seq: number;
	/** The surface: the sequence numbers the next request will carry, in order. */
	readonly surface: readonly number[];
	eventAt(seq: number): unknown;
	/** The last `limit` events of the log, oldest first. */
	recentEvents(limit: number): readonly unknown[];
	/** Provider/model/window in force, when the session knows them. */
	requestContext(): unknown;
}

/** The measured pressure of one session, in the narrow shape this plugin uses. */
export interface MeasurementReader {
	readonly baselineKind: 'none' | 'estimated' | 'usage';
	readonly baselineTokens: number;
	readonly totalTokens: number;
	readonly surfaceTokens: number;
	readonly surfaceDeltaTokens: number;
	/** Official token price per surface node. */
	readonly nodes: ReadonlyMap<number, number>;
}

/** Which budget applies to which kind of node. */
export function budgetKindOf(node: StackNode): PolicyKind | null {
	if (node.kind === 'tool-result') return 'tool-result';
	if (node.kind === 'reasoning') return 'reasoning';
	if (node.kind === 'assistant') return 'output';
	return null;
}

/** True when a node's own text exceeds the budget of the kind it belongs to. */
export function overBudget(node: StackNode, config: ContextConfig): boolean {
	const kind = budgetKindOf(node);
	if (kind === null) return false;
	const kindConfig = config.kinds[kind];
	if (!kindConfig.enabled || kindConfig.maxChars <= 0) return false;
	return node.chars > kindConfig.maxChars;
}

/**
 * Build the stack from the session's surface.
 *
 * A node the measurement does not price falls back to the plugin's own estimate
 * so it is never invisible; the fallback is why `tokens` and the panel's per-node
 * numbers can disagree with the exact total, and the panel says so.
 */
export function collectStack(reader: SessionReader, measurement: MeasurementReader | null, config: ContextConfig): StackNode[] {
	const toolNames = new Map<string, string>();
	for (const event of reader.recentEvents(LOG_WINDOW)) {
		const call = callFactsFromEvent(event);
		if (call !== null) toolNames.set(call.callId, call.toolName);
	}

	const stack: StackNode[] = [];
	for (const seq of reader.surface) {
		const event = reader.eventAt(seq);
		if (event === undefined || event === null) continue;
		const facts = nodeFactsFromEvent(seq, event, toolNames);
		const priced = measurement === null ? undefined : measurement.nodes.get(seq);
		const node: StackNode = {
			seq: facts.seq,
			kind: facts.kind,
			label: facts.label,
			tokens: priced === undefined ? estimateTokens(facts.chars) : priced,
			chars: facts.chars,
			turn: facts.turn,
			step: facts.step,
			toolName: facts.toolName,
			callId: facts.callId,
			over: false,
		};
		stack.push({ ...node, over: overBudget(node, config) });
	}
	return stack;
}

/** Walk the log window and return every tool call and tool result it holds. */
export function collectCallFacts(reader: SessionReader): { calls: CallFacts[]; results: ResultFacts[] } {
	const calls: CallFacts[] = [];
	const results: ResultFacts[] = [];
	for (const event of reader.recentEvents(LOG_WINDOW)) {
		const call = callFactsFromEvent(event);
		if (call !== null) {
			calls.push(call);
			continue;
		}
		const seq = (event as any)?.seq;
		if (typeof seq !== 'number') continue;
		const result = resultFactsFromEvent(seq, event);
		if (result !== null) results.push(result);
	}
	return { calls, results };
}

/** The call pairs the panel ranks, joined and priced. */
export function collectCalls(
	reader: SessionReader,
	measurement: MeasurementReader | null,
	config: ContextConfig,
	durations: ReadonlyMap<string, number> = new Map(),
): CallPair[] {
	const { calls, results } = collectCallFacts(reader);
	const tokensBySeq = measurement === null ? new Map<number, number>() : measurement.nodes;
	const overResults = new Set<string>();
	const budget = config.kinds['tool-result'];
	if (budget.enabled && budget.maxChars > 0) {
		for (const result of results) if (result.chars > budget.maxChars) overResults.add(result.callId);
	}
	return joinCalls(calls, results, { tokensBySeq, overResults, durations });
}

/**
 * Read the current request context without assuming a shape.
 *
 * Every field is optional in a live session — a fresh one has no request header
 * yet — so a missing value becomes null and the panel omits the window instead
 * of showing a zero that looks like a full context.
 */
export function readRequestContext(raw: unknown): { provider: string | null; model: string | null; contextWindow: number | null } | null {
	if (raw === null || raw === undefined || typeof raw !== 'object') return null;
	const any: any = raw;
	return {
		provider: typeof any.provider === 'string' ? any.provider : null,
		model: typeof any.model === 'string' ? any.model : null,
		contextWindow: typeof any.contextWindow === 'number' && any.contextWindow > 0 ? any.contextWindow : null,
	};
}

/**
 * Read a live measurement into the narrow shape, tolerating a partial one.
 *
 * This is the boundary between the framework's own `TokenMeasurement` and this
 * plugin's model, and the two do not agree on one field: the live measurement
 * hands over `nodes` as an **array** of `{seq, tokens}`, while everything
 * downstream wants to price a node by looking it up. Normalizing here — and
 * only here — is what keeps the rest of the plugin from having to know.
 *
 * A measurement that is missing, partial, or shaped differently degrades into
 * null rather than into a zero, so the panel can say "unmeasured" instead of
 * drawing a confident empty context.
 */
export function readMeasurement(raw: unknown): MeasurementReader | null {
	if (raw === null || raw === undefined || typeof raw !== 'object') return null;
	const any: any = raw;
	const nodes = new Map<number, number>();
	const rawNodes: unknown = any.nodes;
	if (Array.isArray(rawNodes)) {
		for (const node of rawNodes) {
			const seq = node && typeof (node as any).seq === 'number' ? (node as any).seq : null;
			const tokens = node && typeof (node as any).tokens === 'number' ? (node as any).tokens : null;
			if (seq !== null && tokens !== null) nodes.set(seq, tokens);
		}
	} else if (rawNodes !== null && rawNodes !== undefined && typeof (rawNodes as any).entries === 'function') {
		// Already normalized (or a Map-shaped stand-in, as the tests use).
		for (const [seq, tokens] of (rawNodes as any).entries()) {
			if (typeof seq === 'number' && typeof tokens === 'number') nodes.set(seq, tokens);
		}
	}
	const baseline: any = any.baseline ?? {};
	const kind = baseline.kind === 'usage' || baseline.kind === 'estimated' ? baseline.kind : 'none';
	return {
		baselineKind: kind,
		baselineTokens: typeof baseline.tokens === 'number' ? baseline.tokens : 0,
		totalTokens: typeof any.totalTokens === 'number' ? any.totalTokens : 0,
		surfaceTokens: typeof any.surfaceTokens === 'number' ? any.surfaceTokens : 0,
		surfaceDeltaTokens: typeof any.surfaceDeltaTokens === 'number' ? any.surfaceDeltaTokens : 0,
		nodes,
	};
}

/**
 * Adapter from a live session object to `SessionReader`.
 *
 * Every read is defensive: this plugin observes a session that another part of
 * the host owns, and a shape it does not recognize must degrade into "nothing to
 * show" rather than into a failed turn.
 */
export function sessionReaderOf(session: unknown): SessionReader | null {
	if (session === null || session === undefined || typeof session !== 'object') return null;
	const any: any = session;
	let id = '';
	try {
		id = typeof any.id === 'string' ? any.id : '';
	} catch {
		return null;
	}
	if (id.length === 0) return null;

	const header: any = (() => {
		try {
			return any.header ?? {};
		} catch {
			return {};
		}
	})();

	const surface = (() => {
		try {
			const nodes = any.surface?.nodes;
			return Array.isArray(nodes) ? nodes.filter((seq: unknown) => typeof seq === 'number') : [];
		} catch {
			return [];
		}
	})();

	return {
		id,
		cwd: typeof header.cwd === 'string' ? header.cwd : null,
		seq: (() => {
			try {
				return typeof any.seq === 'number' ? any.seq : 0;
			} catch {
				return 0;
			}
		})(),
		surface,
		eventAt(seq: number) {
			try {
				return any.eventAt(seq);
			} catch {
				return undefined;
			}
		},
		recentEvents(limit: number) {
			try {
				if (typeof any.recentEvents === 'function') {
					const events = any.recentEvents(limit);
					return Array.isArray(events) ? events : [];
				}
				const end = typeof any.seq === 'number' ? any.seq : 0;
				const from = Math.max(0, end - limit);
				if (typeof any.snapshotEvents === 'function') {
					const events = any.snapshotEvents(from, end);
					return Array.isArray(events) ? events : [];
				}
				return [];
			} catch {
				return [];
			}
		},
		requestContext() {
			try {
				return typeof any.requestContext === 'function' ? any.requestContext() : undefined;
			} catch {
				return undefined;
			}
		},
	};
}

/** The chars of one tool-result's content, for the live interception path. */
export function charsOfResultContent(content: readonly unknown[]): number {
	return charsOfContent(content);
}
