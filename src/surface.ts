/**
 * dsh-plugin-context — the one durable write this plugin can perform.
 *
 * Everything else in this package observes or decides; this file commits. It is
 * kept small, explicit and separate for that reason: the single operation that
 * changes a session that was already written should be readable in one sitting.
 *
 * The operation is the framework's own, copied from the shipped tool-result
 * pruner rather than invented here. Rewriting a landed tool result means
 *
 *   1. appending a `compaction/prune` shadow-price event for the node about to be
 *      shadowed, synchronously and immediately before the replacement, so the
 *      token meter can fold the difference in O(1) instead of repricing the
 *      whole surface; then
 *   2. appending a `tool/result` event whose durable data is the original data
 *      with only `message` swapped, carrying `surfaceOp: { op: 'replace', … }`
 *      over exactly that one node and citing it in `sourceEventSeqs`.
 *
 * Three framework rules dictate the shape, and each one is enforced here as a
 * refusal rather than left to a thrown error from deep inside a session:
 *
 *  - a replacement must shadow at least one node and must cite every node it
 *    shadows in `sourceEventSeqs`;
 *  - a `tool/result` replacement may differ from the original in **nothing** but
 *    `message.content[0].content` — turn, step, error and meta are preserved by
 *    spreading the original data, never rebuilt;
 *  - the shadow price needs a token meter. Without one the replacement is
 *    refused, because an unpriced replacement silently drifts the meter's fold,
 *    and a wrong number on the composer's ring is worse than a trim that did not
 *    happen.
 *
 * There is deliberately no attempt to rewrite an `assistant/message`: the
 * framework forbids it (an assistant message may never carry `sourceEventSeqs`,
 * and a replacement must cover every node it shadows). Over-long reasoning is
 * bounded at generation time instead — see the stream guard in `control.ts`.
 *
 * @module dsh-plugin-context/surface
 */
import { codePoints } from './policies.ts';

/** What a commit needs from the live session and its meter. */
export interface SurfaceDeps {
	/** The live Session: `eventAt`, `deriveEventMessage`, `append`. */
	readonly session: any;
	/** The live token meter: `estimateMessage`. */
	readonly tokenMeter: any;
}

/** The outcome of one commit attempt. */
export interface SurfaceWrite {
	readonly ok: boolean;
	/** Sequence of the replacement event, when one landed. */
	readonly seq?: number;
	readonly error?: string;
}

function problem(message: string): SurfaceWrite {
	return { ok: false, error: message };
}

/** The tool-result block of a derived message, or null when it is not one. */
export function toolResultBlockOf(message: unknown): any | null {
	const any: any = message;
	if (any === null || any === undefined || typeof any !== 'object') return null;
	const blocks: any[] = Array.isArray(any.content) ? any.content : [];
	const block = blocks[0];
	if (block === null || typeof block !== 'object' || block.type !== 'tool-result') return null;
	return block;
}

/** Code points of a tool result's text content, for the panel and the budget. */
export function resultCharsOf(content: readonly unknown[]): number {
	let total = 0;
	for (const block of Array.isArray(content) ? content : []) {
		const any: any = block;
		if (any && (any.type === 'text' || any.type === 'reasoning') && typeof any.text === 'string') total += codePoints(any.text);
	}
	return total;
}

/**
 * Replace one landed tool result's content, in place in the surface.
 *
 * Refuses rather than guesses at every step: a sequence that is no longer a
 * `tool/result` node, a session whose derived message is not the shape this
 * operation can preserve, a meter that cannot price the shadow. The caller is
 * expected to surface the refusal to whoever asked, not to retry.
 */
export function replaceToolResultContent(deps: SurfaceDeps, seq: number, content: readonly unknown[]): SurfaceWrite {
	const { session, tokenMeter } = deps;
	if (session === null || session === undefined || typeof session.append !== 'function') return problem('no live session to write to');
	if (tokenMeter === null || tokenMeter === undefined || typeof tokenMeter.estimateMessage !== 'function') {
		return problem('the token meter is unavailable, so a replacement could not be priced and was not written');
	}

	let event: any;
	try {
		event = typeof session.eventAt === 'function' ? session.eventAt(seq) : undefined;
	} catch (error: any) {
		return problem(`reading node ${seq} failed: ${error?.message ?? String(error)}`);
	}
	if (event === null || event === undefined) return problem(`node ${seq} is not in this session's log`);
	if (event.type !== 'tool/result') return problem(`node ${seq} is a ${String(event.type)} node; only a tool result can be rewritten this way`);

	let derived: any;
	try {
		derived = typeof session.deriveEventMessage === 'function' ? session.deriveEventMessage(event) : null;
	} catch (error: any) {
		return problem(`deriving node ${seq} failed: ${error?.message ?? String(error)}`);
	}
	const block = toolResultBlockOf(derived);
	if (block === null) return problem(`node ${seq} is not a tool result this operation can rebuild`);

	const message = { ...derived, content: [{ ...block, content }] };
	try {
		session.append('compaction/prune', {
			shadowedRange: { start: seq, end: seq },
			shadowedSeqs: [seq],
			shadowedTokenCount: tokenMeter.estimateMessage(derived),
		});
		const replacement = session.append(
			'tool/result',
			// Only `message` differs from the original data: turn, step, error and
			// meta are carried through the spread, which is what the framework's
			// own rewrite assertion requires.
			{ ...event.data, message },
			{
				surfaceOp: { op: 'replace', startSeq: seq, endSeq: seq },
				sourceEventSeqs: [seq],
			},
		);
		return { ok: true, seq: typeof replacement?.seq === 'number' ? replacement.seq : undefined };
	} catch (error: any) {
		return problem(`the session refused the replacement: ${error?.message ?? String(error)}`);
	}
}
