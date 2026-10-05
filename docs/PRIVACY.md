# Privacy

LinkPeek is designed to work without a LinkPeek server.

## Data stored

The extension stores settings, shortcut mappings, per-site profiles, saved links and the panel layout using browser extension storage. While "Skip media you have seen" is on, it also keeps a short fingerprint (a 64-bit hash, not the address) of each media item it has shown, up to about 36,000, so the shuffle never repeats them; Settings → Browsing a gallery has a button to forget them all. Scan results are cached in the service worker's memory and disappear with that process.

## Network requests

When a user intentionally previews a link, or when preparation selects a link the pointer is near or heading towards, LinkPeek requests that destination directly. How many links and thumbnails are prepared ahead depends on the device and on how busy the page is; in Auto mode a typical device prepares a few nearby links and a few thumbnails from each. For the link currently under the pointer, it can also begin the default same-site linked-page search during the hover delay when the page has no qualifying media, and may warm more of that gallery's thumbnails while the browser is idle. When a gallery came from linked pages, the next and previous linked pages may be prepared too. In Whole page mode (the default), the page's other links each get one quick check while the browser is idle, never retried. While the shuffle slideshow runs and the page has no more new media, it reads the pages that links lead to, and the links on those, a few at a time and never the same page twice. Cross-site linked-page search, and a shuffle that leaves the site, require selecting the Any site mode. Requests are bounded by the configured depth, page, concurrency, gallery, and memory limits. Data saver mode and browser-reported constrained connections skip speculative background work. A request you are waiting on may be retried up to twice when the site answers with a temporary error; background preparation is never retried. Links that sign out, unsubscribe or otherwise change state are never requested. On Discourse it may request the topic JSON; additional post batches are fetched when the preview opens. Media previews load from the site's media hosts.

LinkPeek does not send those destinations to REX Technologies.

## Permissions

- `storage`: preferences and profiles
- `downloads`: original-media downloads you ask for, one item or a whole gallery
- host access: cross-origin scanning of destinations the user asks LinkPeek to inspect

## Analytics

None by default. There is no telemetry endpoint in the extension.

## Controls

Preparation ahead of time and linked-page search can be disabled independently. The preload inspector shows what has been prepared on the current page. Recursive depth, page count, total gallery size, cache lifetime, tracking-parameter stripping, and referrer behavior are configurable. A site can be disabled from the toolbar popup or overridden through a site profile.
