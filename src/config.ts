/**
 * dsh-plugin-context — configuration defaults and the patch validator.
 *
 * Defaults are chosen so that installing the plugin changes nothing about a
 * session except that it becomes visible. Every hook is on, every budget is
 * generous, and `onOver` starts at `report`: an over-budget tool result is
 * recorded, priced and shown in the panel, and left exactly where it was. The
 * switch that turns a report into a rewrite is one click in the panel, and the
 * policy behind that rewrite is still the identity — so the honest state of this
 * plugin on a fresh profile is "it watches, and it can act whenever you say so".
 *
 * The validator is the only gate between a panel/form input and the live hooks.
 * It rejects rather than coerces: a threshold that is not a number is a bug in
 * the caller, and silently turning it into 0 would look like a budget that
 * blocks everything.
 *
 * @module dsh-plugin-context/config
 */
import { POLICY_NAMES } from './policies.ts';
import { POLICY_KINDS, type ContextConfig, type KindConfig, type PolicyKind } from './types.ts';

/** The shipped budgets, in Unicode code points. */
export const DEFAULTS: ContextConfig = {
	enabled: true,
	kinds: {
		'tool-result': { enabled: true, maxChars: 24_000, onOver: 'report' },
		reasoning: { enabled: true, maxChars: 16_000, onOver: 'report' },
		output: { enabled: true, maxChars: 16_000, onOver: 'report' },
	},
	policies: {
		'tool-result': 'identity',
		reasoning: 'identity',
		output: 'identity',
	},
	logLimit: 200,
	topN: 12,
};

/** How many code points a budget may be set to. */
const MAX_BUDGET = 4_000_000;

function isPlainObject(value: unknown): boolean {
	return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function budget(value: unknown, fallback: number): number {
	if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
	const rounded = Math.floor(value);
	if (rounded < 0) return 0;
	return rounded > MAX_BUDGET ? MAX_BUDGET : rounded;
}

/** Clone a config so callers cannot mutate the one in force. */
export function cloneConfig(config: ContextConfig): ContextConfig {
	return {
		enabled: config.enabled,
		kinds: {
			'tool-result': { ...config.kinds['tool-result'] },
			reasoning: { ...config.kinds.reasoning },
			output: { ...config.kinds.output },
		},
		policies: { ...config.policies },
		logLimit: config.logLimit,
		topN: config.topN,
	};
}

/** Resolve a composition's `config:` block into a whole config. */
export function resolveConfig(raw: unknown): ContextConfig {
	if (!isPlainObject(raw)) return cloneConfig(DEFAULTS);
	const input: any = raw;
	return applyPatch(DEFAULTS, input).config;
}

/** A validated patch, or the reason it was refused. */
export interface PatchResult {
	readonly ok: boolean;
	readonly config: ContextConfig;
	readonly error?: string;
}

/**
 * The mutable working copy a patch is applied to.
 *
 * The public `ContextConfig` is readonly so that a caller cannot reach into the
 * config in force; this local alias is what the one function allowed to build a
 * new one writes to, and it is structurally assignable back to `ContextConfig`.
 */
interface MutableKindConfig {
	enabled: boolean;
	maxChars: number;
	onOver: 'report' | 'rewrite';
}

interface MutableConfig {
	enabled: boolean;
	kinds: Record<PolicyKind, MutableKindConfig>;
	policies: Record<PolicyKind, string>;
	logLimit: number;
	topN: number;
}

function mutableFrom(config: ContextConfig): MutableConfig {
	return {
		enabled: config.enabled,
		kinds: {
			'tool-result': { ...config.kinds['tool-result'] },
			reasoning: { ...config.kinds.reasoning },
			output: { ...config.kinds.output },
		},
		policies: { ...config.policies },
		logLimit: config.logLimit,
		topN: config.topN,
	};
}

/**
 * Apply one patch to a config.
 *
 * Unknown keys are ignored on purpose: a composition written for a later version
 * of this plugin should still boot on this one. Known keys with a wrong type are
 * an error, because the caller meant something and it is not what would happen.
 */
export function applyPatch(current: ContextConfig, patch: unknown): PatchResult {
	const next = mutableFrom(current);
	/**
	 * Refuse the whole patch.
	 *
	 * The working copy may already carry earlier keys of a patch that later
	 * turned out to be wrong; handing that back would leave the caller with a
	 * config that is half in force, which is worse than one that was rejected
	 * outright. A refusal always answers with the config that is still in force.
	 */
	const refuse = (error: string): PatchResult => ({ ok: false, config: mutableFrom(current), error });
	if (!isPlainObject(patch)) return refuse('patch must be an object');
	const input: any = patch;

	if (input.enabled !== undefined) {
		if (typeof input.enabled !== 'boolean') return refuse('enabled must be a boolean');
		next.enabled = input.enabled;
	}
	if (input.logLimit !== undefined) {
		if (typeof input.logLimit !== 'number' || !Number.isFinite(input.logLimit)) {
			return refuse('logLimit must be a number');
		}
		next.logLimit = Math.max(10, Math.min(2_000, Math.floor(input.logLimit)));
	}
	if (input.topN !== undefined) {
		if (typeof input.topN !== 'number' || !Number.isFinite(input.topN)) {
			return refuse('topN must be a number');
		}
		next.topN = Math.max(3, Math.min(50, Math.floor(input.topN)));
	}
	if (input.policies !== undefined) {
		if (!isPlainObject(input.policies)) return refuse('policies must be an object');
		for (const key of Object.keys(input.policies)) {
			if (!POLICY_KINDS.includes(key as PolicyKind)) return refuse(`unknown policy slot ${JSON.stringify(key)}`);
		}
		for (const kind of POLICY_KINDS) {
			const wanted = (input.policies as any)[kind];
			if (wanted === undefined) continue;
			if (typeof wanted !== 'string') return refuse(`policies.${kind} must be a policy name`);
			if (!POLICY_NAMES.includes(wanted)) {
				return refuse(`policies.${kind} must be one of ${POLICY_NAMES.join(', ')}`);
			}
			next.policies[kind] = wanted;
		}
	}
	if (input.kinds !== undefined) {
		if (!isPlainObject(input.kinds)) return refuse('kinds must be an object');
		for (const key of Object.keys(input.kinds)) {
			if (!POLICY_KINDS.includes(key as PolicyKind)) {
				return refuse(`unknown kind ${JSON.stringify(key)}`);
			}
		}
		for (const kind of POLICY_KINDS) {
			const rawKind = (input.kinds as any)[kind];
			if (rawKind === undefined) continue;
			if (!isPlainObject(rawKind)) return refuse(`kinds.${kind} must be an object`);
			const writable: MutableKindConfig = { ...next.kinds[kind] };
			if (rawKind.enabled !== undefined) {
				if (typeof rawKind.enabled !== 'boolean') return refuse(`kinds.${kind}.enabled must be a boolean`);
				writable.enabled = rawKind.enabled;
			}
			if (rawKind.maxChars !== undefined) {
				if (typeof rawKind.maxChars !== 'number' || !Number.isFinite(rawKind.maxChars)) {
					return refuse(`kinds.${kind}.maxChars must be a number`);
				}
				writable.maxChars = budget(rawKind.maxChars, writable.maxChars);
			}
			if (rawKind.onOver !== undefined) {
				if (rawKind.onOver !== 'report' && rawKind.onOver !== 'rewrite') {
					return refuse(`kinds.${kind}.onOver must be "report" or "rewrite"`);
				}
				writable.onOver = rawKind.onOver;
			}
			next.kinds[kind] = writable;
		}
	}
	return { ok: true, config: next };
}
