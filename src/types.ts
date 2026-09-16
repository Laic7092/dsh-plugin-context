/**
 * dsh-plugin-context — the shared vocabulary of the whole plugin.
 *
 * Two rules shape this file.
 *
 * **A policy is `(input) => input`.** The pipeline that can rewrite context is
 * built first and completely; what to rewrite is a separate, replaceable
 * decision that ships as the identity function. Everything a policy may look at
 * is a plain, owned value — never a live Cordis/DSH object — so a policy can be
 * written by someone who has never read the framework, and the panel can show
 * exactly what the policy saw.
 *
 * **Nothing here is a framework type.** The host half deliberately does not
 * import `@deepseek-ai/dsh-*`: the shapes it touches (a tool result's content
 * blocks, one surface node's token price) are declared here as the narrow slices
 * this plugin actually reads, so a framework upgrade cannot turn into a build
 * break, and the package carries no peer dependency to resolve.
 *
 * @module dsh-plugin-context/types
 */

/** Which part of the context a policy is being asked about. */
export type PolicyKind = 'tool-result' | 'reasoning' | 'output';

/** Every kind, in the order the panel lists them. */
export const POLICY_KINDS: readonly PolicyKind[] = ['tool-result', 'reasoning', 'output'];

/**
 * One content block offered to a policy.
 *
 * `text` is the only field a policy is allowed to change. It is non-null
 * exactly for the block types whose payload is text (`text`, `reasoning`), and
 * `raw` carries the untouched original so the host can put back every field the
 * policy did not touch — an image's attachment ref or a tool-result's error flag
 * must survive a rewrite that only meant to shorten a summary.
 */
export interface PolicyBlock {
	/** Position in the original content array. A policy may not renumber. */
	readonly index: number;
	/** The wire block type: `text`, `reasoning`, `image`, `file`, … */
	readonly type: string;
	/** The block's text, or null when this block carries no text payload. */
	readonly text: string | null;
	/** Unicode code points of `text` (0 for a non-text block). */
	readonly chars: number;
	/** The original block, opaque to a policy. Never serialized. */
	readonly raw: unknown;
	/**
	 * Set by a policy to remove this block from the result. The default
	 * (false/undefined) keeps it exactly as it arrived.
	 */
	drop?: boolean;
}

/**
 * What a policy is given, and — because a policy returns this same shape — how
 * it answers. The default policy returns its argument unchanged, so "no policy
 * yet" and "a policy that declined" are the same event and cost nothing to
 * detect (the host compares the returned `blocks` by identity).
 */
export interface PolicyInput {
	readonly kind: PolicyKind;
	/** Session the content belongs to, when the caller knew one. */
	readonly sessionId: string | null;
	readonly turn: number | null;
	readonly step: number | null;
	/** Tool call being answered; null for a message-shaped input. */
	readonly callId: string | null;
	readonly toolName: string | null;
	readonly blocks: readonly PolicyBlock[];
	/** Total Unicode code points across the text-bearing blocks. */
	readonly chars: number;
	/** The host's token price for this content at the moment it was offered. */
	readonly tokens: number;
	/** The configured budget for this kind, in code points. */
	readonly maxChars: number;
	/** True when `chars` exceeds `maxChars`. */
	readonly over: boolean;
	/** Why the policy is running. `manual` is the panel's own button. */
	readonly reason: 'threshold' | 'manual';
}

/** A policy answers with the input, possibly with blocks shortened or dropped. */
export type PolicyOutput = PolicyInput;

/** A replaceable decision about one piece of context. */
export type Policy = (input: PolicyInput) => PolicyOutput | Promise<PolicyOutput>;

/** One policy applied to one piece of content, as the panel reports it. */
export interface Intervention {
	readonly time: number;
	readonly kind: PolicyKind;
	/** The policy's registered name, for the log line. */
	readonly policy: string;
	readonly reason: 'threshold' | 'manual';
	readonly sessionId: string | null;
	readonly callId: string | null;
	readonly toolName: string | null;
	readonly turn: number | null;
	readonly step: number | null;
	readonly charsBefore: number;
	readonly charsAfter: number;
	readonly blocksBefore: number;
	readonly blocksAfter: number;
	/** False when the policy ran and chose to change nothing. */
	readonly changed: boolean;
	/**
	 * True when the change actually reached the request. False in `report` mode,
	 * where the policy is run as a dry run so the panel can say what it *would*
	 * have saved without a single byte moving.
	 */
	readonly applied: boolean;
	/** Set when the policy threw or answered an unusable shape. */
	readonly error?: string;
}

/** Per-kind budget and switch, as the panel edits it. */
export interface KindConfig {
	/** Whether the hook runs at all for this kind. */
	readonly enabled: boolean;
	/** The budget in Unicode code points. 0 disables the trigger. */
	readonly maxChars: number;
	/**
	 * What an over-budget measurement does. `report` records it and leaves the
	 * content alone; `rewrite` also runs the kind's policy.
	 */
	readonly onOver: 'report' | 'rewrite';
}

/** The plugin's whole live configuration. */
export interface ContextConfig {
	/** Master switch: off means the hooks are not even registered. */
	readonly enabled: boolean;
	readonly kinds: Readonly<Record<PolicyKind, KindConfig>>;
	/**
	 * The policy in force per kind, by name.
	 *
	 * A name rather than a function because this value has to survive a
	 * configuration file, a JSON round trip through the panel, and a restart —
	 * and because the panel must be able to say which strategy is running
	 * without being handed code.
	 */
	readonly policies: Readonly<Record<PolicyKind, string>>;
	/** Ring-buffer size for the interventions log. */
	readonly logLimit: number;
	/** How many nodes the panel ranks. */
	readonly topN: number;
}

/** One surface node — one thing the next request will carry. */
export interface StackNode {
	readonly seq: number;
	/** Coarse bucket the panel colours by. */
	readonly kind: 'system' | 'user' | 'assistant' | 'reasoning' | 'tool-result' | 'other';
	/** Short human label: the tool name, or the message's opening words. */
	readonly label: string;
	/** Official token price for this node. */
	readonly tokens: number;
	/** Code points of its text payload, as measured here. */
	readonly chars: number;
	readonly turn: number | null;
	readonly step: number | null;
	readonly toolName: string | null;
	readonly callId: string | null;
	/** True when this node's own budget was exceeded when it was offered. */
	readonly over: boolean;
}

/** One tool call and the result that answered it, joined by call id. */
export interface CallPair {
	readonly callId: string;
	readonly toolName: string;
	readonly turn: number | null;
	readonly step: number | null;
	/** Code points of the serialized arguments. */
	readonly argsChars: number;
	/** Code points of the result's text payload. */
	readonly resultChars: number;
	/** The result node's official token price, when it is still on the surface. */
	readonly resultTokens: number | null;
	readonly isError: boolean;
	/** Wall-clock duration, when this host watched the call happen live. */
	readonly durationMs: number | null;
	/** True when the result exceeded the tool-result budget. */
	readonly over: boolean;
}

/** The composition bar's buckets, in draw order. */
export interface CompositionBucket {
	readonly key: string;
	readonly label: string;
	readonly tokens: number;
}

/** Everything the panel draws, in one owned JSON value. */
export interface ContextSnapshot {
	readonly sessionId: string | null;
	readonly cwd: string | null;
	readonly provider: string | null;
	readonly model: string | null;
	/** The model's window, when the session's request context knows one. */
	readonly contextWindow: number | null;
	/** Officially measured pressure. */
	readonly totals: {
		readonly tokens: number;
		readonly surfaceTokens: number;
		readonly surfaceDeltaTokens: number;
		readonly baselineTokens: number;
		readonly baselineKind: 'none' | 'estimated' | 'usage';
		readonly nodes: number;
	};
	readonly composition: readonly CompositionBucket[];
	readonly stack: readonly StackNode[];
	readonly calls: readonly CallPair[];
	/** The largest entries, ranked on the host so the panel does not re-sort. */
	readonly top: {
		readonly nodes: readonly StackNode[];
		readonly calls: readonly CallPair[];
	};
	readonly interventions: readonly Intervention[];
	readonly config: ContextConfig;
	/** Registered policy names, so the panel can say what would run. */
	readonly policies: Readonly<Record<PolicyKind, string>>;
	/** Every policy this build offers, so the panel's picker cannot drift. */
	readonly policyOptions: readonly string[];
	/** Why measurement is unavailable, when it is. */
	readonly measurementError?: string;
}
