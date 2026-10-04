# LinkPeek — working conventions

LinkPeek is a REX Technologies product.

## Product rules

- One-handed touchpad use is the default interaction model, not an optional mode.
- Hover must never feel sticky or accidental. Keep intent delays, cancellation and the bridge between link and panel intact.
- The preview path must prefer cheap thumbnails; originals are for explicit open/download or zoom workflows.
- Forum adapters should identify actual posted media. Do not regress to "collect every img".
- Unknown sites must fail soft through the generic adapter.
- Do not send browsing history, scans or settings to a LinkPeek service. There is no LinkPeek backend.
- Every user-visible interaction constant should come from the settings model unless it is a safety/integrity invariant.

## REX visual rules

Use the shared ink/signal tokens. Do not re-pick colors and do not add a light REX theme.

- Ink #080A09
- Panel #111512
- Raised #181E19
- Line #29302A
- Text #F2F5EE
- Muted #858D83
- Signal #D7FF3F
- Live #FF774D

Tracked uppercase micro-labels are part of the system. Signal is reserved for active/ready/primary states.

## Before merging

Run:

```bash
npm run typecheck
npm test
npm run build
node scripts/check_site.mjs
npm run test:e2e
```

The E2E suite must load the built extension in Chromium; DOM-only tests are not enough for changes to hover behavior, extension pages or message passing.
