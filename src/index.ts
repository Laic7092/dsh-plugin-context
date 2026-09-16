/**
 * dsh-plugin-context — host half.
 *
 * Context control for DeepSeek Harness: it measures what the next request will
 * carry, it can rewrite the two things a request's size is actually made of —
 * a tool result on its way in, and a model's reasoning or output on its way out
 * — and it ships that ability with every strategy still switched off.
 *
 * This file is *wiring only*. Every rule about when the plugin may act lives in
 * `./control.ts`, every number lives in `./measure.ts`, every rewrite of live
 * content lives in `./policies.ts` and `./surface.ts`. What is left here is the
 * part that has to know about Cordis:
 *
 *  - **What is always on.** Two observation listeners: a tool call's duration
 *    and the size of its result. `tools/result` is an emit event, so this half
 *    of the plugin cannot alter anything even if it wanted to.
 *  - **What is armed only when asked.** `tools/post-execute`,
 *    `tools/ptc-dispatch-log` and `llm/stream` are registered only while the
 *    corresponding kind is set to `rewrite`. On the shipped `report` default
 *    there is no listener of ours anywhere on a path that can change a request.
 *  - **What is optional.** The web carrier is reached through `ctx.inject`, not
 *    by sampling `ctx.webServer` inside `apply`: at profile boot this row
 *    activates before the carrier, so a reference captured here would be
 *    permanently undefined and every panel request would 404. The token meter
 *    and the session store are read with `ctx.get` at the moment they are
 *    needed, so a composition without them loses numbers, never functionality.
 *
 * Configuration is read from this row's own `config:` block and can be changed
 * live from the panel. Live changes last for the life of the process; the
 * durable place to pin a configuration is the composition — a patch row with no
 * `insert`:
 *
 *     - id: dsh-plugin-context
 *       config:
 *         kinds:
 *           tool-result: { maxChars: 12000, onOver: rewrite }
 *         policies:
 *           tool-result: head-tail
 *
 * @module dsh-plugin-context
 */
import { ContextControl } from './control.ts';
import { headTailTrim, PolicyRegistry } from './policies.ts';

export const name = 'dsh-plugin-context';

/**
 * Turn a session id into the live session, through whichever registry holds it.
 *
 * Both registries key on the same id space, and neither is guaranteed to be
 * composed, so this tries the session store first and the agent registry second
 * and answers null rather than throwing when neither knows the id.
 */
function sessionFor(ctx: any, id: unknown): any {
	if (typeof id !== 'string' || id.length === 0) return null;
	try {
		const sessions = ctx.get('sessions');
		if (sessions !== undefined && typeof sessions.get === 'function') {
			const session = sessions.get(id);
			if (session !== undefined && session !== null) return session;
		}
		const agents = ctx.get('agents');
		if (agents !== undefined && typeof agents.get === 'function') {
			const agent = agents.get(id);
			const session = agent === null || agent === undefined ? undefined : agent.session;
			if (session !== undefined && session !== null) return session;
		}
	} catch {
		// A registry that throws on lookup is a composition this plugin does not
		// understand; the caller gets "no such session" rather than a failure.
	}
	return null;
}

export function apply(ctx: any, config: any = {}): void {
	const log = typeof ctx.logger?.info === 'function' ? (message: string) => ctx.logger.info(message) : (message: string) => console.log(`[context] ${message}`);

	const control = new ContextControl({ config, note: log });
	// The registry starts from the composition's names, so a policy named in a
	// patch row is in force before the first tool call rather than after.
	control.reloadPolicies();
	log(`context control: ${control.describe()}`);

	// ---------------------------------------------------------------- watching

	// Observation only. `tools/pre-execute` must call `next()`; the listener is
	// wrapped so that bookkeeping can never deny a call, and `tools/result` is an
	// emit event that no listener can influence.
	ctx.effect(() => {
		const disposers = [
			ctx.on('tools/pre-execute', async (exec: any, next: any) => {
				try {
					control.startCall(exec);
				} catch {
					// Timing is a convenience, never a gate.
				}
				return next();
			}),
			ctx.on('tools/result', (exec: any, result: any) => {
				try {
					// `tools/result` is an emit event: its listeners are neither
					// awaited nor their rejections contained, so this promise is
					// settled here and nowhere else.
					void control.finishCall(exec, result).catch(() => undefined);
				} catch {
					// Bookkeeping only.
				}
			}),
		];
		return () => {
			for (const dispose of disposers.splice(0)) dispose();
		};
	}, 'dsh-plugin-context: tool observation');

	// ------------------------------------------------------------------ seams

	// The rewrite seams, re-armed whenever the configuration's posture changes.
	// Between them these are the only listeners this plugin registers that can
	// change what a request carries.
	let seamEffect: (() => void) | null = null;
	const armSeams = () => {
		if (seamEffect !== null) {
			seamEffect();
			seamEffect = null;
		}
		const wantToolResult = control.needsToolResultSeam();
		const wantStream = control.needsStreamSeam();
		if (!wantToolResult && !wantStream) {
			log('nothing is armed to rewrite: every over-budget item is reported and left alone');
			return;
		}
		seamEffect = ctx.effect(() => {
			const disposers: Array<() => void> = [];

			if (wantToolResult) {
				// The direct path: a tool result the model asked for, before it
				// becomes a durable event.
				disposers.push(ctx.on('tools/post-execute', async (exec: any, result: any, next: any) => {
					const decision = await next();
					try {
						// Respect whatever the pipeline already decided: a downstream
						// replacement or an error result is not ours to discard.
						if (decision?.kind !== 'accept' || Object.hasOwn(decision, 'value')) return decision;
						const content = Array.isArray(decision.content) ? decision.content : result?.content;
						if (!Array.isArray(content)) return decision;
						const rewritten = await control.decideToolResult(exec, content, result?.isError === true);
						if (rewritten === null) return decision;
						return {
							kind: 'accept',
							content: rewritten.content,
							...(decision.additionalContexts === undefined ? {} : { additionalContexts: decision.additionalContexts }),
						};
					} catch {
						// A context manager that breaks the call it is managing is
						// worse than one that did nothing.
						return decision;
					}
				}));

				// The nested path: under the `min-ptc` preset most tool calls are
				// sub-dispatches inside `run_code`, and their durable content is
				// governed here rather than by post-execute.
				disposers.push(ctx.on('tools/ptc-dispatch-log', async (dispatch: any, next: any) => {
					const content = await next();
					try {
						const rewritten = await control.decidePtcDispatch({
							agent: dispatch?.agent,
							subCallId: dispatch?.subCallId,
							name: dispatch?.name,
							isError: dispatch?.isError,
							content,
						});
						return rewritten === null ? content : rewritten.content;
					} catch {
						return content;
					}
				}));
			}

			if (wantStream) {
				// Generation time is the only honest place to bound reasoning and
				// output: a committed assistant message can never be surface-replaced.
				disposers.push(ctx.on('llm/stream', (_options: any, next: any) => control.guardStream(next())));
			}

			return () => {
				for (const dispose of disposers.splice(0)) dispose();
			};
		}, 'dsh-plugin-context: rewrite seams');
		log(`armed to rewrite: ${[wantToolResult ? 'tool-result' : null, wantStream ? 'reasoning/output' : null].filter((entry) => entry !== null).join(', ')}`);
	};
	armSeams();

	// ------------------------------------------------------------------ panel

	// The panel's data path. Optional exactly like the seams: a composition with
	// no web carrier still measures and still controls, it just has nowhere to
	// draw. Reached through `ctx.inject` because this row activates before the
	// carrier exists.
	ctx.inject(['webServer'], (webCtx: any) => {
		const send = (res: any, status: number, value: unknown) => {
			const body = Buffer.from(JSON.stringify(value), 'utf8');
			res.writeHead(status, {
				'content-type': 'application/json; charset=utf-8',
				'content-length': body.length,
				'cache-control': 'no-store',
			});
			res.end(body);
		};
		const paramsOf = (req: any) => {
			try {
				return new URL(req.url ?? '/', 'http://localhost').searchParams;
			} catch {
				return new URLSearchParams();
			}
		};
		const fail = (res: any, error: unknown) =>
			send(res, 500, { ok: false, error: error instanceof Error ? error.message : String(error) });

		/** A bounded body reader: the panel sends a small JSON object and nothing else. */
		const readBody = (req: any): Promise<{ ok: boolean; value?: any; error?: string }> =>
			new Promise((resolveBody) => {
				let size = 0;
				const chunks: Buffer[] = [];
				let done = false;
				const finish = (value: { ok: boolean; value?: any; error?: string }) => {
					if (done) return;
					done = true;
					resolveBody(value);
				};
				req.on('data', (chunk: Buffer) => {
					size += chunk.length;
					if (size > 64 * 1024) {
						finish({ ok: false, error: 'body too large' });
						try {
							req.destroy();
						} catch {
							// Already gone.
						}
						return;
					}
					chunks.push(chunk);
				});
				req.on('error', () => finish({ ok: false, error: 'request stream failed' }));
				req.on('end', () => {
					try {
						finish({ ok: true, value: JSON.parse(Buffer.concat(chunks).toString('utf8')) });
					} catch {
						finish({ ok: false, error: 'body is not valid JSON' });
					}
				});
			});

		/** Measure one session, degrading into a stated reason rather than a zero. */
		const snapshot = (session: any) => {
			const meter = ctx.get('tokenMeter');
			if (meter === undefined || typeof meter.measure !== 'function') {
				return control.snapshotFor(session, null, 'the token meter is not mounted in this composition, so context pressure cannot be read');
			}
			try {
				return control.snapshotFor(session, meter.measure(session));
			} catch (error: any) {
				return control.snapshotFor(session, null, `measurement failed: ${error?.message ?? String(error)}`);
			}
		};

		// GET /context/state?sessionId=… — everything the panel draws.
		webCtx.effect(() => webCtx.webServer.register({
			kind: 'exact',
			path: '/context/state',
			async handler(req: any, res: any) {
				try {
					const id = paramsOf(req).get('sessionId');
					const session = sessionFor(ctx, id);
					if (session === null) {
						return send(res, 200, {
							ok: false,
							error: id === null || id.length === 0
								? 'sessionId is required: this panel reads one session at a time'
								: `session "${id}" is not live in this process`,
						});
					}
					send(res, 200, { ok: true, snapshot: snapshot(session) });
				} catch (error) {
					fail(res, error);
				}
			},
		}), 'dsh-plugin-context: GET /context/state');

		// GET|POST /context/config — the configuration actually in force, and the
		// one write path the panel has. A patch that is refused changes nothing.
		webCtx.effect(() => webCtx.webServer.register({
			kind: 'exact',
			path: '/context/config',
			async handler(req: any, res: any) {
				try {
					if (req.method === 'GET') return send(res, 200, { ok: true, config: control.configuration() });
					if (req.method !== 'POST') return send(res, 405, { ok: false, error: 'GET or POST /context/config' });
					const body = await readBody(req);
					if (!body.ok) return send(res, 400, { ok: false, error: body.error });
					const result = control.patch(body.value);
					if (!result.ok) return send(res, 400, { ok: false, error: result.error, config: result.config });
					if (result.rearm) armSeams();
					log(`configuration changed: ${control.describe()}`);
					send(res, 200, { ok: true, config: result.config });
				} catch (error) {
					fail(res, error);
				}
			},
		}), 'dsh-plugin-context: GET|POST /context/config');

		// POST /context/action — the two things a person can do on purpose.
		webCtx.effect(() => webCtx.webServer.register({
			kind: 'exact',
			path: '/context/action',
			async handler(req: any, res: any) {
				if (req.method !== 'POST') return send(res, 405, { ok: false, error: 'POST /context/action' });
				try {
					const body = await readBody(req);
					if (!body.ok) return send(res, 400, { ok: false, error: body.error });
					const wanted = body.value ?? {};
					const session = sessionFor(ctx, wanted.sessionId);
					if (session === null) return send(res, 400, { ok: false, error: 'that session is not live in this process' });

					if (wanted.action === 'intervene') {
						const seq = typeof wanted.seq === 'number' ? wanted.seq : null;
						if (seq === null) return send(res, 400, { ok: false, error: 'seq is required to intervene on a node' });
						const outcome = await control.interveneOnNode({ session, tokenMeter: ctx.get('tokenMeter') }, seq);
						return send(res, outcome.ok ? 200 : 400, { ok: outcome.ok, outcome });
					}

					if (wanted.action === 'prune-official') {
						// The framework's own deterministic pruner, when this
						// composition mounts it. Delegating beats reimplementing a
						// durable write that already has an owner.
						const pruner = ctx.get('toolResultPruner');
						if (pruner === undefined || typeof pruner.pruneSession !== 'function') {
							return send(res, 400, { ok: false, error: 'the official tool-result pruner is not mounted in this composition' });
						}
						const result = pruner.pruneSession(session);
						const pruned = Array.isArray(result?.pruned) ? result.pruned.length : 0;
						log(`official pruner rewrote ${pruned} tool result(s), removing ${result?.charsRemoved ?? 0} characters`);
						return send(res, 200, { ok: true, pruned, charsRemoved: typeof result?.charsRemoved === 'number' ? result.charsRemoved : 0 });
					}

					send(res, 400, { ok: false, error: `unknown action ${JSON.stringify(wanted.action)}` });
				} catch (error) {
					fail(res, error);
				}
			},
		}), 'dsh-plugin-context: POST /context/action');

		log('panel routes registered: GET /context/state, GET|POST /context/config, POST /context/action');
	});
}

/**
 * The public seam for a strategy.
 *
 * A policy is code, so installing one is a host-side act. Two supported routes:
 * add an entry to `BUILT_IN_POLICIES` in `./policies.ts` and name it in the
 * configuration, or take the registry from an instance of `ContextControl` and
 * call `set(kind, policy, name)`. `headTailTrim` and `identity` are exported
 * here so that a strategy can be composed without reaching into the package.
 */
export { ContextControl } from './control.ts';
export { headTailTrim, identity, PolicyRegistry } from './policies.ts';
export { DEFAULTS, applyPatch, resolveConfig } from './config.ts';
export { replaceToolResultContent } from './surface.ts';
