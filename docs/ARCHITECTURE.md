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

## Preparing links before they are opened

`ResourceGovernor` turns the device tier (memory, cores) and live headroom (long tasks, compute pressure, battery, heap, slow connections) into a `Budget`: how many nearby links to prepare, how many requests at once, how many thumbnails, how much decoded memory. Auto mode recomputes it as conditions change, so preparation backs off on its own when the page is busy.

`LinkPrefetcher` ranks visible links by distance from the pointer and the direction it is heading, and prepares the best few when the browser is idle. Then, in Whole page mode, it checks every other link on the page, those near the viewport first, one or two at a time and only while an idle period has time left. That pass pauses while a preview loads, when headroom drops below 0.75, and after consecutive failures (growing pauses). Off-screen links keep only a small summary, never evicting a gallery near the pointer. Hovered links get an urgent slot. A generation counter drops work from before a page change, waiting work is capped, and failures back off before being retried. When a gallery was built from linked pages, it also prepares the neighbours of the linked page being viewed so N is instant.

`PreloadInspector` is a read-only view of that state: it redraws at most every 200 ms, only when something changed, and rewrites outline attributes only on links whose state changed. Raising a link's priority goes back through the prefetcher.

## The shuffle

`ShuffleMix` keeps each link's unseen media in its own randomly ordered queue and picks every next item from a random link other than the last one. It also holds the frontier of links to explore: the page's links, then links found on pages read so far, each at most once. The controller tops the viewer up a few items ahead of the screen and reads more of the frontier, a few at a time, when the mix runs low. `SeenMedia` remembers what was shown as 64-bit hashes in 36 storage buckets, so recording an item rewrites a few kilobytes.

## Requests

`core/http.ts` gives every request a per-attempt timeout that also covers reading the body. Requests someone is waiting on are retried a couple of times on network errors and 408/429/502/503/504, honouring `Retry-After`, within a short time budget. Background preparation never retries. Page bodies are read with a byte cap.

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

`LinkPeekSettings` is the single source of truth for behavior. Storage keeps only the values that differ from the defaults (settings version 2; older full copies are migrated), so improved defaults reach everyone who never changed them. Every value is validated against its allowed choices or range. Global settings are overlaid by exact-host or wildcard site profiles.

## Release

The regular CI workflow typechecks, unit-tests, builds, checks the Pages site and runs browser E2E tests.

The Pages workflow repeats the release gate on `main`, packages the built extension as `LinkPeek.crx`, copies it into `site/downloads/`, and deploys that exact site artifact.

For stable CRX identity, configure `LINKPEEK_CRX_KEY_B64`.
