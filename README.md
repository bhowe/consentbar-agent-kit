# consentbar-agent-kit

Consent bar toolkit for AI agents: strict opt-in by default, free, no runtime dependencies, and browser-side only (JS/CSS).

## Core ideas

- Safe default: essential only, everything else off.
- Vendor-neutral and standalone.
- Safe markup rules (strict):
  - `data-consent-category` tags must use `data-consent-src` and must not keep a normal `src`.
  - `data-consent-src` tags must always include a valid `data-consent-category`.
  - Inline `script` tags for consent gating must set `type="text/plain"` when no `data-consent-src` is present.
- Persistent, versioned consent with expiry.
- Global Privacy Control (GPC) awareness.
- Manage-preferences button API and DOM update events.

## Quick start

```bash
node ./bin/consentbar.js init
node ./bin/consentbar.js validate consentbar.config.json
node ./bin/consentbar.js audit examples/basic/index.html
```
or via npm scripts:

```bash
npm run validate
npm run audit
npm run build
```

Open `examples/basic/index.html` with a local server and interact with the buttons.

## JSON schema

The CLI validates against:
`src/schema/consent-config.schema.json`

## API quick notes

Load `dist/consentbar.js` and initialize with:

```html
<script src="../dist/consentbar.js" data-consentbar></script>
<script>
  ConsentBar.init({
    policyUrl: '/privacy',
    policyVersion: '2026-07-29'
  });
</script>
```

### Events

- `window` event `consentchange`
- `window` event `consent:updated`

Details include `detail.grants`, `detail.version`, and `detail.reason`.

## Audit CLI

`audit <html-or-dir>` checks:
- loader marker before consent-gated nodes,
- any consent-gated script/iframe with an ordinary `src` fails (must use `data-consent-src`),
- categoryless `data-consent-src` tags,
- inline scripted content with `data-consent-category` that is not `type="text/plain"`,
- presence of policy link,
- presence of accept/reject/manage controls.

Non-zero exit code = failures.

## Legal note

This toolkit is a technical implementation helper, not legal advice. Privacy compliance still depends on your policy and implementation context.
