# Releasing LinkPeek

LinkPeek is distributed from the project GitHub Pages site as a signed `LinkPeek.crx` package. Self-hosted Chromium CRXs must be installed from the browser's Extensions page rather than opened directly from the downloads folder.

## Release gate

Every release must pass:

```bash
npm run typecheck
npm test
npm run build
ALLOW_MISSING_DOWNLOADS=1 node scripts/check_site.mjs
npm run test:e2e
```

CI also packages the built extension with Chromium and verifies that a non-empty CRX is produced.

## Stable signing key

A CRX must be signed with the same private key on every release to keep the same extension ID and support upgrades.

Create the signing key once, keep it private, and store its base64-encoded PEM contents in the repository Actions secret:

```text
LINKPEEK_CRX_KEY_B64
```

The Pages workflow reads that secret only while packaging. Never commit the private key.

If the secret is absent, the workflow still produces a development CRX, but its extension ID may change on the next build.

With the configured key, LinkPeek's extension ID is `mejmafejflnbjbgiclfmlnnijchldeib`. Keep a private backup of the key: GitHub secrets cannot be read back, and a new key means a new ID (existing installs would not update in place).

## Pages

The release workflow copies:

```text
dist.crx -> site/downloads/LinkPeek.crx
```

and publishes `site/` through GitHub Pages. It also publishes `LinkPeek.crx.sha256`.

The public project URL is:

```text
https://tochi-mba.github.io/LinkPeek/
```

GitHub Pages must be configured to use **GitHub Actions** as its publishing source.


## Helium / Chromium installation behavior

Opening or double-clicking a self-hosted CRX can fail with `CRX_REQUIRED_PROOF_MISSING`. That error is the Chromium proof requirement for direct/off-store installation; changing the local signing key does not add Chrome Web Store proof.

Clicking a link to a `.crx` triggers the same direct install, so the site links `LinkPeek.zip` instead (`scripts/check_site.mjs` enforces this). The ZIP holds:

- `LinkPeek/`: the built extension for **Load unpacked**, with the signing key's public half as `manifest.key` when `LINKPEEK_CRX_KEY_B64` is set, so it gets the CRX's extension ID;
- `LinkPeek.crx`: the signed package, for dragging onto `chrome://extensions`;
- `INSTALL.txt` (from `packaging/`).

The supported install flow is: unzip, open `chrome://extensions`, enable Developer mode, **Load unpacked** the `LinkPeek` folder (or drag the CRX onto the page). The public site must not tell users to open or double-click the CRX.
