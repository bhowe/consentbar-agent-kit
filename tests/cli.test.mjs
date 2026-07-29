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

test('audit passes on tracker fixture with data-consent-src', () => {
  const result = spawnSync(process.execPath, [cli, 'audit', resolve(process.cwd(), 'tests/fixtures/good-tracker-consent-src.html')], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe']
  });

  assert.equal(result.status, 0);
  assert.equal(result.stdout.trim(), '');
});

test('audit fails on tracker using ordinary src even with category', () => {
  const result = spawnSync(process.execPath, [cli, 'audit', resolve(process.cwd(), 'tests/fixtures/bad-tracker-category-src.html')], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe']
  });

  assert.equal(result.status, 1);
  assert.match(result.stderr, /gated-tag-must-use-data-consent-src/);
});

test('audit fails on non-tracker ordinary src kept in gated script', () => {
  const result = spawnSync(process.execPath, [cli, 'audit', resolve(process.cwd(), 'tests/fixtures/bad-gated-nontracker-ordinary-src.html')], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe']
  });

  assert.equal(result.status, 1);
  assert.match(result.stderr, /gated-tag-must-use-data-consent-src/);
});

test('audit fails on categoryless consent source', () => {
  const result = spawnSync(process.execPath, [cli, 'audit', resolve(process.cwd(), 'tests/fixtures/bad-categoryless-consent-src.html')], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe']
  });

  assert.equal(result.status, 1);
  assert.match(result.stderr, /missing-data-consent-category/);
});

test('audit fails on unsafe inline gated script', () => {
  const result = spawnSync(process.execPath, [cli, 'audit', resolve(process.cwd(), 'tests/fixtures/bad-inline-gated-script.html')], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe']
  });

  assert.equal(result.status, 1);
  assert.match(result.stderr, /inline-gated-script-must-be-text\/plain/);
});

test('audit passes on safe inline text/plain gated script', () => {
  const result = spawnSync(process.execPath, [cli, 'audit', resolve(process.cwd(), 'tests/fixtures/good-inline-type-text-plain.html')], {
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
