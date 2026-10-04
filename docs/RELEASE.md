# Releasing LinkPeek

LinkPeek is distributed from the project GitHub Pages site as a browser-installable `LinkPeek.crx`.

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
