/**
 * dsh-plugin-context — the policy registry.
 *
 * The whole point of this file is the line `export const identity: Policy =
 * (input) => input`. The plugin is *able* to manage context before it decides
 * anything about what context to manage: every hook is registered, every
 * measurement is taken, every rewrite path is exercised and reversible, and the
 * decision itself is this one function until somebody replaces it.
 *
 * A policy is registered by name so the panel can say which one is in force and
 * so the interventions log reads as a sentence. Registration is process-wide
 * state on purpose: a policy is code, not session data, and swapping one at
 * runtime is the same act as editing this file.
 *
 * `applyPolicy` is the only place that turns a policy's answer back into
 * content, and it refuses anything a policy should not be able to do:
 *
 *  - it may not add blocks, renumber them, or change a block's type;
 *  - it may not invent text for a block that carried none (an image's bytes are
 *    not its business);
 *  - a refusal is reported as an intervention with an `error` and the original
 *    content is returned untouched.
 *
 * A policy that throws is treated exactly like a policy that answered
 * nonsense: the call it was watching proceeds with the original content. A
 * context manager that can break the turn it is managing would be worse than no
 * context manager at all.
 *
 * @module dsh-plugin-context/policies
 */
import type { Intervention, Policy, PolicyBlock, PolicyInput, PolicyKind, PolicyOutput } from './types.ts';

/**
 * The default for every kind: hand the input straight back.
 *
 * It is a real policy, not a sentinel — the host cannot tell it apart from any
 * other no-op, which is the property that makes "no strategy implemented yet"
 * and "a strategy that decided to keep everything" cost the same.
 */
export const identity: Policy = (input) => input;

/** How a policy's answer was turned into content, or why it was refused. */
export interface PolicyApplication {
	/** The blocks to use: the policy's text/drops applied, everything else original. */
	readonly blocks: readonly unknown[];
	/** True when at least one text changed or one block was dropped. */
	readonly changed: boolean;
	/** Code points after the policy ran. */
	readonly charsAfter: number;
	/** Set when the answer was refused and the original content was kept. */
	readonly error?: string;
}

/** Count Unicode code points, the unit every budget in this plugin uses. */
export function codePoints(text: string): number {
	return [...text].length;
}

/** One registered policy and the name it logs under. */
interface Registration {
	readonly name: string;
	readonly policy: Policy;
}

/** The registry: one slot per kind, identity until replaced. */
export class PolicyRegistry {
	private readonly slots = new Map<PolicyKind, Registration>();

	constructor() {
		for (const kind of ['tool-result', 'reasoning', 'output'] as const) {
			this.slots.set(kind, { name: 'identity', policy: identity });
		}
	}

	/** Replace one kind's policy. A blank name is refused rather than guessed. */
	set(kind: PolicyKind, policy: Policy, name = 'custom'): () => void {
		if (typeof policy !== 'function') throw new TypeError(`policy for ${kind} must be a function`);
		const previous = this.slots.get(kind) ?? { name: 'identity', policy: identity };
		this.slots.set(kind, { name: typeof name === 'string' && name.length > 0 ? name : 'custom', policy });
		return () => {
			this.slots.set(kind, previous);
		};
	}

	/** The policy in force, or the identity when a kind was never set. */
	get(kind: PolicyKind): Registration {
		return this.slots.get(kind) ?? { name: 'identity', policy: identity };
	}

	/** The names in force, for the panel and the boot log. */
	names(): Record<PolicyKind, string> {
		return {
			'tool-result': this.get('tool-result').name,
			reasoning: this.get('reasoning').name,
			output: this.get('output').name,
		};
	}
}

/**
 * Explain one content block to a policy.
 *
 * `raw` is handed over deliberately: a policy is host-side code that already
 * has the process, so pretending it cannot see the block would be theatre. What
 * the *panel* sees is a different matter, and it never sees `raw`.
 */
export function describeBlocks(blocks: readonly unknown[]): PolicyBlock[] {
	const described: PolicyBlock[] = [];
	for (let index = 0; index < blocks.length; index += 1) {
		const block: any = blocks[index];
		const type = block && typeof block.type === 'string' ? block.type : 'unknown';
		const text = block && typeof block.text === 'string' ? block.text : null;
		described.push({
			index,
			type,
			text,
			chars: text === null ? 0 : codePoints(text),
			raw: block,
		});
	}
	return described;
}

/**
 * Run one policy and rebuild the content it was shown.
 *
 * Everything the policy did not change is taken from `raw`, so a policy that
 * only wanted to shorten a summary cannot accidentally drop an image or clear an
 * error flag it never looked at.
 */
export function applyPolicyBlocks(
	original: readonly unknown[],
	answer: PolicyOutput | undefined | null,
): PolicyApplication {
	const before = describeBlocks(original);
	if (answer === undefined || answer === null || typeof answer !== 'object') {
		return { blocks: original, changed: false, charsAfter: totalChars(before), error: 'policy returned nothing usable' };
	}
	const answered = Array.isArray(answer.blocks) ? answer.blocks : null;
	if (answered === null) {
		return { blocks: original, changed: false, charsAfter: totalChars(before), error: 'policy returned no blocks array' };
	}

	const rebuilt: unknown[] = [];
	let changed = false;
	for (const block of answered) {
		const index = block && typeof block.index === 'number' ? block.index : -1;
		const source = index >= 0 && index < original.length ? before[index] : undefined;
		if (source === undefined) {
			return { blocks: original, changed: false, charsAfter: totalChars(before), error: `policy referenced block ${String(index)}, which it was never shown` };
		}
		if (block.type !== source.type) {
			return { blocks: original, changed: false, charsAfter: totalChars(before), error: `policy changed block ${index} from ${source.type} to ${String(block.type)}` };
		}
		if (block.drop === true) {
			// A non-text block is the only carrier of something the host cannot
			// re-derive (an image's attachment, a tool call's id). Dropping one is
			// allowed only for content the policy could actually read.
			if (source.text === null) {
				return { blocks: original, changed: false, charsAfter: totalChars(before), error: `policy tried to drop the non-text block ${index} (${source.type})` };
			}
			changed = true;
			continue;
		}
		if (block.text === null || block.text === undefined) {
			rebuilt.push(source.raw);
			continue;
		}
		if (typeof block.text !== 'string') {
			return { blocks: original, changed: false, charsAfter: totalChars(before), error: `policy gave block ${index} a non-string text` };
		}
		if (source.text === null) {
			return { blocks: original, changed: false, charsAfter: totalChars(before), error: `policy gave block ${index} (${source.type}) text it did not have` };
		}
		if (block.text !== source.text) {
			changed = true;
			rebuilt.push({ ...(source.raw as any), text: block.text });
			continue;
		}
		rebuilt.push(source.raw);
	}

	const after = describeBlocks(rebuilt);
	return { blocks: rebuilt, changed, charsAfter: totalChars(after) };
}

/** Code points across the text-bearing blocks of a described set. */
export function totalChars(blocks: readonly PolicyBlock[]): number {
	let total = 0;
	for (const block of blocks) total += block.chars;
	return total;
}

/** One policy run: what to use, and the line the panel records. */
export interface PolicyRun {
	readonly application: PolicyApplication;
	readonly intervention: Intervention;
}

/**
 * Run one registered policy and never throw.
 *
 * This is the function the host half calls, and its contract is the plugin's
 * safety property: whatever a policy does — throw, return a promise that
 * rejects, answer with a structure it was never allowed to build — the call it
 * was watching proceeds with its original content, and the refusal is visible in
 * the panel as an intervention carrying an `error`.
 */
export async function runPolicy(
	entry: { name: string; policy: Policy },
	input: PolicyInput,
	time: number = Date.now(),
	applied: boolean = true,
): Promise<PolicyRun> {
	const original = input.blocks.map((block) => block.raw);
	let answer: PolicyOutput | undefined;
	let thrown: string | undefined;
	try {
		answer = (await entry.policy(input)) as PolicyOutput;
	} catch (error: any) {
		thrown = error && typeof error.message === 'string' ? error.message : String(error);
	}
	if (thrown !== undefined) {
		const application: PolicyApplication = {
			blocks: original,
			changed: false,
			charsAfter: input.chars,
			error: `policy threw: ${thrown}`,
		};
		return { application, intervention: interventionFor(input, entry.name, application, time, applied) };
	}
	const application = applyPolicyBlocks(original, answer);
	return { application, intervention: interventionFor(input, entry.name, application, time, applied) };
}

/** The intervention line for one application, ready for the log and the panel. */
export function interventionFor(
	input: PolicyInput,
	policyName: string,
	application: PolicyApplication,
	time: number,
	applied: boolean = true,
): Intervention {
	const blocksAfter = application.blocks.length;
	return {
		time,
		kind: input.kind,
		policy: policyName,
		reason: input.reason,
		sessionId: input.sessionId,
		callId: input.callId,
		toolName: input.toolName,
		turn: input.turn,
		step: input.step,
		charsBefore: input.chars,
		charsAfter: application.charsAfter,
		blocksBefore: input.blocks.length,
		blocksAfter,
		changed: application.changed,
		applied,
		...(application.error === undefined ? {} : { error: application.error }),
	};
}

/**
 * Head/tail trimming, as an opt-in demonstrator policy.
 *
 * Not registered by default — the shipped default for every kind is `identity`,
 * and this factory is what a person reaches for when they want to see the
 * pipeline actually move bytes. It is deliberately local and dependency-free
 * rather than a wrapper around the framework's own `toolResultPruner`, so that
 * reading this one function tells you exactly what will happen to your content.
 *
 * Every text-bearing block over the budget keeps its first `keep * 0.7` and its
 * last `keep * 0.6` code points, with a marker between them. A block within
 * budget is handed back untouched, and non-text blocks are never described here
 * at all, so images and tool-call payloads survive on the `raw` path.
 */
export function headTailTrim(options: { headChars?: number; tailChars?: number; marker?: string } = {}): Policy {
	const marker = typeof options.marker === 'string' && options.marker.length > 0 ? options.marker : '\n\n[... trimmed ...]\n\n';
	const markerChars = codePoints(marker);
	return (input) => {
		const keep = input.maxChars > 0 ? input.maxChars : input.chars;
		// A marker that does not fit inside the budget leaves no room to trim:
		// replacing one long block with a marker and two stubs would make the
		// content *longer* than it was, which is worse than doing nothing.
		if (markerChars >= keep) return input;
		const room = keep - markerChars;
		const head = Math.max(0, Math.floor(options.headChars ?? Math.floor(room * 0.7)));
		const tail = Math.max(0, Math.floor(options.tailChars ?? (room - Math.min(room, head))));
		let touched = false;
		const blocks = input.blocks.map((block) => {
			if (block.text === null || block.chars <= keep) return block;
			const points = [...block.text];
			const text = points.slice(0, Math.min(head, points.length)).join('')
				+ marker
				+ points.slice(Math.max(0, points.length - tail)).join('');
			// The one invariant this policy must never break: what it returns is
			// smaller than what it was given. Anything else is refused here rather
			// than handed to the guard, which would read it as "keep everything".
			if (codePoints(text) >= points.length) return block;
			touched = true;
			return { ...block, text };
		});
		return touched ? { ...input, blocks } : input;
	};
}

/**
 * The policies a configuration may name, by name.
 *
 * `identity` is the default everywhere. `head-tail` is the one demonstrator that
 * ships: it exists so that the rewrite pipeline can be seen to move bytes
 * without anyone having to write code first, and it stays off until a
 * configuration or the panel names it.
 *
 * Adding a strategy is adding one entry here (or calling `PolicyRegistry.set`
 * from your own host code) — the pipeline itself does not change.
 */
export const BUILT_IN_POLICIES: Record<string, () => Policy> = {
	identity: () => identity,
	'head-tail': () => headTailTrim(),
};

/** The names a configuration may ask for. */
export const POLICY_NAMES: readonly string[] = Object.keys(BUILT_IN_POLICIES);

/** Build a named policy, falling back to the identity for an unknown name. */
export function policyFor(name: unknown): { name: string; policy: Policy } {
	const wanted = typeof name === 'string' ? name : 'identity';
	const factory = BUILT_IN_POLICIES[wanted];
	if (factory === undefined) return { name: 'identity', policy: identity };
	return { name: wanted, policy: factory() };
}
