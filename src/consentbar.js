import {
  normalizeConfig,
  normalizeState,
  allowCategory
} from './policy.js';

const GATED_SELECTOR = 'script[data-consent-category], iframe[data-consent-category], script[type="text/plain"]';
const DAY_MS = 24 * 60 * 60 * 1000;

const DEFAULT_OPTIONS = {
  config: {}
};

function isBrowserContext(context = {}) {
  return !!(context.document || (typeof document !== 'undefined' && document?.querySelector));
}

function makeStorage(config, context) {
  if (context?.storage) {
    return context.storage;
  }

  try {
    if (typeof localStorage !== 'undefined') {
      return {
        getItem: (k) => localStorage.getItem(k),
        setItem: (k, v) => localStorage.setItem(k, v),
        removeItem: (k) => localStorage.removeItem(k)
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
    this.context = context;
    this.config = normalizeConfig(config);
    this.document = context.document || (typeof document !== 'undefined' ? document : null);
    this.window = context.window || (typeof window !== 'undefined' ? window : null);
    this.storage = makeStorage(this.config.storage, context);
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

    base.grants = {
      essential: true,
      statistics: Boolean(overrides.grants?.statistics ?? this.state.grants.statistics),
      marketing: Boolean(overrides.grants?.marketing ?? this.state.grants.marketing),
      preferences: Boolean(overrides.grants?.preferences ?? this.state.grants.preferences)
    };
    base.source = overrides.source || 'user';
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
    if (node instanceof this.document.defaultView.HTMLScriptElement) {
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

export function createManager(config = {}, context = {}) {
  if (sharedInstance) {
    return sharedInstance;
  }

  sharedInstance = new ConsentBarManager(config, context);
  return sharedInstance;
}

export function init(config = {}, context = {}) {
  const manager = createManager(config, context);
  manager.init();
  return manager;
}

export function reset() {
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

export { ConsentBarManager };
