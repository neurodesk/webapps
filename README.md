# Neurodesk Webapps

One monorepo and one composite static site for the browser-native apps listed at
[neurodesk.org/getting-started/hosted/webapps](https://neurodesk.org/getting-started/hosted/webapps/).
Imaging data is processed locally in the browser and is not uploaded.

The complete catalog is generated from `registry/apps.yml`. It is the operational
source of truth for exact upstream commits, licences, maintainers, support status,
public paths, app shells, CI toolchains, release eligibility, and scientific assets.

## Architecture

- `apps/*` keeps app-specific scientific workers, workflows, and interfaces local.
- `packages/components` is the framework-free shared browser-imaging library.
- `packages/runtime-support` owns the cross-origin-isolation service worker.
- `packages/analytics` provides privacy-gated, allow-listed telemetry.
- `scripts/lib/apps-registry.mjs` is the validated catalog interface used by builds,
  tests, scaffolding, and deployment.
- `scripts/build-static.mjs` supports the native static apps; dicompare remains a
  React/Vite app and QSMbly retains its Rust/WASM build.
- `scripts/build-site.mjs` assembles every app into one `dist/` site.
- `runtime-assets/manifest.json` pins shared browser binaries by checksum; the
  composite site stores one copy below `dist/_runtime/` while standalone app builds
  remain self-contained.
- Large model weights are never committed or copied into `dist/`. They are fetched
  from `sbollmann/neurodesk-webapps-assets` on Hugging Face and cached by each app.

The shared library is adopted incrementally behind parity tests. Scientific workers,
preprocessing contracts, app-specific metrics, and pipeline definitions are not
forced into a generic abstraction.

## Development

Requirements: Node.js 22+, pnpm 11.7, Rust, and `wasm-pack` (for Rust/WASM apps).

```bash
pnpm install
pnpm test:registry
pnpm build
pnpm audit:artifacts
```

`pnpm build` produces:

```text
dist/
  index.html
  _runtime/
  <one directory per registry app>/
```

Individual packages use `pnpm --filter <id> dev|build|test`.

## Deployment

`.github/workflows/deploy-pages.yml` builds and deploys the single artifact to
GitHub Pages. Configure the custom domain `webapps.neurodesk.org` in repository
Pages settings and point its DNS CNAME at the GitHub Pages hostname.
The workflow verifies cross-origin isolation against the deployed Pages URL, not
only against a local server.

`.github/workflows/deploy-cloudflare.yml` is a manual alternative that uploads the
same artifact to one Cloudflare Pages project (`neurodesk-webapps`). Cloudflare can
apply the generated `_headers` file directly; GitHub Pages uses each imaging app's
COI service-worker fallback for cross-origin isolation.

`pnpm audit:artifacts` enforces site, app, file-count, per-file, and duplication
budgets. See [ADR-0002](docs/adr/0002-hosting-capacity-and-runtime-store.md) for the
capacity thresholds and migration trigger.

## Releases

The manual `release-apps` workflow accepts selected or Git-affected catalog apps,
then tests, builds, and publishes an independent standalone bundle for each app.
Tags use `<app>-v<version>` and all point to the same validated monorepo commit.
Each release includes that app's static browser bundle; large model weights remain
on Hugging Face and are fetched at runtime.

## Adding an app

Use `pnpm new-app <id>`, then add its runtime adapter and complete its catalog entry.
CI requires every catalog app to have a workspace package and any declared scientific
asset manifest to exist.

## Licensing

This is a mixed-licence monorepo. See each app/package licence and [LICENSES.md](LICENSES.md).
