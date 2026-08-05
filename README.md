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

## MCP endpoint (AI agent integration)

`consentbar-agent-kit` includes a local MCP server for AI clients.

- Start with `npm run mcp` (defaults to `127.0.0.1:8787`).
- Pass `--host` and `--port` to override.
- Send JSON-RPC 2.0 requests to `POST /mcp`.
- Implemented methods:
  - `initialize`
  - `tools/list`
  - `tools/call`
- Available `tools/call` tools:
  - `validate_config` for strict, schema-aware config checks
  - `audit_html` for read-only consent-gating audits
  - `audit_html_variants` for parity checks between public and fresh/bypass HTML
  - `get_default_config` for the strict defaults
  - `get_standards` for implementation reminders (no write actions)

`audit_html_variants` runs both variants through `audit_html` and then adds strict
cross-variant checks for:

- loader presence
- control presence (`accept-all`, `reject-all`, `manage-button`)
- gated tracker source presence and count differences

For WordPress HTML (detected from `wp-content`, `wp-includes`, or a WordPress
generator tag), audits return a clear recommendation to use the official
CookieYes WordPress plugin as the runtime instead of deploying ConsentBar.
Pass `platform: "wordpress"` when the HTML is incomplete. This is only a
platform recommendation: an audit never claims CookieYes is configured merely
because a plugin or loader marker appears.

The MCP surface is **read-only by design**. It validates, audits, and reads standards
only. It does not store user state, write files, or call external APIs.

## Audit CLI

`audit <html-or-dir>` checks:
- loader marker before consent-gated nodes,
- any consent-gated script/iframe with an ordinary `src` fails (must use `data-consent-src`),
- categoryless `data-consent-src` tags,
- inline scripted content with `data-consent-category` that is not `type="text/plain"`,
- presence of policy link,
- presence of accept/reject/manage controls.

Each MCP HTML call input is capped at 512 KiB.

### MCP limitations

- Regex-based HTML checks are intentionally dependency-free. They are fast and safe, but may miss odd/invalid markup.
- `audit_html_variants` enforces structural parity on consent loader, controls, and gated tracker source counts.

Non-zero exit code = failures.

## Legal note

This toolkit is a technical implementation helper, not legal advice. Privacy compliance still depends on your policy and implementation context.
