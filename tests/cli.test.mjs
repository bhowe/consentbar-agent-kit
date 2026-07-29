import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';

const cli = resolve(process.cwd(), 'bin/consentbar.js');
const rootConfig = resolve(process.cwd(), 'consentbar.config.json');

test('validate command succeeds for default config', () => {
  const result = spawnSync(process.execPath, [cli, 'validate', rootConfig], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe']
  });

  assert.equal(result.status, 0);
  assert.equal(result.stdout.trim(), 'Config valid');
});

test('audit passes on positive fixture', () => {
  const result = spawnSync(process.execPath, [cli, 'audit', resolve(process.cwd(), 'tests/fixtures/good.html')], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe']
  });

  assert.equal(result.status, 0);
  assert.equal(result.stdout.trim(), '');
});

test('audit fails on missing policy and controls', () => {
  const result = spawnSync(process.execPath, [cli, 'audit', resolve(process.cwd(), 'tests/fixtures/bad.html')], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe']
  });

  assert.equal(result.status, 1);
  assert.match(result.stderr, /missing-policy-link/);
});

test('audit catches single-quoted ungated tracker URLs case-insensitively', () => {
  const result = spawnSync(process.execPath, [cli, 'audit', resolve(process.cwd(), 'tests/fixtures/single-quoted-ungated-tracker.html')], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe']
  });

  assert.equal(result.status, 1);
  assert.match(result.stderr, /ungated-tracker/);
});

test('validate fails on malformed config', () => {
  const tmp = mkdtempSync(resolve(tmpdir(), 'consentbar-cli-'));
  const malformed = resolve(tmp, 'bad.config.json');
  writeFileSync(
    malformed,
    JSON.stringify(
      {
        version: '1',
        policyVersion: '',
        categories: ['statistics'],
        storage: { key: 'x', version: '1', expiryDays: 0 },
        defaultConsent: { essential: false }
      },
      null,
      2
    )
  );

  const result = spawnSync(process.execPath, [cli, 'validate', malformed], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe']
  });

  assert.equal(result.status, 1);
  assert.match(result.stderr, /Invalid config/);
});
