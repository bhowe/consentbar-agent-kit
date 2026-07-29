# consentbar-agent-kit AGENTS

- Keep browser runtime dependency-free.
- Keep Node usage to CLI, validation, audits, and tests.
- Do not add runtime dependencies in dist or src browser bundles.
- Preserve strict opt-in behavior: essential default true, all other categories default false.
- Honor Global Privacy Control (GPC) when available.
- Any behavior that blocks trackers must be explicit with `data-consent-category` + `data-consent-src`.
