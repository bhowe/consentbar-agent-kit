#!/usr/bin/env node
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

function stripModuleSyntax(code) {
  return code
    .replace(/^\s*import[^;]+;\n?/gm, '')
    .replace(/^\s*export\s+(function|class|const|let|var)\s+/gm, '$1 ')
    .replace(/^\s*export\s*\{[^}]+\};?\s*$/gm, '')
    .replace(/\n\s*export\s*\{[^}]+\}\s*;?\n?/g, '\n');
}

const policy = stripModuleSyntax(readFileSync(resolve(process.cwd(), 'src/policy.js'), 'utf8'));
const runtime = stripModuleSyntax(readFileSync(resolve(process.cwd(), 'src/consentbar.js'), 'utf8'));

const bundle = `(() => {\n${policy}\n${runtime}\n})();\n`;
writeFileSync(resolve(process.cwd(), 'dist/consentbar.js'), bundle, 'utf8');
