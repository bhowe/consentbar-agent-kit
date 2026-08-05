import fs from 'node:fs/promises';
import path from 'node:path';
import { canonicalCategories, defaultConfigValues, normalizeConfig } from './policy.js';
import { validateConfig } from './validate.js';

const DEFAULT_TRACKER_PATTERNS = defaultConfigValues().trackerPatterns;

const GATED_TAG_REGEX = /<(script|iframe)\b[^>]*\bdata-consent-(?:src|category)\s*=\s*["'].*?["'][^>]*>/gi;
const SRC_TAG_REGEX = /<(script|iframe)\b[^>]*\s+src\s*=\s*(["'])(.*?)\2[^>]*>/gi;
const INLINE_SCRIPT_REGEX = /<(script)\b([^>]*)>([\s\S]*?)<\/script>/gi;
const DATA_CATEGORY_REGEX = /data-consent-category\s*=\s*(["'])(.*?)\1/i;
const DATA_SRC_REGEX = /data-consent-src\s*=\s*(["'])(.*?)\1/i;
const SRC_REGEX = /(?:^|\s)src\s*=\s*(["'])(.*?)\1/i;
const TYPE_REGEX = /(?:^|\s)type\s*=\s*(["'])(.*?)\1/i;
const ACCEPT_ALL_CONTROL_REGEX = /data-consent-accept-all/i;
const REJECT_ALL_CONTROL_REGEX = /data-consent-reject-all/i;
const MANAGE_BUTTON_CONTROL_REGEX = /data-consent-manage-button/i;
const MANAGE_REJECT_ACCEPT_REGEX = /data-consent-(manage-button|reject-all|accept-all)\b/i;
const LOADER_REGEX = /<script\b[^>]*\bdata-consentbar-loader\b[^>]*>|<script\b[^>]*\bconsentbar\.(?:js|mjs)/i;
const ANALYTICS_CALL_PATTERNS = [
  /\bgtag\s*\(/i,
  /\bdataLayer\.push\s*\(/i,
  /\bga\s*\(/i,
  /\b__gaTracker\s*\(/i,
  /\bwindow\.(?:gtag|__gaTracker)\s*\(/i,
  /\bwindow\.dataLayer\.push\s*\(/i
];

function containsAnalyticsCall(scriptBody) {
  if (!scriptBody || !scriptBody.trim()) {
    return false;
  }

  return ANALYTICS_CALL_PATTERNS.some((pattern) => pattern.test(scriptBody));
}

function isHtmlFile(filePath) {
  return filePath.toLowerCase().endsWith('.html') || filePath.toLowerCase().endsWith('.htm');
}

function isTrackedUrl(value, trackerPatterns) {
  return trackerPatterns.some((pattern) => value.includes(pattern));
}

export function detectPlatform(content, explicitPlatform = '') {
  const explicit = String(explicitPlatform || '').trim().toLowerCase();
  if (explicit === 'wordpress' || explicit === 'non-wordpress') return explicit;
  if (/<meta[^>]+(?:name=["']generator["'][^>]+content=["'][^"']*wordpress|content=["'][^"']*wordpress[^"']*["'][^>]+name=["']generator["'])/i.test(content)
      || /(?:wp-content|wp-includes)\//i.test(content)) return 'wordpress';
  return 'non-wordpress';
}

function extractTrackerSources(content, trackerPatterns, includeGatedOnly = false) {
  const tagRegex = /<(script|iframe)\b[^>]*>/gi;
  const sources = [];

  let tagMatch;
  while ((tagMatch = tagRegex.exec(content)) !== null) {
    const tag = tagMatch[0];
    const attributeRegexes = includeGatedOnly
      ? [/\bdata-consent-src\s*=\s*(["'])([^"']*)\1/gi]
      : [/\bsrc\s*=\s*(["'])([^"']*)\1/gi, /\bdata-consent-src\s*=\s*(["'])([^"']*)\1/gi];

    for (const attrRegex of attributeRegexes) {
      let attrMatch;
      while ((attrMatch = attrRegex.exec(tag)) !== null) {
        const raw = (attrMatch[2] || '').trim().toLowerCase();
        if (raw && isTrackedUrl(raw, trackerPatterns)) {
          sources.push(raw);
        }
      }
    }
  }

  return sources;
}

function countSources(sources) {
  const counts = new Map();
  for (const source of sources) {
    counts.set(source, (counts.get(source) || 0) + 1);
  }

  return counts;
}

function formatState(state) {
  return state ? 'present' : 'absent';
}

function summarizeHtmlVariant(content, trackerPatterns) {
  return {
    hasLoader: firstIndexOfLoader(content) >= 0,
    hasAcceptAllControl: ACCEPT_ALL_CONTROL_REGEX.test(content),
    hasRejectAllControl: REJECT_ALL_CONTROL_REGEX.test(content),
    hasManageButtonControl: MANAGE_BUTTON_CONTROL_REGEX.test(content),
    gatedTrackerSources: extractTrackerSources(content, trackerPatterns, true)
  };
}

function prefixedStrings(values, prefix) {
  return values.map((value) => `${prefix}:${value}`);
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

export async function auditHtmlContent(content, cfg = {}, platform = '') {
  const config = normalizeConfig(cfg);
  const normalizedPatterns = (config.trackerPatterns || DEFAULT_TRACKER_PATTERNS).map((pattern) => String(pattern).toLowerCase());
  config.trackerPatterns = normalizedPatterns;

  const errors = [];
  const warnings = [];
  const detectedPlatform = detectPlatform(content, platform);
  const recommendation = detectedPlatform === 'wordpress'
    ? 'wordpress-cookieyes: use the official CookieYes WordPress plugin as the runtime; do not deploy ConsentBar runtime. Audit results do not prove CookieYes is configured.'
    : 'consentbar-runtime: non-WordPress may use ConsentBar with strict opt-in controls.';

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

  INLINE_SCRIPT_REGEX.lastIndex = 0;
  while ((match = INLINE_SCRIPT_REGEX.exec(content)) !== null) {
    const tag = match[0];
    const body = match[3] || '';
    if (!containsAnalyticsCall(body)) {
      continue;
    }

    const hasConsentCategory = DATA_CATEGORY_REGEX.test(tag);
    const tagTypeMatch = TYPE_REGEX.exec(tag);
    const type = tagTypeMatch ? tagTypeMatch[2].toLowerCase() : '';

    if (hasConsentCategory && type === 'text/plain') {
      continue;
    }
    if (hasConsentCategory) {
      tags.errors.push('inline-gated-script-must-be-text/plain');
    } else {
      tags.errors.push('inline-analytics-call-not-consented');
    }
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
    warnings,
    platform: detectedPlatform,
    recommendation
  };
}

export async function auditHtmlVariants(publicHtml, freshHtml, cfg = {}, platform = '') {
  const config = normalizeConfig(cfg);
  const normalizedPatterns = (config.trackerPatterns || DEFAULT_TRACKER_PATTERNS).map((pattern) => String(pattern).toLowerCase());
  config.trackerPatterns = normalizedPatterns;

  const publicResult = await auditHtmlContent(publicHtml, config, platform);
  const freshResult = await auditHtmlContent(freshHtml, config, platform);

  const publicSummary = summarizeHtmlVariant(publicHtml, normalizedPatterns);
  const freshSummary = summarizeHtmlVariant(freshHtml, normalizedPatterns);

  const publicTrackerCounts = countSources(publicSummary.gatedTrackerSources);
  const freshTrackerCounts = countSources(freshSummary.gatedTrackerSources);

  const variantMismatches = [];
  if (publicSummary.hasLoader !== freshSummary.hasLoader) {
    variantMismatches.push(
      `loader-mismatch:public=${formatState(publicSummary.hasLoader)}:fresh=${formatState(
        freshSummary.hasLoader
      )}`
    );
  }

  if (publicSummary.hasAcceptAllControl !== freshSummary.hasAcceptAllControl) {
    variantMismatches.push(
      `accept-all-control-mismatch:public=${formatState(publicSummary.hasAcceptAllControl)}:fresh=${formatState(
        freshSummary.hasAcceptAllControl
      )}`
    );
  }

  if (publicSummary.hasRejectAllControl !== freshSummary.hasRejectAllControl) {
    variantMismatches.push(
      `reject-all-control-mismatch:public=${formatState(publicSummary.hasRejectAllControl)}:fresh=${formatState(
        freshSummary.hasRejectAllControl
      )}`
    );
  }

  if (publicSummary.hasManageButtonControl !== freshSummary.hasManageButtonControl) {
    variantMismatches.push(
      `manage-button-control-mismatch:public=${formatState(publicSummary.hasManageButtonControl)}:fresh=${formatState(
        freshSummary.hasManageButtonControl
      )}`
    );
  }

  const trackedSources = new Set([...publicTrackerCounts.keys(), ...freshTrackerCounts.keys()]);
  const orderedSources = Array.from(trackedSources).sort();

  for (const source of orderedSources) {
    const publicCount = publicTrackerCounts.get(source) || 0;
    const freshCount = freshTrackerCounts.get(source) || 0;
    if (publicCount === freshCount) {
      continue;
    }

    if (publicCount === 0) {
      variantMismatches.push(`tracker-present-in-fresh-not-public:${source}`);
      continue;
    }

    if (freshCount === 0) {
      variantMismatches.push(`tracker-present-in-public-not-fresh:${source}`);
      continue;
    }

    variantMismatches.push(`tracker-count-mismatch:${source}:${publicCount}:${freshCount}`);
  }

  const errors = [
    ...prefixedStrings(publicResult.errors, 'public'),
    ...prefixedStrings(freshResult.errors, 'fresh'),
    ...variantMismatches
  ];

  const warnings = [
    ...prefixedStrings(publicResult.warnings, 'public'),
    ...prefixedStrings(freshResult.warnings, 'fresh')
  ];

  const uniqErrors = Array.from(new Set(errors));
  const uniqWarnings = Array.from(new Set(warnings));

  return {
    success: uniqErrors.length === 0,
    errors: uniqErrors,
    warnings: uniqWarnings,
    platform: publicResult.platform === freshResult.platform ? publicResult.platform : 'mixed',
    recommendation: publicResult.recommendation === freshResult.recommendation
      ? publicResult.recommendation
      : 'platform-mismatch: inspect both variants before selecting a runtime.'
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
