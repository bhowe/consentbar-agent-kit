import fs from 'node:fs/promises';
import path from 'node:path';
import { canonicalCategories, defaultConfigValues, normalizeConfig } from './policy.js';
import { validateConfig } from './validate.js';

const DEFAULT_TRACKER_PATTERNS = defaultConfigValues().trackerPatterns;

const GATED_TAG_REGEX = /<(script|iframe)\b[^>]*\bdata-consent-(?:src|category)\s*=\s*["'].*?["'][^>]*>/gi;
const DATA_CATEGORY_REGEX = /data-consent-category\s*=\s*(["'])(.*?)\1/i;
const DATA_SRC_REGEX = /data-consent-src\s*=\s*(["'])(.*?)\1/i;
const SRC_REGEX = /\bsrc\s*=\s*(["'])(.*?)\1/i;
const SRC_TAG_REGEX = /<(script|iframe)\b[^>]*\bsrc\s*=\s*(["'])(.*?)\2[^>]*>/gi;
const MANAGE_REJECT_ACCEPT_REGEX = /data-consent-(manage-button|reject-all|accept-all)\b/i;
const LOADER_REGEX = /<script\b[^>]*\bdata-consentbar-loader\b[^>]*>|<script\b[^>]*\bconsentbar\.(?:js|mjs)/i;

function isHtmlFile(filePath) {
  return filePath.toLowerCase().endsWith('.html') || filePath.toLowerCase().endsWith('.htm');
}

async function listHtmlFiles(target) {
  const full = path.resolve(target);
  const stat = await fs.stat(full);

  if (stat.isFile()) {
    return isHtmlFile(full) ? [full] : [];
  }

  const entries = await fs.readdir(full, { recursive: true, withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile() && isHtmlFile(entry.name))
    .map((entry) => path.join(entry.path, entry.name));
}

function firstIndexOfLoader(content) {
  LOADER_REGEX.lastIndex = 0;
  const match = LOADER_REGEX.exec(content);
  return match ? match.index : -1;
}

function inspectTag(content, match, tags, config, loaderIndex) {
  const tag = match[0];
  const index = match.index;
  const categoryMatch = DATA_CATEGORY_REGEX.exec(tag);
  const srcMatch = DATA_SRC_REGEX.exec(tag);
  const attrSrc = SRC_REGEX.exec(tag);
  const src = (srcMatch?.[2] || attrSrc?.[2] || '').toLowerCase();
  const category = categoryMatch?.[2] || 'essential';
  const hasDataCategory = DATA_CATEGORY_REGEX.test(tag);
  const hasDataConsentSrc = DATA_SRC_REGEX.test(tag);
  const isTracker = (config.trackerPatterns || []).some((pattern) => src.includes(pattern));
  const canonical = canonicalCategories();

  if (hasDataCategory && !canonical.includes(category)) {
    tags.errors.push(`invalid-consent-category:${category}`);
  }

  if (loaderIndex >= 0 && index < loaderIndex) {
    tags.errors.push('loader-order');
  }

  if (hasDataCategory || hasDataConsentSrc) {
    if (category === 'statistics' && hasDataCategory && !hasDataConsentSrc && !src) {
      tags.warnings.push('statistics-tag-without-src');
    }
    return;
  }

  if (isTracker) {
    tags.errors.push(`ungated-tracker:${src}`);
  }
}

export async function auditHtmlContent(content, cfg = {}) {
  const config = normalizeConfig(cfg);
  const normalizedPatterns = (config.trackerPatterns || DEFAULT_TRACKER_PATTERNS).map((pattern) => String(pattern).toLowerCase());
  config.trackerPatterns = normalizedPatterns;

  const errors = [];
  const warnings = [];

  if (!content.includes('data-consent-policy-link')) {
    if (!content.includes(`href="${config.policyUrl}"`) && !content.includes(`href='${config.policyUrl}'`)) {
      errors.push('missing-policy-link');
    }
  }

  if (!/data-consent-accept-all/.test(content)) {
    errors.push('missing-accept-all-control');
  }
  if (!/data-consent-reject-all/.test(content)) {
    errors.push('missing-reject-all-control');
  }
  if (!/data-consent-manage-button/.test(content)) {
    errors.push('missing-manage-button');
  }

  const loaderIndex = firstIndexOfLoader(content);
  if (loaderIndex < 0) {
    errors.push('missing-consent-loader');
  }

  const tags = { errors: [], warnings: [] };

  GATED_TAG_REGEX.lastIndex = 0;
  let match;
  while ((match = GATED_TAG_REGEX.exec(content)) !== null) {
    inspectTag(content, match, tags, config, loaderIndex);
  }

  SRC_TAG_REGEX.lastIndex = 0;
  while ((match = SRC_TAG_REGEX.exec(content)) !== null) {
    const tag = match[0];
    const src = (match[3] || '').toLowerCase();

    if (!src) {
      continue;
    }

    const hasCategory = DATA_CATEGORY_REGEX.test(tag);
    const hasExplicit = DATA_SRC_REGEX.test(tag);
    const tracked = normalizedPatterns.some((pattern) => src.includes(pattern));

    if (tracked && !(hasCategory || hasExplicit)) {
      tags.errors.push(`ungated-tracker:${src}`);
    }
  }

  const uniq = (value) => Array.from(new Set(value));
  for (const item of uniq(tags.errors)) {
    errors.push(item);
  }

  for (const item of uniq(tags.warnings)) {
    warnings.push(item);
  }

  const hasTrackerControls = MANAGE_REJECT_ACCEPT_REGEX.test(content);
  if (!hasTrackerControls) {
    warnings.push('missing-basic-controls');
  }

  return {
    success: errors.length === 0,
    errors,
    warnings
  };
}

export async function auditPath(targetPath, config = {}) {
  const configResult = validateConfig(config);
  if (!configResult.valid) {
    return {
      exitCode: 1,
      files: [],
      errors: configResult.errors,
      warnings: []
    };
  }

  const files = await listHtmlFiles(targetPath);
  if (files.length === 0) {
    return {
      exitCode: 1,
      files: [],
      errors: ['no-html-found'],
      warnings: []
    };
  }

  let allErrors = [];
  let allWarnings = [];

  for (const file of files) {
    const content = await fs.readFile(file, 'utf8');
    const result = await auditHtmlContent(content, config);
    if (!result.success) {
      allErrors = allErrors.concat(result.errors.map((error) => `${path.relative(process.cwd(), file)}: ${error}`));
    }
    allWarnings = allWarnings.concat(result.warnings.map((warning) => `${path.relative(process.cwd(), file)}: ${warning}`));
  }

  const uniqueErrors = Array.from(new Set(allErrors));
  const uniqueWarnings = Array.from(new Set(allWarnings));

  return {
    exitCode: uniqueErrors.length > 0 ? 1 : 0,
    files,
    errors: uniqueErrors,
    warnings: uniqueWarnings
  };
}
