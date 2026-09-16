/**
 * The configuration layer's contract: defaults change nothing about a session,
 * and a bad patch is refused instead of half-applied.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULTS, applyPatch, cloneConfig, resolveConfig } from '../lib/config.js';

test('the shipped defaults watch and never act', () => {
	assert.equal(DEFAULTS.enabled, true);
	for (const kind of ['tool-result', 'reasoning', 'output']) {
		assert.equal(DEFAULTS.kinds[kind].enabled, true);
		// `report` is the whole promise of a fresh install: measured and shown,
		// never rewritten.
		assert.equal(DEFAULTS.kinds[kind].onOver, 'report');
		assert.ok(DEFAULTS.kinds[kind].maxChars > 0);
	}
});

test('a patch is applied to a copy, never to the config in force', () => {
	const before = cloneConfig(DEFAULTS);
	const result = applyPatch(DEFAULTS, { kinds: { 'tool-result': { maxChars: 10 } } });
	assert.equal(result.ok, true);
	assert.equal(result.config.kinds['tool-result'].maxChars, 10);
	assert.equal(DEFAULTS.kinds['tool-result'].maxChars, before.kinds['tool-result'].maxChars);
});

test('a wrong type is refused, and nothing is applied', () => {
	const bad = applyPatch(DEFAULTS, { kinds: { 'tool-result': { maxChars: 'lots', onOver: 'rewrite' } } });
	assert.equal(bad.ok, false);
	// `maxChars` is not a number, so the whole patch is dropped — including the
	// switch that would have started rewriting results.
	assert.equal(bad.config.kinds['tool-result'].onOver, DEFAULTS.kinds['tool-result'].onOver);
});

test('an unknown kind, an unknown onOver value, and a boolean that is not one are refused', () => {
	assert.equal(applyPatch(DEFAULTS, { kinds: { toolResults: { maxChars: 1 } } }).ok, false);
	assert.equal(applyPatch(DEFAULTS, { kinds: { output: { onOver: 'trim' } } }).ok, false);
	assert.equal(applyPatch(DEFAULTS, { enabled: 'yes' }).ok, false);
	assert.equal(applyPatch(DEFAULTS, 'nonsense').ok, false);
	assert.equal(applyPatch(DEFAULTS, null).ok, false);
});

test('thresholds are clamped and floors/ceilings hold', () => {
	assert.equal(applyPatch(DEFAULTS, { kinds: { output: { maxChars: -5 } } }).config.kinds.output.maxChars, 0);
	assert.equal(applyPatch(DEFAULTS, { topN: 500 }).config.topN, 50);
	assert.equal(applyPatch(DEFAULTS, { topN: 1 }).config.topN, 3);
	assert.equal(applyPatch(DEFAULTS, { logLimit: 1 }).config.logLimit, 10);
});

test('unknown keys are ignored so a newer composition still boots', () => {
	const result = applyPatch(DEFAULTS, { futureSwitch: true, kinds: { output: { maxChars: 500 } } });
	assert.equal(result.ok, true);
	assert.equal(result.config.kinds.output.maxChars, 500);
});

test('a composition config resolves into a whole config', () => {
	const resolved = resolveConfig({ enabled: false, kinds: { reasoning: { maxChars: 100, onOver: 'rewrite' } } });
	assert.equal(resolved.enabled, false);
	assert.equal(resolved.kinds.reasoning.maxChars, 100);
	assert.equal(resolved.kinds.reasoning.onOver, 'rewrite');
	assert.equal(resolved.kinds.output.maxChars, DEFAULTS.kinds.output.maxChars);
	assert.deepEqual(resolveConfig(undefined), cloneConfig(DEFAULTS));
});
