#!/usr/bin/env node
import { promises as fs } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { defaultConfigValues } from '../src/policy.js';
import { validateConfig } from '../src/validate.js';
import { auditPath } from '../src/audit.js';

const BASE = process.cwd();
const COMMAND = process.argv[2];
const TARGET = process.argv[3] || '.';

const EXIT = {
  success: 0,
  failure: 1
};

const exampleConfig = {
  ...defaultConfigValues()
};

const exampleIndex = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Consentbar Agent Kit</title>
  <script src="../dist/consentbar.js" data-consentbar-loader></script>
  <script>
    ConsentBar.init({
      version: '1',
      policyVersion: '2026-07-29',
      policyUrl: '/privacy',
      categories: ['essential', 'statistics', 'marketing', 'preferences'],
      defaultConsent: {
        essential: true,
        statistics: false,
        marketing: false,
        preferences: false
      },
      storage: {
        key: 'consentbar-demo',
        version: '1',
        expiryDays: 365
      }
    });
  </script>
</head>
<body>
  <main style="font-family: system-ui, -apple-system, Segoe UI, sans-serif; margin: 1rem;">
    <h1>Consentbar demo</h1>
    <p><a href="/privacy" data-consent-policy-link>Privacy</a></p>

    <button type="button" data-consent-accept-all>Accept all</button>
    <button type="button" data-consent-reject-all>Reject non-essential</button>
    <button type="button" data-consent-manage-button>Manage</button>

    <section>
      <h2>Example gated script</h2>
      <script data-consent-category="statistics" data-consent-src="https://www.googletagmanager.com/gtag/js?id=DEMO"></script>
    </section>
    <section>
      <h2>Example gated frame</h2>
      <iframe data-consent-category="marketing" data-consent-src="https://www.youtube.com/embed/abc123" width="560" height="315"></iframe>
    </section>
  </main>
</body>
</html>`;

function usage() {
  console.log('Usage: consentbar <init|validate|audit> [path-or-config]');
  console.log('  init [dir]       create starter config and files');
  console.log('  validate [path]   validate config JSON (default consentbar.config.json)');
  console.log('  audit <html-or-dir>  audit consent gates in html files');
}

async function loadConfig(rawPath = 'consentbar.config.json') {
  const file = path.resolve(BASE, rawPath);
  const raw = await fs.readFile(file, 'utf8');
  return JSON.parse(raw);
}

async function cmdInit(target = '.') {
  const dir = path.resolve(BASE, target);
  await fs.mkdir(dir, { recursive: true });

  const configPath = path.join(dir, 'consentbar.config.json');
  const examplePath = path.join(dir, 'examples', 'basic', 'index.html');

  try {
    await fs.writeFile(configPath, `${JSON.stringify(exampleConfig, null, 2)}\n`, 'utf8');
    await fs.mkdir(path.dirname(examplePath), { recursive: true });
    await fs.writeFile(examplePath, exampleIndex, 'utf8');
    console.log(`created ${path.relative(BASE, configPath)}`);
    console.log(`created ${path.relative(BASE, examplePath)}`);
    console.log('Run: consentbar validate consentbar.config.json');
  } catch (error) {
    console.error('init failed', error.message || String(error));
    process.exit(EXIT.failure);
  }
}

async function cmdValidate(configPath = 'consentbar.config.json') {
  try {
    const parsed = await loadConfig(configPath);
    const result = validateConfig(parsed);
    if (!result.valid) {
      console.error('Invalid config:');
      for (const error of result.errors) {
        console.error(`- ${error}`);
      }
      process.exit(EXIT.failure);
      return;
    }

    console.log('Config valid');
    process.exit(EXIT.success);
  } catch (error) {
    console.error('validate failed:', error.message || String(error));
    process.exit(EXIT.failure);
  }
}

async function cmdAudit(targetPath = 'examples/basic') {
  try {
    const config = await loadConfig('consentbar.config.json');
    const result = await auditPath(targetPath, config);
    if (result.warnings?.length) {
      console.log('Warnings:');
      for (const warning of result.warnings) {
        console.log(`- ${warning}`);
      }
    }

    if (result.errors?.length) {
      console.error('Errors:');
      for (const error of result.errors) {
        console.error(`- ${error}`);
      }
    }

    process.exit(result.exitCode);
  } catch (error) {
    console.error('audit failed:', error.message || String(error));
    process.exit(EXIT.failure);
  }
}

async function main() {
  if (!COMMAND || COMMAND === 'help' || COMMAND === '--help' || COMMAND === '-h') {
    usage();
    return;
  }

  if (COMMAND === 'init') {
    await cmdInit(TARGET);
    return;
  }

  if (COMMAND === 'validate') {
    await cmdValidate(TARGET);
    return;
  }

  if (COMMAND === 'audit') {
    await cmdAudit(TARGET);
    return;
  }

  console.error(`Unknown command: ${COMMAND}`);
  usage();
  process.exit(EXIT.failure);
}

main();
