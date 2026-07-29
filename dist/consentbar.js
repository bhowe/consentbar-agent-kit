(() => {
  const DAY_MS = 24 * 60 * 60 * 1000;
  const CATEGORIES = ['essential', 'statistics', 'marketing', 'preferences'];
  const GATED_SELECTOR = 'script[data-consent-category], iframe[data-consent-category], script[type="text/plain"]';

  const defaults = {
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
      version: '1',
      expiryDays: 365
    },
    trackerPatterns: [
      'google-analytics.com',
      'googletagmanager.com',
      'doubleclick.net',
      'facebook.net',
      'facebook.com/tr',
      'adservice.google.com',
      'analytics.js'
    ],
    ui: {
      manageButtonLabel: 'Manage preferences',
      injectManageButton: true
    }
  };

  function mergeConfig(config = {}) {
    const merged = { ...defaults, ...config };
    merged.categories = [...(config.categories || defaults.categories)];
    merged.storage = { ...defaults.storage, ...(config.storage || {}) };
    merged.defaultConsent = { ...defaults.defaultConsent, ...(config.defaultConsent || {}) };
    merged.ui = { ...defaults.ui, ...(config.ui || {}) };
    merged.trackerPatterns = config.trackerPatterns?.length ? [...config.trackerPatterns] : [...defaults.trackerPatterns];
    return merged;
  }

  function isGPC() {
    return window?.navigator?.globalPrivacyControl === true;
  }

  function createStorage(key) {
    try {
      if (window.localStorage) {
        return {
          getItem: (k) => localStorage.getItem(k),
          setItem: (k, v) => localStorage.setItem(k, v),
          removeItem: (k) => localStorage.removeItem(k)
        };
      }
    } catch (_error) {
      // ignore
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

  function blankState(config, now) {
    return {
      version: String(config.storage.version),
      policyVersion: String(config.policyVersion),
      grants: {
        essential: true,
        statistics: false,
        marketing: false,
        preferences: false
      },
      source: isGPC() ? 'gpc' : 'default',
      updatedAt: now,
      expiresAt: now + config.storage.expiryDays * DAY_MS
    };
  }

  function loadState(storage, key, config) {
    const now = Date.now();
    try {
      const raw = storage.getItem(key);
      if (!raw) {
        const s = blankState(config, now);
        if (!isGPC()) {
          s.grants = { ...s.grants, ...config.defaultConsent };
        }
        return s;
      }

      const parsed = JSON.parse(raw);
      if (String(parsed.version) !== String(config.storage.version)) {
        return blankState(config, now);
      }

      if (Number(parsed.expiresAt || 0) <= now) {
        return blankState(config, now);
      }

      return {
        version: String(parsed.version || config.storage.version),
        policyVersion: String(parsed.policyVersion || config.policyVersion),
        grants: {
          essential: true,
          statistics: Boolean(parsed.grants?.statistics),
          marketing: Boolean(parsed.grants?.marketing),
          preferences: Boolean(parsed.grants?.preferences)
        },
        source: parsed.source || 'stored',
        updatedAt: Number(parsed.updatedAt) || now,
        expiresAt: Number(parsed.expiresAt),
        source: parsed.source || 'stored'
      };
    } catch (_error) {
      const s = blankState(config, now);
      return s;
    }
  }

  function allowCategory(state, category) {
    if (category === 'essential') {
      return true;
    }
    return Boolean(state.grants?.[category]);
  }

  function emit(windowObj, eventName, detail) {
    if (!windowObj.CustomEvent) {
      return;
    }
    windowObj.dispatchEvent(new CustomEvent(eventName, { detail }));
  }

  function copyAttributes(source, target) {
    for (const attr of Array.from(source.attributes || [])) {
      if (attr.name.startsWith('data-consent-') || attr.name === 'type') {
        continue;
      }
      target.setAttribute(attr.name, attr.value);
    }
  }

  function replaceWithScript(node, config) {
    const next = document.createElement('script');
    copyAttributes(node, next);
    next.type = node.type && node.type !== 'text/plain' ? node.type : 'text/javascript';
    if (node.dataset?.consentSrc) {
      next.src = node.dataset.consentSrc;
    } else if (node.src) {
      next.src = node.src;
    }
    if (node.textContent) {
      next.textContent = node.textContent;
    }
    next.dataset.consentActivated = '1';
    node.replaceWith(next);
  }

  function replaceWithIFrame(node) {
    const next = document.createElement('iframe');
    copyAttributes(node, next);
    if (node.dataset?.consentSrc) {
      next.src = node.dataset.consentSrc;
    }
    next.dataset.consentActivated = '1';
    node.replaceWith(next);
  }

  function ensureManageButton(document, config) {
    if (!config.ui.injectManageButton || document.querySelector('[data-consent-manage-button]')) {
      return;
    }

    const button = document.createElement('button');
    button.type = 'button';
    button.dataset.consentManageButton = 'true';
    button.textContent = config.ui.manageButtonLabel || 'Manage preferences';
    button.style.position = 'fixed';
    button.style.right = '1rem';
    button.style.bottom = '1rem';
    button.style.zIndex = '99999';
    button.style.padding = '0.6rem 0.9rem';
    button.style.border = '0';
    button.style.borderRadius = '999px';
    button.style.fontFamily = 'system-ui';
    button.addEventListener('click', () => {
      emit(window, 'consent:manage', { reason: 'button' });
      emit(window, 'consent:updated', { reason: 'manage-button', timestamp: Date.now() });
    });
    document.body.appendChild(button);
  }

  class ConsentBarManager {
    constructor(config = {}) {
      this.config = mergeConfig(config);
      this.storage = createStorage(this.config.storage.key);
      this.state = loadState(this.storage, this.config.storage.key, this.config);
      this.observer = null;
      this.init = this.init.bind(this);
    }

    broadcast(reason) {
      emit(window, 'consent:updated', {
        reason,
        version: this.state.version,
        grants: this.state.grants,
        policyVersion: this.state.policyVersion,
        source: this.state.source,
        updatedAt: this.state.updatedAt,
        expiresAt: this.state.expiresAt,
        timestamp: Date.now()
      });
      emit(window, 'consentchange', {
        reason,
        version: this.state.version,
        grants: this.state.grants,
        policyVersion: this.state.policyVersion,
        source: this.state.source,
        updatedAt: this.state.updatedAt,
        expiresAt: this.state.expiresAt,
        timestamp: Date.now()
      });
    }

    saveState() {
      this.storage.setItem(this.config.storage.key, JSON.stringify(this.state));
    }

    isAllowed(category) {
      if (isGPC() || this.state.source === 'gpc') {
        return category === 'essential';
      }
      return allowCategory(this.state, category);
    }

    setCategory(category, value) {
      if (category === 'essential') {
        return;
      }

      this.state.grants = {
        ...this.state.grants,
        [category]: !!value
      };
      this.state.updatedAt = Date.now();
      this.state.expiresAt = Date.now() + this.config.storage.expiryDays * DAY_MS;
      this.state.source = `toggle:${category}`;
      this.saveState();
      this.applyGates(document);
      this.broadcast(`toggle:${category}`);
    }

    acceptAll() {
      this.state.grants = {
        essential: true,
        statistics: true,
        marketing: true,
        preferences: true
      };
      this.state.updatedAt = Date.now();
      this.state.expiresAt = Date.now() + this.config.storage.expiryDays * DAY_MS;
      this.state.source = 'accept-all';
      this.saveState();
      this.applyGates(document);
      this.broadcast('accept-all');
    }

    rejectNonEssential() {
      this.state.grants = {
        essential: true,
        statistics: false,
        marketing: false,
        preferences: false
      };
      this.state.updatedAt = Date.now();
      this.state.expiresAt = Date.now() + this.config.storage.expiryDays * DAY_MS;
      this.state.source = 'reject-nonessential';
      this.saveState();
      this.applyGates(document);
      this.broadcast('reject-non-essential');
    }

    applyGates(root = document) {
      for (const node of root.querySelectorAll(GATED_SELECTOR)) {
        const category = node.dataset.consentCategory || 'essential';
        if (this.isAllowed(category)) {
          if (node.tagName === 'SCRIPT') {
            replaceWithScript(node, this.config);
          }
          if (node.tagName === 'IFRAME') {
            replaceWithIFrame(node);
          }
        } else {
          node.setAttribute('inert', '');
          node.setAttribute('aria-hidden', 'true');
          node.dataset.consentBlocked = '1';
          if (node.tagName === 'SCRIPT') {
            node.type = 'text/plain';
          }
        }
      }
    }

    bindControls() {
      for (const accept of document.querySelectorAll('[data-consent-accept-all]')) {
        accept.addEventListener('click', () => this.acceptAll(), { passive: true });
      }
      for (const reject of document.querySelectorAll('[data-consent-reject-all]')) {
        reject.addEventListener('click', () => this.rejectNonEssential(), { passive: true });
      }
      for (const item of document.querySelectorAll('[data-consent-toggle]')) {
        const key = item.dataset.consentToggle;
        item.checked = this.state.grants[key];
        item.addEventListener('change', () => this.setCategory(key, item.checked), { passive: true });
      }
      for (const button of document.querySelectorAll('[data-consent-manage-button]')) {
        button.addEventListener('click', () => this.broadcast('manage-button'), { passive: true });
      }
    }

    init() {
      if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', () => this.init(), { once: true });
        return this;
      }

      this.applyGates(document);
      this.bindControls();
      ensureManageButton(document, this.config);
      this.broadcast('ready');

      this.observer = new MutationObserver((mutations) => {
        for (const mutation of mutations) {
          for (const node of mutation.addedNodes || []) {
            if (node.matches && node.matches(GATED_SELECTOR)) {
              const category = node.dataset.consentCategory || 'essential';
              if (this.isAllowed(category)) {
                if (node.tagName === 'SCRIPT') {
                  replaceWithScript(node, this.config);
                }
                if (node.tagName === 'IFRAME') {
                  replaceWithIFrame(node);
                }
              } else {
                node.setAttribute('inert', '');
                node.dataset.consentBlocked = '1';
              }
            }

            if (node.querySelectorAll) {
              node.querySelectorAll(GATED_SELECTOR).forEach((gatedNode) => {
                const category = gatedNode.dataset.consentCategory || 'essential';
                if (this.isAllowed(category)) {
                  if (gatedNode.tagName === 'SCRIPT') {
                    replaceWithScript(gatedNode, this.config);
                  }
                  if (gatedNode.tagName === 'IFRAME') {
                    replaceWithIFrame(gatedNode);
                  }
                } else {
                  gatedNode.setAttribute('inert', '');
                  gatedNode.dataset.consentBlocked = '1';
                }
              });
            }
          }
        }
      });

      if (window.MutationObserver) {
        this.observer.observe(document.documentElement || document.body, {
          childList: true,
          subtree: true
        });
      }

      if (isGPC()) {
        this.rejectNonEssential();
      }

      return this;
    }
  }

  const api = {
    init(config = {}) {
      const manager = new ConsentBarManager(config);
      return manager.init();
    }
  };

  window.ConsentBar = api;
  if (typeof module !== 'undefined') {
    module.exports = api;
  }
})();
