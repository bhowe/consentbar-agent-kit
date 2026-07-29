import fs from 'node:fs/promises';
import path from 'node:path';
import { canonicalCategories, defaultConfigValues, normalizeConfig } from './policy.js';
import { validateConfig } from './validate.js';

const DEFAULT_TRACKER_PATTERNS = defaultConfigValues().trackerPatterns;

const GATED_TAG_REGEX = /<(script|iframe)\b[^>]*\bdata-consent-(?:src|category)\s*=\s*["'].*?["'][^>]*>/gi;
const SRC_TAG_REGEX = /<(script|iframe)\b[^>]*\s+src\s*=\s*(["'])(.*?)\2[^>]*>/gi;
const DATA_CATEGORY_REGEX = /data-consent-category\s*=\s*(["'])(.*?)\1/i;
const DATA_SRC_REGEX = /data-consent-src\s*=\s*(["'])(.*?)\1/i;
const SRC_REGEX = /(?:^|\s)src\s*=\s*(["'])(.*?)\1/i;
const TYPE_REGEX = /(?:^|\s)type\s*=\s*(["'])(.*?)\1/i;
const MANAGE_REJECT_ACCEPT_REGEX = /data-consent-(manage-button|reject-all|accept-all)\b/i;
const LOADER_REGEX = /<script\b[^>]*\bdata-consentbar-loader\b[^>]*>|<script\b[^>]*\bconsentbar\.(?:js|mjs)/i;

function isHtmlFile(filePath) {
  return filePath.toLowerCase().endsWith('.html') || filePath.toLowerCase().endsWith('.htm');
}

function isTrackedUrl(value, trackerPatterns) {
  return trackerPatterns.some((pattern) => value.includes(pattern));
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

function inspectGatedTag(match, tags, loaderIndex) {
  const tag = match[0];
  const index = match.index;
  const tagName = match[1].toLowerCase();

  const categoryMatch = DATA_CATEGORY_REGEX.exec(tag);
  const consentSrcMatch = DATA_SRC_REGEX.exec(tag);
  const srcMatch = SRC_REGEX.exec(tag);
  const regularSrc = (srcMatch?.[2] || '').toLowerCase();
  const consentSrc = (consentSrcMatch?.[2] || '').toLowerCase();
  const typeMatch = TYPE_REGEX.exec(tag);
  const scriptType = typeMatch ? typeMatch[2].toLowerCase() : '';

  const hasDataCategory = DATA_CATEGORY_REGEX.test(tag);
  const hasDataConsentSrc = DATA_SRC_REGEX.test(tag);
  const category = categoryMatch?.[2] || 'essential';

  if (hasDataCategory && !canonicalCategories().includes(category)) {
    tags.errors.push(`invalid-consent-category:${category}`);
  }

  if (loaderIndex >= 0 && index < loaderIndex) {
    tags.errors.push('loader-order');
  }

  if ((hasDataCategory || hasDataConsentSrc) && regularSrc) {
    tags.errors.push(`gated-tag-must-use-data-consent-src:${regularSrc}`);
  }

  if (!hasDataCategory && hasDataConsentSrc) {
    tags.errors.push(`missing-data-consent-category:${consentSrc}`);
  }

  if (tagName === 'script' && hasDataCategory && !hasDataConsentSrc && scriptType !== 'text/plain') {
    tags.errors.push('inline-gated-script-must-be-text/plain');
  }

}

function inspectSrcTag(match, tags, trackerPatterns) {
  const tag = match[0];
  const src = (match[3] || '').toLowerCase();
  if (!src) {
    return;
  }

  const isTracker = isTrackedUrl(src, trackerPatterns);
  if (!isTracker) {
    return;
  }

  const hasDataCategory = DATA_CATEGORY_REGEX.test(tag);
  const hasDataConsentSrc = DATA_SRC_REGEX.test(tag);
  const hasGatedAttr = hasDataCategory || hasDataConsentSrc;

  if (!hasGatedAttr) {
    tags.errors.push(`ungated-tracker:${src}`);
    return;
  }

  if (!hasDataConsentSrc) {
    tags.errors.push(`gated-tag-must-use-data-consent-src:${src}`);
  }

  if (!hasDataCategory) {
    tags.errors.push(`missing-data-consent-category:${src}`);
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

  let match;
  GATED_TAG_REGEX.lastIndex = 0;
  while ((match = GATED_TAG_REGEX.exec(content)) !== null) {
    inspectGatedTag(match, tags, loaderIndex);
  }

  SRC_TAG_REGEX.lastIndex = 0;
  while ((match = SRC_TAG_REGEX.exec(content)) !== null) {
    inspectSrcTag(match, tags, normalizedPatterns);
  }

  const uniq = (values) => Array.from(new Set(values));
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
