# ADR-0001: Deploy one composite static site

- Status: accepted
- Date: 2026-07-13

## Context

The hosted catalog contains seven heterogeneous webapps. The initial monorepo PR
proposed one Cloudflare Pages project and custom domain per app. Large scientific
assets make per-app artifacts expensive, while the desired public interface is one
discoverable webapps site.

## Decision

Build every catalog app behind its own workspace build adapter, then assemble one
static artifact at `webapps.neurodesk.org/<app-path>/`. GitHub Pages is the default
host. A single Cloudflare Pages project may deploy the identical artifact when direct
COOP/COEP response headers are preferred.

Large scientific assets are published to Hugging Face and never included in the site
artifact. App-specific scientific implementations stay local; shared runtime modules
are adopted only across real seams and behind parity tests.

## Consequences

- A single deploy is atomic across the catalog and cannot race between app projects.
- Existing per-app domains can redirect to the corresponding composite path.
- GitHub Pages relies on the existing COI service-worker fallback; Cloudflare can
  apply `_headers` directly.
- Every app must support a non-root public base path.
