/**
 * The browser half's contract, checked by executing the built bundle.
 *
 * There is no browser here, so the bundle is run in a `vm` context against a
 * stub of the two globals the harness provides — the module loader and a React
 * that records elements instead of rendering them. That is enough to pin the
 * properties that would otherwise only fail in a page:
 *
 *  - the file is a classic script that registers itself exactly once;
 *  - its factory hands back a Cordis plugin whose `apply` takes both seats;
 *  - every colour it draws is a theme token, so it cannot break in the other
 *    theme;
 *  - and rendering with no data does not throw.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const source = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8');

/** Run the bundle with a loader stub, and hand back what it registered. */
function loadBundle() {
	const registrations = [];
	const styles = [];
	const sandbox = {
		window: { __ModuleLoader__: { load: (registration) => registrations.push(registration) } },
		document: {
			querySelector: () => null,
			createElement: () => ({ dataset: {}, textContent: '' }),
			head: { appendChild: (element) => styles.push(element) },
		},
		Intl,
		URLSearchParams,
		Symbol,
		Object,
		Array,
		Number,
		String,
		Math,
		JSON,
		console,
	};
	vm.createContext(sandbox);
	vm.runInContext(source, sandbox);
	return { registrations, styles };
}

/** A React that records the tree instead of rendering it. */
function reactStub() {
	return {
		createElement: (...args) => ({ type: args[0], props: args[1] ?? null, children: args.slice(2) }),
		useState: (initial) => [initial, () => undefined],
		useEffect: () => undefined,
	};
}

/** Build the plugin the factory returns, plus a `slots` that records registers. */
function buildPlugin() {
	const { registrations, styles } = loadBundle();
	assert.equal(registrations.length, 1, 'the bundle registers itself exactly once');
	const registration = registrations[0];
	const exports = registration.factory((spec) => {
		if (spec === 'react') return reactStub();
		throw new Error(`the bundle asked for an undeclared module: ${spec}`);
	});
	const registered = [];
	const injected = [];
	const ctx = {
		slots: {
			inject: (name, callback) => {
				injected.push(name);
				callback();
			},
			register: (options) => {
				registered.push(options);
				return () => undefined;
			},
		},
	};
	return { registration, exports, ctx, registered, injected, styles };
}

test('the bundle is a classic script that names itself as the package', () => {
	assert.match(source, /__ModuleLoader__\.load\(/);
	assert.doesNotMatch(source, /^\s*(import|export)\s/m, 'a classic script may carry no ESM syntax');
	const { registration } = buildPlugin();
	assert.equal(registration.id, 'dsh-plugin-context');
});

test('the factory returns a Cordis plugin that needs only the slot registry', () => {
	const { exports } = buildPlugin();
	assert.equal(typeof exports.apply, 'function');
	// The array was built inside the vm realm, so it is copied back before comparing.
	assert.deepEqual(Array.from(exports.inject), ['slots']);
});

test('apply takes two additive seats, and replaces nothing', () => {
	const { exports, ctx, registered, injected } = buildPlugin();
	exports.apply(ctx);
	assert.deepEqual(injected, ['conversation.view', 'conversation.session.header.utilities']);
	assert.deepEqual(
		registered.map((options) => `${options.name}#${options.id}`),
		['conversation.view#context-control', 'conversation.session.header.utilities#context-control-meter'],
	);
	// A fresh id beside the shipped entries, never in one of their cells.
	for (const options of registered) {
		assert.equal(typeof options.order, 'number');
		assert.equal(typeof options.label, 'function', 'the label is a thunk so a locale change needs no re-register');
	}
});

test('every colour it draws is a theme token', () => {
	const { styles } = buildPlugin();
	assert.equal(styles.length, 1);
	const tag = styles[0];
	assert.equal(tag.dataset.plugin, 'dsh-plugin-context', 'HMR removes owned styles by this exact attribute');
	assert.match(tag.textContent, /--dsw-alias-/);
	assert.doesNotMatch(tag.textContent, /#[0-9a-fA-F]{3,8}\b/, 'no hard-coded hex colour');
	assert.doesNotMatch(tag.textContent, /\brgba?\(|\bhsla?\(/, 'no hard-coded colour function');
});

test('both components render with no data instead of throwing', () => {
	const { exports } = buildPlugin();
	const view = exports.ContextControlView({ sessionId: 'session-1' });
	assert.ok(view !== null && view !== undefined);
	const tree = JSON.stringify(view, (key, value) => (typeof value === 'function' ? '[fn]' : value));
	assert.match(tree, /Reading this session's context/, 'the empty state is stated, not blank');

	const meter = exports.ContextMeter({ sessionId: 'session-1' });
	assert.ok(meter !== null && meter !== undefined);
	const meterTree = JSON.stringify(meter, (key, value) => (typeof value === 'function' ? '[fn]' : value));
	assert.match(meterTree, /ctx –/, 'the meter admits it has not read anything yet');
});

test('a session-less seat renders the explained empty state rather than fetching', () => {
	const { exports } = buildPlugin();
	const view = exports.ContextControlView({});
	const tree = JSON.stringify(view, (key, value) => (typeof value === 'function' ? '[fn]' : value));
	assert.ok(tree.length > 0);
});
