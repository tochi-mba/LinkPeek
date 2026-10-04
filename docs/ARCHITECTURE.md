# LinkPeek architecture

LinkPeek has three responsibilities that deliberately stay separate.

## 1. Detect intent on the page

The content script owns pointer intent, activation modes, cancellation, nearby prefetch and the injected viewer host. It does not make cross-origin fetches itself; it asks the Manifest V3 service worker to scan a destination.

The viewer is mounted in a Shadow DOM root to isolate LinkPeek from host-page CSS.

## 2. Understand the destination

`classifyLink` chooses a strategy before fetching:

- direct image
- direct video
- Discourse topic
- generic page
- same-document anchor
- unsupported/download

The Discourse adapter uses the topic JSON/post stream, then fetches missing posts in batches and parses their cooked post body. This avoids relying on whatever slice of an infinite-scroll thread happens to be mounted in the page.

The generic adapter is deliberately conservative and is a fallback, not a promise of perfect semantics on every website.

## 3. Browse media without losing context

The viewer is a focus-first gallery with optional grid mode. Its gesture controller accumulates trackpad wheel deltas and applies thresholds/cooldowns so one physical swipe does not become a dozen image changes.

Zoom is centered around the pointer and the transform stays local to the current media item.

## Media model

Every `MediaItem` carries:

- original URL
- preview URL
- source/post URL
- filename when known
- dimensions when known
- post number / author when known
- confidence score

Deduplication happens after extraction and before UI rendering.

## Settings

`LinkPeekSettings` is the single source of truth for behavior. Global settings are overlaid by exact-host or wildcard site profiles. Presets only write settings; they are not separate runtime modes.

## Release

The regular CI workflow typechecks, unit-tests, builds, checks the Pages site and runs browser E2E tests.

The Pages workflow repeats the release gate on `main`, packages the built extension as `LinkPeek.crx`, copies it into `site/downloads/`, and deploys that exact site artifact.

For stable CRX identity, configure `LINKPEEK_CRX_KEY_B64`.
