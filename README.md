# LinkPeek

**A REX Technologies product.**

LinkPeek is a Chromium/Helium browser extension that lets you hover a link and browse the media behind it without leaving the page.

It is designed around one-handed touchpad use: two-finger browse, horizontal scrub, pinch-style zoom, zoom-at-pointer, grid/focus views, pinning, whole-thread scanning for supported forums, and a deep settings model for people who want to tune everything.

## What it does

- classifies hovered destinations instead of blindly collecting every `<img>`
- recognizes direct media, Discourse topics and generic pages
- scans Discourse post streams and extracts posted media from post content
- prefers lightbox/original assets while using optimized images for fast previews
- filters avatars, emoji, icons and other page chrome
- deduplicates repeated media
- renders its UI inside Shadow DOM so page CSS cannot break it
- gives trackpads first-class navigation, zoom and scrub behavior
- keeps every action under one hand: mouse back/forward buttons step through media, middle-click opens the original in a background tab, W fills the panel, R rotates, Shift+D downloads the whole gallery into one folder
- shows a small countdown ring beside the pointer while a link arms, lit when its gallery is already prepared
- won't switch previews when the pointer crosses another link on the way into the panel
- prepares the links you are likely to hover next, scaled to the device and eased off when the page is busy
- has a preload inspector (Ctrl+X, then X) that outlines every link by state and lets you raise a link's priority
- steps through a linked page's own list with N when a gallery came from linked pages
- ships interactive onboarding, persistent controls help and searchable settings
- supports presets and per-site profiles
- stores preferences locally and has no LinkPeek account, analytics backend or ad service

## Install

The project site publishes the packaged extension itself:

**https://tochi-mba.github.io/LinkPeek/**

The primary download is `LinkPeek.crx`, not a source ZIP.

For Helium and other Chromium-family browsers, **do not double-click/open a self-hosted CRX directly**. Chromium may reject that path with `CRX_REQUIRED_PROOF_MISSING` because the package does not carry Chrome Web Store proof. Instead:

1. Download `LinkPeek.crx`.
2. Open `chrome://extensions`.
3. Enable Developer mode.
4. Drag `LinkPeek.crx` onto the Extensions page and approve the install prompt.

A true one-click install from a normal web page requires distribution through a browser extension store that supplies the required store proof.

For a stable extension identity across packaged releases, configure the repository secret `LINKPEEK_CRX_KEY_B64` with the base64-encoded PEM private key used to package the CRX. The Pages workflow uses it automatically. If the secret is absent, CI can still produce a development CRX but its extension ID may change between builds.

## Development

Requirements: Node 22+ and Chromium.

```bash
npm install
npm run check
npx playwright install --with-deps chromium
npm run test:e2e
npm run build
```

Load `dist/` as an unpacked extension for local development.

### Commands

- `npm run typecheck` — TypeScript validation
- `npm test` — unit tests
- `npm run test:e2e` — builds then runs Chromium extension E2E tests
- `npm run build` — produces the Manifest V3 extension in `dist/`
- `node scripts/check_site.mjs` — checks internal GitHub Pages links
- `npm run package` — creates a development ZIP for debugging only; public distribution uses CRX

## Architecture

```text
src/
  background.ts          service worker: scans, caches, GIF bytes, downloads, tabs
  content.ts             content-script entry
  content/
    controller.ts        wires intent, preparation, the viewer and the inspector
    hover-intent.ts      when a hover means "open", switch protection, countdown
    link-prefetcher.ts   prepares likely links within the resource budget
    resource-governor.ts device tier and live headroom -> budget
    preload-inspector.ts bottom-left inspector and link outlines
    image-warmer.ts      thumbnail warming
  core/
    http.ts              timeouts, short retries, capped reads
    discourse.ts         Discourse whole-thread adapter
    generic.ts           generic HTML/direct-media adapter and linked-page search
    extract.ts           media extraction + deduplication
  shared/
    media.ts             media/link types and helpers
    settings.ts          settings model, validation, shortcuts and site profiles
    settings-migration.ts
    theme.ts             REX Technologies ink/signal tokens
  ui/
    viewer.ts            Shadow-DOM preview/gallery
    viewer-markup.ts     viewer HTML, help sheet
    virtual-grid.ts      grid view that renders only visible tiles
    gesture.ts           trackpad gesture state machine
    gif-player.ts        frame-accurate GIF playback
    media-preloader.ts   decoded-media window around the current item
    styles.ts            injected viewer UI
  pages/
    popup.ts
    options.ts, settings-schema.ts
    onboarding.ts
site/                  GitHub Pages product/help/privacy site
tests/
  unit/
  e2e/
```

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for the design constraints.

## REX design system

LinkPeek uses the REX Technologies ink/signal system shared by the other REX products:

| Token | Value |
| --- | --- |
| Ink | `#080A09` |
| Panel | `#111512` |
| Raised | `#181E19` |
| Line | `#29302A` |
| Text | `#F2F5EE` |
| Muted | `#858D83` |
| Signal | `#D7FF3F` |
| Live | `#FF774D` |

The system is dark by design. Signal is earned attention, not decoration.

## Privacy

There is no LinkPeek backend. Network requests go directly to destinations/media hosts needed for a preview. Preferences live in extension storage. See [docs/PRIVACY.md](docs/PRIVACY.md) and the public Privacy page.

## License

MIT. Copyright REX Technologies.
