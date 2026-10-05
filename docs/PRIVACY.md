# Privacy

LinkPeek is designed to work without a LinkPeek server.

## Data stored

The extension stores settings, presets, shortcut mappings and per-site profiles using browser extension storage. Scan results are cached in the service worker's memory and disappear with that process.

## Network requests

When a user intentionally previews a link, or when enabled prefetch selects a nearby link, LinkPeek requests that destination directly. Balanced mode can warm up to three preview thumbnails from each selected nearby link before hover. For the link currently under the pointer, it can also begin the default same-site fallback during the hover delay when the root page contains no qualifying media. That hovered gallery prepares its first viewing set immediately, then may warm up to 60 unique thumbnails in batches scheduled during browser idle time. Nearby links that are not under the pointer receive only the shallow root-page check. Cross-site recursion requires selecting the Any site mode. Requests are bounded by the configured depth, page, concurrency, gallery, and memory limits. Data Saver and browser-reported constrained connections skip speculative background work. On Discourse it may request the topic JSON; additional post batches are fetched when the preview opens. Media previews load from the site's media hosts.

LinkPeek does not send those destinations to REX Technologies.

## Permissions

- `storage`: preferences and profiles
- `downloads`: explicit original-media downloads
- host access: cross-origin scanning of destinations the user asks LinkPeek to inspect

## Analytics

None by default. There is no telemetry endpoint in the extension.

## Controls

Prefetch and linked-page fallback can be disabled independently. Recursive depth, page count, total gallery size, cache lifetime, tracking-parameter stripping, and referrer behavior are configurable. A site can be disabled from the toolbar popup or overridden through a site profile.
