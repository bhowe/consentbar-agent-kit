import { defaultConfigValues, canonicalCategories } from './policy.js';

export function validateConfig(config) {
  const cfg = config && typeof config === 'object' ? config : {};
  const errors = [];

  const expectedCategories = canonicalCategories();
  const defaults = defaultConfigValues();

  if (typeof cfg.version !== 'string' || cfg.version.trim().length === 0) {
    errors.push('version must be a non-empty string');
  }

  if (typeof cfg.policyVersion !== 'string' || cfg.policyVersion.trim().length === 0) {
    errors.push('policyVersion must be a non-empty string');
  }

  if (typeof cfg.policyUrl !== 'string' || cfg.policyUrl.trim().length === 0) {
    errors.push('policyUrl must be a non-empty string');
  }

  if (!Array.isArray(cfg.categories)) {
    errors.push('categories must be an array');
  } else {
    const missing = expectedCategories.filter((c) => !cfg.categories.includes(c));
    const extra = cfg.categories.filter((c) => !expectedCategories.includes(c));
    if (cfg.categories.length !== expectedCategories.length || missing.length > 0 || extra.length > 0) {
      errors.push('categories must be exactly essential,statistics,marketing,preferences');
    }
    if (cfg.categories.some((value) => !cfg.categories.includes(value))) {
      errors.push('categories must be unique and each category string');
    }
  }

  if (!cfg.defaultConsent || typeof cfg.defaultConsent !== 'object') {
    errors.push('defaultConsent must be an object');
  } else {
    for (const category of expectedCategories) {
      if (!(category in cfg.defaultConsent)) {
        errors.push(`defaultConsent.${category} is required`);
      }
      if (category !== 'essential' && typeof cfg.defaultConsent[category] !== 'boolean') {
        errors.push(`defaultConsent.${category} must be boolean`);
      }
    }
    if (cfg.defaultConsent.essential !== true) {
      errors.push('defaultConsent.essential must be true');
    }
  }

  if (!cfg.storage || typeof cfg.storage !== 'object') {
    errors.push('storage must be an object');
  } else {
    if (typeof cfg.storage.key !== 'string' || cfg.storage.key.trim().length === 0) {
      errors.push('storage.key must be non-empty string');
    }
    if (typeof cfg.storage.version !== 'string' || cfg.storage.version.trim().length === 0) {
      errors.push('storage.version must be non-empty string');
    }
    if (typeof cfg.storage.expiryDays !== 'number' || !Number.isFinite(cfg.storage.expiryDays)) {
      errors.push('storage.expiryDays must be a number');
    } else if (cfg.storage.expiryDays <= 0 || cfg.storage.expiryDays > 3650) {
      errors.push('storage.expiryDays must be between 1 and 3650');
    }
  }

  if (cfg.trackerPatterns !== undefined) {
    if (!Array.isArray(cfg.trackerPatterns) || !cfg.trackerPatterns.every((x) => typeof x === 'string')) {
      errors.push('trackerPatterns must be an array of strings');
    }
  }

  return {
    valid: errors.length === 0,
    errors: [...errors],
    normalized: Object.keys(errors).length === 0 ? cfg : null,
    fallback: Object.keys(errors).length === 0 ? null : defaultConfigValues()
  };
}
