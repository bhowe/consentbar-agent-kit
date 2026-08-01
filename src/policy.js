const CATEGORIES = ['essential', 'statistics', 'marketing', 'preferences'];
const CONSENT_VERSION = '1';
const DAY_MS = 24 * 60 * 60 * 1000;

export function canonicalCategories() {
  return [...CATEGORIES];
}

export function defaultConfigValues() {
  return {
    version: '1',
    policyVersion: '1',
    policyUrl: '/privacy',
    categories: [...CATEGORIES],
    defaultConsent: {
      essential: true,
      statistics: false,
      marketing: false,
      preferences: false
    },
    storage: {
      key: 'agent-consent-state',
      version: CONSENT_VERSION,
      expiryDays: 365
    },
    trackerPatterns: [
      'google-analytics.com',
      'googletagmanager.com',
      'doubleclick.net',
      'facebook.net',
      'facebook.com/tr',
      'adservice.google.com',
      'analytics.js',
      'stats.g.doubleclick.net',
      'wp-content/uploads/breeze/google/gtag.js'
    ],
    ui: {
      manageButtonLabel: 'Manage preferences',
      injectManageButton: true
    }
  };
}

export function normalizeConfig(config = {}) {
  const defaults = defaultConfigValues();
  const merged = {
    ...defaults,
    ...config,
    categories: [...config.categories ?? defaults.categories],
    storage: {
      ...defaults.storage,
      ...config.storage
    },
    defaultConsent: {
      ...defaults.defaultConsent,
      ...config.defaultConsent
    },
    trackerPatterns: config.trackerPatterns?.length ? [...config.trackerPatterns] : [...defaults.trackerPatterns],
    ui: {
      ...defaults.ui,
      ...config.ui
    }
  };

  return merged;
}

export function isGpcEnabled(environment) {
  const nav = environment?.navigator;
  return (
    !!environment?.globalPrivacyControl ||
    nav?.globalPrivacyControl === true ||
    false
  );
}

export function buildBlankState(config = {}, environment, now = Date.now()) {
  const normalized = normalizeConfig(config);
  const grants = {
    essential: true,
    statistics: !!normalized.defaultConsent.statistics,
    marketing: !!normalized.defaultConsent.marketing,
    preferences: !!normalized.defaultConsent.preferences
  };

  return {
    version: String(normalized.storage.version ?? CONSENT_VERSION),
    policyVersion: String(normalized.policyVersion ?? '1'),
    grants,
    updatedAt: now,
    expiresAt: now + normalized.storage.expiryDays * DAY_MS,
    source: isGpcEnabled(environment) ? 'gpc' : 'default'
  };
}

export function normalizeState(rawState, config = {}, environment, now = Date.now()) {
  const normalizedConfig = normalizeConfig(config);
  const base = buildBlankState(normalizedConfig, environment, now);

  if (isGpcEnabled(environment)) {
    return {
      ...base,
      grants: {
        essential: true,
        statistics: false,
        marketing: false,
        preferences: false
      }
    };
  }

  if (!rawState || typeof rawState !== 'object') {
    return base;
  }

  if (String(rawState.version || '') !== String(base.version)) {
    return base;
  }

  const expiry = Number(rawState.expiresAt || 0);
  if (!Number.isFinite(expiry) || expiry <= now) {
    return base;
  }

  const grants = {
    essential: true,
    statistics: Boolean(rawState.grants?.statistics),
    marketing: Boolean(rawState.grants?.marketing),
    preferences: Boolean(rawState.grants?.preferences)
  };

  return {
    ...base,
    ...rawState,
    grants,
    updatedAt: Number(rawState.updatedAt) || now,
    expiresAt: Number.isFinite(expiry) ? expiry : base.expiresAt,
    source: rawState.source || 'stored'
  };
}

export function allowCategory(category, state = {}) {
  if (category === 'essential') {
    return true;
  }

  return Boolean(state.grants?.[category]);
}
