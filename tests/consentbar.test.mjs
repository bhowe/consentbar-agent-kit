import test from 'node:test';
import assert from 'node:assert/strict';
import { createManager, reset } from '../src/consentbar.js';
import { normalizeConfig } from '../src/policy.js';

function makeMemoryStorage() {
  const memory = Object.create(null);
  return {
    getItem(key) {
      return key in memory ? memory[key] : null;
    },
    setItem(key, value) {
      memory[key] = String(value);
    },
    removeItem(key) {
      delete memory[key];
    }
  };
}

test('GPC prevents acceptAll from enabling non-essential', () => {
  reset();
  const config = normalizeConfig();
  const manager = createManager(config, {
    navigator: { globalPrivacyControl: true },
    storage: makeMemoryStorage()
  });

  manager.acceptAll();

  assert.equal(manager.state.grants.essential, true);
  assert.equal(manager.state.grants.statistics, false);
  assert.equal(manager.state.grants.marketing, false);
  assert.equal(manager.state.grants.preferences, false);
  assert.equal(manager.state.source, 'gpc');
});

test('GPC ignores granular toggles', () => {
  reset();
  const config = normalizeConfig();
  const manager = createManager(config, {
    navigator: { globalPrivacyControl: true },
    storage: makeMemoryStorage()
  });

  manager.setCategoryConsent('statistics', true);

  assert.equal(manager.state.grants.statistics, false);
  assert.equal(manager.state.grants.marketing, false);
  assert.equal(manager.state.grants.preferences, false);
  assert.equal(manager.state.source, 'gpc');
});
