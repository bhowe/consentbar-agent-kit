import test from 'node:test';
import assert from 'node:assert/strict';
import { createManager, reset } from '../src/consentbar.js';
import { normalizeConfig } from '../src/policy.js';

function makeMemoryStorage() {
  const memory = Object.create(null);
  return {
    getItem(key) {
      return key in memory ? memory[key] : null;
    },
    setItem(key, value) {
      memory[key] = String(value);
    },
    removeItem(key) {
      delete memory[key];
    }
  };
}

function makeFakeWindow(navigatorState = {}) {
  const HTMLScriptElement = function HTMLScriptElement() {};
  return {
    navigator: navigatorState,
    HTMLScriptElement,
    CustomEvent: class {
      constructor(_name, _detail) {
        return _name;
      }
    },
    dispatchEvent() {
      return true;
    },
    Element: class {}
  };
}

function makeConsentDocument(windowObj, nodes = []) {
  const query = (selector) => {
    const includes = (value, substr) => value.includes(substr);

    return nodes.filter((node) => {
      if (node.tagName === 'SCRIPT') {
        const scriptCategory = node.dataset && typeof node.dataset.consentCategory === 'string';
        const scriptConsentSrc = node.dataset && typeof node.dataset.consentSrc === 'string';

        if (includes(selector, 'script[data-consent-category]')) {
          return scriptCategory;
        }

        if (includes(selector, 'script[data-consent-src]')) {
          return scriptConsentSrc;
        }

        return false;
      }

      if (node.tagName === 'IFRAME') {
        const frameCategory = node.dataset && typeof node.dataset.consentCategory === 'string';
        const frameConsentSrc = node.dataset && typeof node.dataset.consentSrc === 'string';

        if (includes(selector, 'iframe[data-consent-category]')) {
          return frameCategory;
        }

        if (includes(selector, 'iframe[data-consent-src]')) {
          return frameConsentSrc;
        }

        return false;
      }

      return false;
    });
  };

  return {
    readyState: 'complete',
    defaultView: windowObj,
    querySelectorAll: query,
    querySelector: () => null,
    body: null,
    addEventListener: () => {},
    createElement: (tag) => ({
      tagName: tag.toUpperCase(),
      setAttribute: () => {},
      appendChild: () => {}
    }),
    documentElement: null
  };
}

function makeNodeWithGating(windowObj, { tagName, type = '', consentCategory, consentSrc } = {}) {
  const ctor = tagName === 'SCRIPT' ? windowObj.HTMLScriptElement : class {};
  const node = Object.create(ctor.prototype);
  node.tagName = tagName;
  node.type = type;
  node.dataset = {};
  if (consentCategory) {
    node.dataset.consentCategory = consentCategory;
  }
  if (consentSrc) {
    node.dataset.consentSrc = consentSrc;
  }
  node.attributes = [];
  node.dataset.consentBlocked = undefined;
  node.blocked = false;
  node.setAttributeCalls = [];
  node.setAttribute = (name, value) => {
    if (name === 'inert') {
      node.blocked = true;
    }
    node.setAttributeCalls.push([name, value]);
    node[name] = value;
  };

  return node;
}

function makeIframeNode(windowObj, options) {
  return makeNodeWithGating(windowObj, { tagName: 'IFRAME', ...options });
}

function makeScriptNode(windowObj, options) {
  return makeNodeWithGating(windowObj, { tagName: 'SCRIPT', ...options });
}

test('GPC reads from context.window.navigator', () => {
  reset();
  const config = normalizeConfig();
  const manager = createManager(config, {
    window: { navigator: { globalPrivacyControl: true } },
    storage: makeMemoryStorage()
  });

  manager.acceptAll();

  assert.equal(manager.state.grants.essential, true);
  assert.equal(manager.state.grants.statistics, false);
  assert.equal(manager.state.grants.marketing, false);
  assert.equal(manager.state.grants.preferences, false);
  assert.equal(manager.state.source, 'gpc');
});

test('GPC reads from context.document.defaultView.navigator', () => {
  reset();
  const fakeWindow = makeFakeWindow({ globalPrivacyControl: true });
  const config = normalizeConfig();
  const manager = createManager(config, {
    document: {
      defaultView: fakeWindow
    },
    storage: makeMemoryStorage()
  });

  manager.setCategoryConsent('statistics', true);

  assert.equal(manager.state.grants.statistics, false);
  assert.equal(manager.state.grants.marketing, false);
  assert.equal(manager.state.grants.preferences, false);
  assert.equal(manager.state.source, 'gpc');
});

test('unmarked script[type="text/plain"] is ignored by gating selector', () => {
  reset();
  const fakeWindow = makeFakeWindow();
  const markerNode = makeScriptNode(fakeWindow, {
    type: 'text/plain',
    consentCategory: 'statistics'
  });
  const plainTemplateNode = makeScriptNode(fakeWindow, {
    type: 'text/plain'
  });

  const fakeDocument = makeConsentDocument(fakeWindow, [markerNode, plainTemplateNode]);
  const config = normalizeConfig();
  const manager = createManager(config, {
    window: fakeWindow,
    document: fakeDocument,
    storage: makeMemoryStorage()
  });

  manager.applyConsentGates(fakeDocument);

  assert.equal(markerNode.dataset.consentBlocked, '1');
  assert.equal(plainTemplateNode.blocked, false);
  assert.equal(plainTemplateNode.dataset.consentBlocked, undefined);
});
