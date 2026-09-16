/**
 * dsh-plugin-context — the control pipeline.
 *
 * This class is the answer to "can this plugin manage context?" and it is
 * deliberately independent of Cordis: it is handed the slices it needs, it
 * returns decisions, and the host half in `index.ts` does nothing but wire it to
 * real events. Every rule about *when* the plugin is allowed to act lives here,
 * which is why the whole safety story can be read — and tested — in one file.
 *
 * **What is always on, and cannot change anything.** One emit listener records
 * how long each tool call took and how large its result was. Emit listeners
 * cannot alter a result, so this half of the plugin is observation by
 * construction.
 *
 * **What is armed only when you ask.** Both seams that can rewrite content are
 * registered by the host only while the corresponding kind is set to `rewrite`:
 *
 *  - `tools/post-execute` + `tools/ptc-dispatch-log` for a tool result — the
 *    only two places a result can be shaped before it becomes durable. The PTC
 *    seam matters here: under the `min-ptc` preset most tool calls are
 *    sub-dispatches inside `run_code`, and a plugin that only hooked
 *    `post-execute` would watch them all go by.
 *  - `llm/stream` for reasoning and output — generation-time, because a
 *    committed `assistant/message` can never be surface-replaced. Capping is the
 *    only honest control over over-long CoT, and a stream that is not capped
 *    cannot be edited afterwards.
 *
 * A deployment that leaves every kind on the shipped `report` default therefore
 * runs with no listener anywhere on a mutating path. That is the property that
 * makes a plugin whose strategies are not written yet safe to install.
 *
 * **`report` is a dry run, not a no-op.** In `report` mode an over-budget item
 * still runs its policy, and the answer is recorded with `applied: false`. The
 * panel can then say "this policy would have removed 18 400 characters" without
 * a single byte having moved. The policy is user code and may have side effects;
 * that is documented rather than hidden, and it is the price of a preview that
 * cannot lie.
 *
 * @module dsh-plugin-context/control
 */
import { applyPatch, cloneConfig, resolveConfig } from './config.ts';
import { InterventionLog, buildSnapshot } from './measure.ts';
import { PolicyRegistry, codePoints, describeBlocks, policyFor, runPolicy, totalChars } from './policies.ts';
import {
	collectCalls,
	collectStack,
	readMeasurement,
	readRequestContext,
	sessionReaderOf,
	type MeasurementReader,
	type SessionReader,
} from './snapshot.ts';
import { replaceToolResultContent, type SurfaceDeps, type SurfaceWrite } from './surface.ts';
import { POLICY_KINDS, type ContextConfig, type ContextSnapshot, type Intervention, type PolicyInput, type PolicyKind, type StackNode } from './types.ts';

/** What one live tool call looks like while it is in flight. */
export interface LiveToolCall {
	readonly callId: string;
	readonly toolName: string;
	readonly argsChars: number;
	readonly startedAt: number;
	endedAt: number | null;
	resultChars: number | null;
	isError: boolean;
}

/** One decision the pipeline made about a piece of context. */
export interface RewriteDecision {
	/** The content to use instead of what was offered. */
	readonly content: readonly unknown[];
	readonly intervention: Intervention;
}

/** The outcome of a manual intervention on an already-landed node. */
export interface NodeIntervention {
	readonly ok: boolean;
	/** False when the policy ran and chose to keep everything. */
	readonly changed: boolean;
	readonly seq?: number;
	readonly error?: string;
	readonly intervention?: Intervention;
}

/**
 * One node's dry run, with the policy's answer still in hand.
 *
 * `blocks` is host-side only: it carries references to live content and is never
 * part of a response body.
 */
export interface NodePreview extends NodeIntervention {
	readonly blocks?: readonly unknown[];
}

/** One selection's outcome: every row, plus the totals the panel leads with. */
export interface BatchIntervention {
	readonly ok: boolean;
	readonly rows: readonly NodeIntervention[];
	readonly totals: {
		readonly nodes: number;
		readonly changed: number;
		readonly refused: number;
		readonly charsBefore: number;
		readonly charsAfter: number;
	};
}

/** How many nodes one batch request may carry. Enforced host-side. */
export const BATCH_LIMIT = 100;

/** Read a scalar leaf off a live object, or the fallback. */
function leaf<T>(read: () => T, fallback: T): T {
	try {
		const value = read();
		return value === undefined || value === null ? fallback : value;
	} catch {
		return fallback;
	}
}

/** Code points of a tool call's parsed arguments, as the model wrote them. */
export function argumentsChars(args: unknown): number {
	try {
		const serialized = typeof args === 'string' ? args : JSON.stringify(args);
		return typeof serialized === 'string' ? codePoints(serialized) : 0;
	} catch {
		// A cyclic or otherwise unserializable argument set is not this plugin's
		// problem to report; it simply has no character count.
		return 0;
	}
}

export interface ControlOptions {
	/** The composition's `config:` block. */
	readonly config?: unknown;
	readonly policies?: PolicyRegistry;
	readonly now?: () => number;
	readonly note?: (message: string) => void;
}

export class ContextControl {
	private config: ContextConfig;
	readonly policies: PolicyRegistry;
	private readonly interventions: InterventionLog;
	private readonly now: () => number;
	private readonly note: (message: string) => void;
	/** Calls seen live, newest last, bounded by the log limit. */
	private readonly live = new Map<string, LiveToolCall>();
	/** Block index → text accumulated for a pending stream decision. */
	private readonly streamBuffers = new Map<string, string>();

	constructor(options: ControlOptions = {}) {
		this.config = resolveConfig(options.config);
		this.policies = options.policies ?? new PolicyRegistry();
		this.interventions = new InterventionLog(this.config.logLimit);
		this.now = options.now ?? (() => Date.now());
		this.note = options.note ?? (() => undefined);
		this.reloadPolicies();
	}

	/**
	 * Install the configured policy names into the registry.
	 *
	 * Separate from `patch` so that the host can call it at boot and after a
	 * configuration change, and so that a strategy installed programmatically
	 * through `policies.set` survives a configuration that does not name one.
	 */
	reloadPolicies(): void {
		for (const kind of POLICY_KINDS) {
			const built = policyFor(this.config.policies[kind]);
			if (built.name === 'identity' && this.config.policies[kind] !== 'identity') {
				this.note(`unknown policy ${JSON.stringify(this.config.policies[kind])} for ${kind}: using identity`);
			}
			this.policies.set(kind, built.policy, built.name);
		}
	}

	/** The configuration in force, as an owned copy. */
	configuration(): ContextConfig {
		return cloneConfig(this.config);
	}

	/** The interventions log, newest first. */
	log(): Intervention[] {
		return this.interventions.list();
	}

	/** The calls currently being watched live, for the panel's duration column. */
	liveCalls(): LiveToolCall[] {
		return [...this.live.values()];
	}

	/** True when the tool-result seams must be armed. */
	needsToolResultSeam(): boolean {
		return this.config.enabled && this.config.kinds['tool-result'].enabled && this.config.kinds['tool-result'].onOver === 'rewrite';
	}

	/** True when the generation-time guard must be armed. */
	needsStreamSeam(): boolean {
		if (!this.config.enabled) return false;
		const output = this.config.kinds.output;
		const reasoning = this.config.kinds.reasoning;
		return (output.enabled && output.onOver === 'rewrite') || (reasoning.enabled && reasoning.onOver === 'rewrite');
	}

	/** Apply a configuration patch; `rearm` is true when the seams must move. */
	patch(patch: unknown): { ok: boolean; config: ContextConfig; error?: string; rearm: boolean } {
		const posture = () => `${this.needsToolResultSeam() ? 'tool' : '-'}/${this.needsStreamSeam() ? 'stream' : '-'}`;
		const before = posture();
		const result = applyPatch(this.config, patch);
		if (!result.ok) return { ...result, rearm: false };
		this.config = result.config;
		this.interventions.setLimit(this.config.logLimit);
		this.reloadPolicies();
		const after = posture();
		return { ok: true, config: cloneConfig(this.config), rearm: before !== after };
	}

	// ---------------------------------------------------------------- watching

	/** Record the start of a tool call. Observe-only; never affects the call. */
	startCall(exec: unknown): void {
		if (!this.config.enabled) return;
		const any: any = exec ?? {};
		const callId = leaf(() => (typeof any.callId === 'string' ? any.callId : ''), '');
		if (callId.length === 0) return;
		this.remember({
			callId,
			toolName: leaf(() => (typeof any.name === 'string' && any.name.length > 0 ? any.name : 'unknown'), 'unknown'),
			argsChars: argumentsChars(leaf(() => any.arguments, undefined)),
			startedAt: this.now(),
			endedAt: null,
			resultChars: null,
			isError: false,
		});
	}

	/**
	 * Record the end of a tool call, and — in `report` mode only — run the kind's
	 * policy as a dry run so the panel can show what a rewrite would have saved.
	 *
	 * In `rewrite` mode the decision was already taken upstream by a seam that
	 * could actually apply it, so running the policy again here would double-count
	 * the intervention.
	 */
	async finishCall(exec: unknown, result: unknown): Promise<void> {
		if (!this.config.enabled) return;
		const any: any = exec ?? {};
		const callId = leaf(() => (typeof any.callId === 'string' ? any.callId : ''), '');
		if (callId.length === 0) return;
		const content = leaf<readonly unknown[]>(() => (Array.isArray((result as any)?.content) ? (result as any).content : []), []);
		const isError = leaf(() => (result as any)?.isError === true, false);
		const previous = this.live.get(callId);
		const call: LiveToolCall = {
			callId,
			toolName: previous?.toolName ?? leaf(() => (typeof any.name === 'string' && any.name.length > 0 ? any.name : 'unknown'), 'unknown'),
			argsChars: previous?.argsChars ?? argumentsChars(leaf(() => any.arguments, undefined)),
			startedAt: previous?.startedAt ?? this.now(),
			endedAt: this.now(),
			resultChars: totalChars(describeBlocks(content)),
			isError,
		};
		this.remember(call);

		const kindConfig = this.config.kinds['tool-result'];
		if (!kindConfig.enabled || kindConfig.onOver !== 'report') return;
		await this.dryRun('tool-result', call.resultChars ?? 0, {
			sessionId: this.sessionIdOf(exec),
			callId,
			toolName: call.toolName,
			content,
		});
	}

	private sessionIdOf(exec: unknown): string | null {
		return leaf(() => {
			const session = (exec as any)?.agent?.session;
			const id = session?.id ?? session?.header?.id;
			return typeof id === 'string' && id.length > 0 ? id : null;
		}, null);
	}

	/** Keep the live map from growing without bound. */
	private remember(call: LiveToolCall): void {
		this.live.delete(call.callId);
		this.live.set(call.callId, call);
		const excess = this.live.size - Math.max(50, this.config.logLimit);
		if (excess > 0) {
			let removed = 0;
			for (const key of this.live.keys()) {
				this.live.delete(key);
				removed += 1;
				if (removed >= excess) break;
			}
		}
	}

	// --------------------------------------------------------------- deciding

	/** Build the value a policy sees for one piece of content. */
	buildInput(
		kind: PolicyKind,
		meta: { sessionId: string | null; callId?: string | null; toolName?: string | null; turn?: number | null; step?: number | null },
		content: readonly unknown[],
		reason: 'threshold' | 'manual',
	): PolicyInput {
		const blocks = describeBlocks(content);
		const chars = totalChars(blocks);
		const kindConfig = this.config.kinds[kind];
		return {
			kind,
			sessionId: meta.sessionId ?? null,
			turn: meta.turn ?? null,
			step: meta.step ?? null,
			callId: meta.callId ?? null,
			toolName: meta.toolName ?? null,
			blocks,
			chars,
			// The official meter prices surface nodes, not pre-append content, so
			// this is the same documented estimate the panel uses per item.
			tokens: Math.ceil(chars / 4),
			maxChars: kindConfig.maxChars,
			over: kindConfig.maxChars > 0 && chars > kindConfig.maxChars,
			reason,
		};
	}

	/** Run a policy for the record only; nothing is applied. */
	private async dryRun(
		kind: PolicyKind,
		chars: number,
		meta: { sessionId: string | null; callId?: string | null; toolName?: string | null; content: readonly unknown[] },
	): Promise<Intervention | null> {
		const kindConfig = this.config.kinds[kind];
		if (!kindConfig.enabled || kindConfig.maxChars <= 0 || chars <= kindConfig.maxChars) return null;
		const input = this.buildInput(kind, meta, meta.content, 'threshold');
		const run = await runPolicy(this.policies.get(kind), input, this.now(), false);
		this.interventions.record(run.intervention);
		return run.intervention;
	}

	/**
	 * Decide the content of a tool result that has not been committed yet.
	 *
	 * Returns null whenever nothing should change — within budget, the seam is
	 * not armed, or the policy declined — so the caller can hand the untouched
	 * decision straight back to the framework.
	 */
	async decideToolResult(
		exec: unknown,
		content: readonly unknown[],
		isError: boolean,
	): Promise<RewriteDecision | null> {
		if (!this.needsToolResultSeam()) return null;
		const any: any = exec ?? {};
		// A nested dispatch under `run_code` is committed through the PTC log seam
		// instead; handling it here as well would rewrite the same result twice.
		if (leaf(() => any.parent !== undefined, false)) return null;
		const kindConfig = this.config.kinds['tool-result'];
		const chars = totalChars(describeBlocks(content));
		if (kindConfig.maxChars <= 0 || chars <= kindConfig.maxChars) return null;

		const input = this.buildInput(
			'tool-result',
			{
				sessionId: this.sessionIdOf(exec),
				callId: leaf(() => (typeof any.callId === 'string' ? any.callId : null), null),
				toolName: leaf(() => (typeof any.name === 'string' ? any.name : null), null),
			},
			content,
			'threshold',
		);
		const run = await runPolicy(this.policies.get('tool-result'), input, this.now(), true);
		this.interventions.record(run.intervention);
		if (!run.application.changed) return null;
		// An error result is left alone unless the policy deliberately touched it:
		// its content is often the only diagnosis the model will get.
		void isError;
		return { content: run.application.blocks, intervention: run.intervention };
	}

	/**
	 * Decide the durable content of one `run_code` sub-dispatch.
	 *
	 * The dispatch carries no parsed arguments, so the call's own argument size is
	 * recorded as unknown rather than invented.
	 */
	async decidePtcDispatch(dispatch: unknown): Promise<RewriteDecision | null> {
		if (!this.needsToolResultSeam()) return null;
		const any: any = dispatch ?? {};
		const content = leaf<readonly unknown[]>(() => (Array.isArray(any.content) ? any.content : []), []);
		const kindConfig = this.config.kinds['tool-result'];
		const chars = totalChars(describeBlocks(content));
		if (kindConfig.maxChars <= 0 || chars <= kindConfig.maxChars) return null;
		const input = this.buildInput(
			'tool-result',
			{
				sessionId: this.sessionIdOf({ agent: leaf(() => any.agent, undefined) }),
				callId: leaf(() => (typeof any.subCallId === 'string' ? any.subCallId : null), null),
				toolName: leaf(() => (typeof any.name === 'string' ? any.name : null), null),
			},
			content,
			'threshold',
		);
		const run = await runPolicy(this.policies.get('tool-result'), input, this.now(), true);
		this.interventions.record(run.intervention);
		if (!run.application.changed) return null;
		return { content: run.application.blocks, intervention: run.intervention };
	}

	// ---------------------------------------------------------------- stream

	/**
	 * The generation-time guard for reasoning and output.
	 *
	 * Streaming means text already handed to the surface cannot be recalled, so
	 * the only enforceable decision is where to stop. The contract therefore is:
	 * the first time a block crosses its budget the policy is asked once for the
	 * text that block should have, and the difference between what was already
	 * emitted and the length of that answer is emitted before the block is closed.
	 * The identity policy answers with everything it was shown, which means the
	 * block continues — that is what makes the default a genuine no-op rather than
	 * a silent cap.
	 *
	 * Nothing else is touched: tool-call deltas, usage, block boundaries and the
	 * finish chunk pass through untouched, because a context manager that breaks
	 * the model call it is watching is worse than none.
	 */
	async *guardStream(source: AsyncIterable<unknown>): AsyncIterable<unknown> {
		if (!this.needsStreamSeam()) {
			yield* source;
			return;
		}
		/** Per block: code points already emitted, and whether the policy answered. */
		const emitted = new Map<number, number>();
		const settled = new Set<number>();
		const stopped = new Set<number>();

		for await (const chunk of source) {
			const any: any = chunk;
			const type = leaf(() => (typeof any?.type === 'string' ? any.type : ''), '');
			const index = leaf(() => (typeof any.index === 'number' ? any.index : 0), 0);
			if (type === 'block-end') this.streamBuffers.delete(String(index));
			const kind: PolicyKind | null = type === 'text-delta' ? 'output' : type === 'reasoning-delta' ? 'reasoning' : null;
			if (kind === null) {
				yield chunk;
				continue;
			}
			if (stopped.has(index)) continue;

			const text = leaf(() => (typeof any.text === 'string' ? any.text : ''), '');
			const points = [...text];
			const already = emitted.get(index) ?? 0;
			const kindConfig = this.config.kinds[kind];
			const budget = kindConfig.enabled ? kindConfig.maxChars : 0;

			if (settled.has(index)) {
				// The policy already allowed this block to continue.
				emitted.set(index, already + points.length);
				yield chunk;
				continue;
			}

			const buffered = (this.streamBuffers.get(String(index)) ?? '') + text;
			if (budget <= 0 || already + points.length <= budget) {
				// Still inside the budget: pass it through and keep the block's text
				// so the policy can be shown the whole thing when it crosses. The
				// buffer can therefore never exceed one budget plus one delta.
				this.streamBuffers.set(String(index), buffered);
				emitted.set(index, already + points.length);
				yield chunk;
				continue;
			}

			// First crossing: ask the policy once, and show it the whole block.
			const input = this.buildInput(kind, { sessionId: null }, [{ type: 'text', text: buffered }], 'threshold');
			const run = await runPolicy(this.policies.get(kind), input, this.now(), true);
			this.interventions.record(run.intervention);
			this.streamBuffers.delete(String(index));
			settled.add(index);

			const allowed = totalChars(describeBlocks(run.application.blocks));
			if (allowed >= already + points.length) {
				// Identity: the policy kept everything it was shown, so the block
				// continues and is never consulted again.
				emitted.set(index, already + points.length);
				yield chunk;
				continue;
			}
			const slice = Math.max(0, allowed - already);
			emitted.set(index, already + slice);
			stopped.add(index);
			if (slice === 0) continue;
			yield { ...any, text: points.slice(0, slice).join('') };
		}
	}

	// ----------------------------------------------------------------- panel

	/** Build the value the panel draws for one session. */
	snapshotFor(session: unknown, measurement: unknown, error?: string): ContextSnapshot {
		const reader: SessionReader | null = sessionReaderOf(session);
		// The live measurement's own shape is normalized here, once, rather than
		// assumed by every consumer: the framework hands over an array of priced
		// nodes, and this plugin looks prices up by node.
		const measured: MeasurementReader | null = readMeasurement(measurement);
		if (reader === null) {
			return buildSnapshot({
				session: { id: '', cwd: null, surfaceNodes: [], requestContext: null },
				measurement: null,
				measurementError: error ?? 'no live session to measure',
				stack: [],
				calls: [],
				interventions: this.log(),
				config: this.config,
				policies: this.policies.names(),
			});
		}
		const stack: StackNode[] = collectStack(reader, measured, this.config);
		const durations = new Map<string, number>();
		for (const call of this.live.values()) {
			if (call.endedAt !== null) durations.set(call.callId, Math.max(0, call.endedAt - call.startedAt));
		}
		const calls = collectCalls(reader, measured, this.config, durations);
		return buildSnapshot({
			session: {
				id: reader.id,
				cwd: reader.cwd,
				surfaceNodes: reader.surface,
				requestContext: readRequestContext(reader.requestContext()),
			},
			measurement: measured,
			...(error === undefined ? {} : { measurementError: error }),
			stack,
			calls,
			interventions: this.log(),
			config: this.config,
			policies: this.policies.names(),
		});
	}

	/**
	 * Run a policy against content that is already in the surface, WITHOUT
	 * writing and without logging.
	 *
	 * This is the one place a node is read and priced, so both the per-row action
	 * and the batch preview are the same arithmetic: a preview that could disagree
	 * with the write it precedes would be worse than no preview at all. The returned
	 * `blocks` are host-side only — they hold references to live content and must
	 * never be serialized.
	 */
	async previewOnNode(deps: SurfaceDeps, seq: number, kind: PolicyKind = 'tool-result'): Promise<NodePreview> {
		if (!this.config.enabled) return { ok: false, changed: false, error: 'context control is switched off' };
		let event: any;
		let derived: any;
		try {
			event = deps.session?.eventAt?.(seq);
			derived = event === undefined || event === null ? null : deps.session?.deriveEventMessage?.(event);
		} catch (error: any) {
			return { ok: false, changed: false, error: `reading node ${seq} failed: ${error?.message ?? String(error)}` };
		}
		if (derived === null || derived === undefined) return { ok: false, changed: false, error: `node ${seq} is not in this session's surface` };
		const block: any = Array.isArray(derived.content) ? derived.content[0] : undefined;
		if (block === null || block === undefined || block.type !== 'tool-result') {
			return { ok: false, changed: false, error: `node ${seq} is not a tool result` };
		}
		const content: readonly unknown[] = Array.isArray(block.content) ? block.content : [];
		const input = this.buildInput(
			kind,
			{
				sessionId: leaf(() => (typeof deps.session?.id === 'string' ? deps.session.id : null), null),
				callId: leaf(() => (typeof block.toolCallId === 'string' ? block.toolCallId : null), null),
				toolName: null,
				turn: leaf(() => (typeof event?.data?.turn === 'number' ? event.data.turn : null), null),
				step: leaf(() => (typeof event?.data?.step === 'number' ? event.data.step : null), null),
			},
			content,
			'manual',
		);
		const run = await runPolicy(this.policies.get(kind), input, this.now(), false);
		return { ok: true, changed: run.application.changed, intervention: run.intervention, blocks: run.application.blocks };
	}

	/**
	 * Run a policy against content that is already in the surface and, if it
	 * changed anything, commit the replacement.
	 *
	 * With the shipped identity policy this is a no-op by construction, which is
	 * exactly right: the mechanism is present and inert until a strategy exists.
	 */
	async interveneOnNode(deps: SurfaceDeps, seq: number, kind: PolicyKind = 'tool-result'): Promise<NodeIntervention> {
		const preview = await this.previewOnNode(deps, seq, kind);
		const intervention = preview.intervention;
		if (intervention === undefined) {
			return { ok: preview.ok, changed: false, ...(preview.error === undefined ? {} : { error: preview.error }) };
		}
		if (!preview.changed) {
			this.interventions.record(intervention);
			return { ok: true, changed: false, intervention };
		}
		const write: SurfaceWrite = replaceToolResultContent(deps, seq, preview.blocks ?? []);
		const applied: Intervention = { ...intervention, applied: write.ok };
		this.interventions.record(applied);
		if (!write.ok) return { ok: false, changed: true, error: write.error, intervention: applied };
		return { ok: true, changed: true, seq: write.seq, intervention: applied };
	}

	/**
	 * Price a whole selection at once, writing nothing and logging nothing.
	 *
	 * This is the projection the panel puts above its batch buttons: "these N
	 * nodes would give back M characters". In `report` posture it is also the whole
	 * story — the arithmetic is the same one a rewrite would use, and not a byte
	 * moves.
	 */
	async previewNodes(deps: SurfaceDeps, seqs: readonly number[], kind: PolicyKind = 'tool-result'): Promise<BatchIntervention> {
		return this.runBatch(seqs, (seq) => this.previewOnNode(deps, seq, kind));
	}

	/** Apply the same policy over a selection, one node at a time. */
	async interveneOnNodes(deps: SurfaceDeps, seqs: readonly number[], kind: PolicyKind = 'tool-result'): Promise<BatchIntervention> {
		return this.runBatch(seqs, async (seq) => {
			const outcome = await this.interveneOnNode(deps, seq, kind);
			return { ...outcome, blocks: undefined };
		});
	}

	/**
	 * Walk a selection and total it up.
	 *
	 * Every row is kept, refusals included: the host refuses a node that is not a
	 * tool result, one that left the surface, or a write the session rejected, and
	 * a batch that reported only its successes would be lying about what happened.
	 * The limit is enforced here rather than trusted from the caller.
	 */
	private async runBatch(seqs: readonly number[], run: (seq: number) => Promise<NodePreview>): Promise<BatchIntervention> {
		const wanted = Array.isArray(seqs) ? seqs.filter((seq) => typeof seq === 'number' && Number.isFinite(seq)).slice(0, BATCH_LIMIT) : [];
		const rows: NodeIntervention[] = [];
		let charsBefore = 0;
		let charsAfter = 0;
		let changed = 0;
		let refused = 0;
		for (const seq of wanted) {
			const outcome = await run(seq);
			const intervention = outcome.intervention;
			rows.push({
				ok: outcome.ok,
				changed: outcome.changed,
				...(outcome.seq === undefined ? {} : { seq: outcome.seq }),
				...(outcome.error === undefined ? {} : { error: outcome.error }),
				...(intervention === undefined ? {} : { intervention }),
			});
			if (intervention === undefined) {
				refused += 1;
				continue;
			}
			charsBefore += intervention.charsBefore;
			charsAfter += intervention.changed ? intervention.charsAfter : intervention.charsBefore;
			if (outcome.changed) changed += 1;
		}
		return { ok: true, rows, totals: { nodes: wanted.length, changed, refused, charsBefore, charsAfter } };
	}

	/** One line for the boot log, so the active posture is never a mystery. */
	describe(): string {
		const names = this.policies.names();
		const armed = [
			this.needsToolResultSeam() ? 'tool-result' : null,
			this.config.kinds.reasoning.enabled && this.config.kinds.reasoning.onOver === 'rewrite' ? 'reasoning' : null,
			this.config.kinds.output.enabled && this.config.kinds.output.onOver === 'rewrite' ? 'output' : null,
		].filter((entry): entry is string => entry !== null);
		return [
			`watching ${this.config.enabled ? 'on' : 'off'}`,
			`budgets tool-result=${this.config.kinds['tool-result'].maxChars} reasoning=${this.config.kinds.reasoning.maxChars} output=${this.config.kinds.output.maxChars}`,
			`policies ${names['tool-result']}/${names.reasoning}/${names.output}`,
			armed.length === 0 ? 'nothing is armed to rewrite (report-only)' : `armed to rewrite: ${armed.join(', ')}`,
		].join('; ');
	}
}
