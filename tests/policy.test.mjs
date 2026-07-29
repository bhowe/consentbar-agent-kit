import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeState, normalizeConfig, isGpcEnabled, allowCategory } from '../src/policy.js';

const config = normalizeConfig();

function makeEnv(gpc) {
  return {
    navigator: {
      globalPrivacyControl: gpc
    }
  };
}

test('strict defaults require essential true and non-essential false by default', () => {
  const state = normalizeState(null, config, makeEnv(false), 1_700_000_000_000);
  assert.equal(state.grants.essential, true);
  assert.equal(state.grants.statistics, false);
  assert.equal(state.grants.marketing, false);
  assert.equal(state.grants.preferences, false);
  assert.equal(state.source, 'default');
});

test('Global Privacy Control forces non-essential false', () => {
  const state = normalizeState(
    {
      version: '1',
      grants: { essential: true, statistics: true, marketing: true, preferences: true },
      updatedAt: 1_700_000_000_000,
      expiresAt: 1_800_000_000_000
    },
    config,
    makeEnv(true),
    1_700_000_100_000
  );

  assert.equal(state.grants.statistics, false);
  assert.equal(state.grants.marketing, false);
  assert.equal(state.grants.preferences, false);
  assert.equal(state.source, 'gpc');
});

test('expiring state falls back to defaults', () => {
  const now = 1_700_000_000_000;
  const expired = {
    version: '1',
    grants: { essential: true, statistics: true, marketing: true, preferences: true },
    updatedAt: now - 100000,
    expiresAt: now - 1,
    source: 'stored'
  };

  const state = normalizeState(expired, config, makeEnv(false), now);
  assert.equal(state.source, 'default');
  assert.equal(state.grants.statistics, false);
});

test('allowCategory keeps essential always true', () => {
  assert.equal(allowCategory('essential', { grants: { essential: false, statistics: false, marketing: false, preferences: false } }), true);
});

test('isGpcEnabled reads navigator flag', () => {
  assert.equal(isGpcEnabled(makeEnv(true)), true);
  assert.equal(isGpcEnabled(makeEnv(false)), false);
});
