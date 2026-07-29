(() => {
const CATEGORIES = ['essential', 'statistics', 'marketing', 'preferences'];
const CONSENT_VERSION = '1';
const DAY_MS = 24 * 60 * 60 * 1000;
function canonicalCategories() {
  return [...CATEGORIES];
}
function defaultConfigValues() {
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
      'stats.g.doubleclick.net'
    ],
    ui: {
      manageButtonLabel: 'Manage preferences',
      injectManageButton: true
    }
  };
}
function normalizeConfig(config = {}) {
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
function isGpcEnabled(environment) {
  const nav = environment?.navigator;
  return (
    !!environment?.globalPrivacyControl ||
    nav?.globalPrivacyControl === true ||
    false
  );
}
function buildBlankState(config = {}, environment, now = Date.now()) {
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
function normalizeState(rawState, config = {}, environment, now = Date.now()) {
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
function allowCategory(category, state = {}) {
  if (category === 'essential') {
    return true;
  }

  return Boolean(state.grants?.[category]);
}


const GATED_SELECTOR =
  'script[data-consent-category], iframe[data-consent-category], script[data-consent-src], iframe[data-consent-src]';
const DAY_MS = 24 * 60 * 60 * 1000;

function resolveRuntimeContext(context = {}, providedWindow, providedDocument) {
  const windowObj = context.window || providedWindow || (typeof window !== 'undefined' ? window : null);
  const documentObj = context.document || providedDocument || (windowObj ? windowObj.document : null);
  const navigatorObj = context.navigator || (windowObj?.navigator || documentObj?.defaultView?.navigator || null);

  return {
    ...context,
    window: windowObj,
    document: documentObj,
    navigator: navigatorObj
  };
}

function isBrowserContext(context = {}) {
  const resolved = resolveRuntimeContext(context, context?.window, context?.document);
  return !!(resolved.document || (resolved.window && resolved.window.document));
}

function makeStorage(contextStorage, windowObj) {
  if (contextStorage) {
    return contextStorage;
  }

  const target = windowObj || null;
  try {
    if (target && target.localStorage) {
      return {
        getItem: (k) => target.localStorage.getItem(k),
        setItem: (k, v) => target.localStorage.setItem(k, v),
        removeItem: (k) => target.localStorage.removeItem(k)
      };
    }
  } catch (_error) {
    return null;
  }

  const memory = Object.create(null);
  return {
    getItem: (k) => (k in memory ? memory[k] : null),
    setItem: (k, v) => {
      memory[k] = String(v);
    },
    removeItem: (k) => {
      delete memory[k];
    }
  };
}

function enforceGpcGrants(grants, environment) {
  if (!isGpcEnabled(environment)) {
    return grants;
  }

  return {
    essential: true,
    statistics: false,
    marketing: false,
    preferences: false
  };
}

function parseBoolean(value) {
  return value === 'true' || value === true;
}

function copyAttributes(source, target) {
  if (!source?.attributes) {
    return;
  }

  for (const attr of Array.from(source.attributes)) {
    if (attr.name.startsWith('data-consent-') || attr.name === 'type') {
      continue;
    }
    target.setAttribute(attr.name, attr.value);
  }
}

function cloneScriptNode(node) {
  const next = node.ownerDocument.createElement('script');
  copyAttributes(node, next);
  next.type = node.type && node.type !== 'text/plain' ? node.type : 'text/javascript';

  if (node.dataset.consentSrc) {
    next.src = node.dataset.consentSrc;
  } else if (node.src) {
    next.src = node.src;
  }

  if (node.textContent) {
    next.textContent = node.textContent;
  }

  next.dataset.consentActivated = '1';
  return next;
}

function cloneIFrameNode(node) {
  const next = node.ownerDocument.createElement('iframe');
  copyAttributes(node, next);
  if (node.dataset.consentSrc) {
    next.src = node.dataset.consentSrc;
  }
  next.dataset.consentActivated = '1';
  return next;
}

class ConsentBarManager {
  constructor(config = {}, context = {}) {
    this.context = resolveRuntimeContext(context, context.window, context.document);
    this.config = normalizeConfig(config);
    this.document = this.context.document;
    this.window = this.context.window;
    this.storage = makeStorage(this.context.storage, this.window);
    this.key = this.config.storage.key;
    this.state = this.loadState();
    this.initialized = false;
    this.observer = null;
  }

  loadState() {
    if (!this.storage) {
      return normalizeState(null, this.config, this.context, Date.now());
    }

    const key = this.config.storage.key;
    try {
      const raw = this.storage.getItem(key);
      if (!raw) {
        return normalizeState(null, this.config, this.context, Date.now());
      }
      const parsed = JSON.parse(raw);
      return normalizeState(parsed, this.config, this.context, Date.now());
    } catch (_error) {
      return normalizeState(null, this.config, this.context, Date.now());
    }
  }

  saveState(state) {
    if (!this.storage) {
      return;
    }

    try {
      this.storage.setItem(this.key, JSON.stringify(state));
    } catch (_error) {
      // best effort
    }
  }

  hasContext() {
    return isBrowserContext(this.context);
  }

  nowExpiry() {
    return Date.now() + this.config.storage.expiryDays * DAY_MS;
  }

  isGpc() {
    return isGpcEnabled(this.context);
  }

  broadcast(reason) {
    if (!this.window || !this.window.CustomEvent) {
      return;
    }

    const detail = {
      reason,
      version: this.state.version,
      grants: this.state.grants,
      policyVersion: this.state.policyVersion,
      source: this.state.source,
      updatedAt: this.state.updatedAt,
      expiresAt: this.state.expiresAt,
      timestamp: Date.now()
    };

    const event = new CustomEvent('consent:updated', { detail });
    const old = new CustomEvent('consentchange', { detail });
    this.window.dispatchEvent(event);
    this.window.dispatchEvent(old);
  }

  isAllowed(category) {
    if (this.isGpc()) {
      return category === 'essential';
    }

    return allowCategory(category, this.state);
  }

  hydrateState(overrides = {}) {
    const now = Date.now();
    const config = this.config;
    const base = normalizeState(
      {
        ...this.state,
        ...overrides,
        updatedAt: now,
        expiresAt: now + config.storage.expiryDays * DAY_MS
      },
      config,
      this.context,
      now
    );

    const normalizedGrants = {
      essential: true,
      statistics: Boolean(overrides.grants?.statistics ?? base.grants.statistics),
      marketing: Boolean(overrides.grants?.marketing ?? base.grants.marketing),
      preferences: Boolean(overrides.grants?.preferences ?? base.grants.preferences)
    };

    base.grants = enforceGpcGrants(normalizedGrants, this.context);
    base.source = overrides.source || 'user';
    if (this.isGpc()) {
      base.source = 'gpc';
    }

    this.state = base;
    this.saveState(this.state);
  }

  acceptAll() {
    this.hydrateState({
      grants: {
        essential: true,
        statistics: true,
        marketing: true,
        preferences: true
      },
      source: 'accept-all'
    });

    if (this.document) {
      this.applyConsentGates(this.document);
    }
    this.broadcast('acceptAll');
  }

  rejectNonEssential() {
    this.hydrateState({
      grants: {
        essential: true,
        statistics: false,
        marketing: false,
        preferences: false
      },
      source: 'reject-nonessential'
    });

    if (this.document) {
      this.applyConsentGates(this.document);
    }
    this.broadcast('rejectNonEssential');
  }

  setCategoryConsent(category, value) {
    if (this.isGpc()) {
      return;
    }

    if (!this.config.categories.includes(category)) {
      return;
    }
    if (category === 'essential') {
      return;
    }

    const grants = {
      ...this.state.grants,
      [category]: parseBoolean(value)
    };

    this.hydrateState({ grants, source: `toggle:${category}` });
    if (this.document) {
      this.applyConsentGates(this.document);
    }
    this.broadcast(`toggle:${category}`);
  }

  bindControls(documentRef) {
    const root = documentRef || this.document;
    if (!root) {
      return;
    }

    const acceptAll = root.querySelectorAll('[data-consent-accept-all]');
    const rejectAll = root.querySelectorAll('[data-consent-reject-all]');
    const manage = root.querySelectorAll('[data-consent-manage-button]');

    for (const button of acceptAll) {
      button.addEventListener('click', () => this.acceptAll(), { passive: true });
    }

    for (const button of rejectAll) {
      button.addEventListener('click', () => this.rejectNonEssential(), { passive: true });
    }

    for (const button of manage) {
      button.addEventListener(
        'click',
        () => {
          this.broadcast('open-manage');
          if (this.window && typeof this.window.dispatchEvent === 'function') {
            const event = new CustomEvent('consent:manage', {
              detail: {
                reason: 'button'
              }
            });
            this.window.dispatchEvent(event);
          }
        },
        { passive: true }
      );
    }

    for (const input of root.querySelectorAll('[data-consent-toggle]')) {
      const category = input.dataset.consentToggle;
      const update = () => this.setCategoryConsent(category, input.checked);
      input.addEventListener('change', update, { passive: true });
      input.checked = this.isAllowed(category);
    }
  }

  injectManageButton(documentRef) {
    const root = documentRef || this.document;
    if (!root || !root.body || !this.config.ui.injectManageButton) {
      return;
    }

    if (root.querySelector('[data-consent-manage-button]')) {
      return;
    }

    const button = root.createElement('button');
    button.type = 'button';
    button.className = 'consent-manage-button';
    button.dataset.consentManageButton = 'true';
    button.textContent = this.config.ui.manageButtonLabel || 'Manage preferences';
    button.setAttribute('aria-label', this.config.ui.manageButtonLabel || 'Manage preferences');
    const style =
      'position:fixed; right:1rem; bottom:1rem; z-index:99999; padding:0.6rem 0.9rem; border:0; border-radius:999px; font-family:system-ui, sans-serif;';
    button.style.cssText = style;
    root.body.appendChild(button);
  }

  blockNode(node) {
    node.dataset.consentBlocked = '1';
    node.setAttribute('inert', '');
    node.setAttribute('aria-hidden', 'true');
    if (
      this.document?.defaultView?.HTMLScriptElement &&
      node instanceof this.document.defaultView.HTMLScriptElement
    ) {
      node.setAttribute('type', 'text/plain');
    }
  }

  activateNode(node) {
    if (!this.document) {
      return;
    }

    if (node.dataset && node.dataset.consentActivated === '1') {
      return;
    }

    if (node.tagName === 'SCRIPT') {
      const replacement = cloneScriptNode(node);
      node.replaceWith(replacement);
      return;
    }

    if (node.tagName === 'IFRAME') {
      const replacement = cloneIFrameNode(node);
      node.replaceWith(replacement);
      return;
    }
  }

  applyConsentGates(documentRef = this.document) {
    if (!documentRef || !documentRef.querySelectorAll) {
      return;
    }

    for (const node of documentRef.querySelectorAll(GATED_SELECTOR)) {
      const category = node.dataset?.consentCategory || 'essential';
      if (this.isAllowed(category)) {
        this.activateNode(node);
      } else {
        this.blockNode(node);
      }
    }
  }

  observeMutations(documentRef = this.document) {
    if (!documentRef || !documentRef.defaultView || !documentRef.defaultView.MutationObserver) {
      return;
    }

    this.observer = new documentRef.defaultView.MutationObserver((mutations) => {
      for (const mutation of mutations) {
        for (const node of mutation.addedNodes || []) {
          if (node?.querySelectorAll && node instanceof documentRef.defaultView.Element) {
            const nodes = [node, ...Array.from(node.querySelectorAll(GATED_SELECTOR))];
            for (const maybe of nodes) {
              if (maybe.matches && maybe.matches(GATED_SELECTOR)) {
                const category = maybe.dataset?.consentCategory || 'essential';
                if (this.isAllowed(category)) {
                  this.activateNode(maybe);
                } else {
                  this.blockNode(maybe);
                }
              }
            }
          }
        }
      }
    });

    this.observer.observe(documentRef.documentElement || documentRef.body || documentRef, {
      childList: true,
      subtree: true
    });
  }

  init() {
    if (!this.hasContext() || this.initialized) {
      return this;
    }

    const boot = () => {
      this.applyConsentGates();
      this.bindControls();
      this.injectManageButton();
      this.observeMutations();
      this.broadcast('ready');
    };

    if (this.document.readyState === 'loading') {
      this.document.addEventListener('DOMContentLoaded', boot, { once: true });
    } else {
      boot();
    }

    this.initialized = true;
    return this;
  }
}

let sharedInstance = null;
function createManager(config = {}, context = {}) {
  if (sharedInstance) {
    return sharedInstance;
  }

  sharedInstance = new ConsentBarManager(config, context);
  return sharedInstance;
}
function init(config = {}, context = {}) {
  const manager = createManager(config, context);
  manager.init();
  return manager;
}
function reset() {
  sharedInstance = null;
}

if (typeof window !== 'undefined') {
  window.ConsentBar = {
    init,
    createManager,
    policy: {
      normalizeConfig
    }
  };
}

})();
