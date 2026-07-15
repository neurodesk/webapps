# ADR-0002: Enforce hosting budgets and share immutable runtime assets

- Status: accepted
- Date: 2026-07-14

## Context

The catalog is expected to grow from tens to hundreds of browser applications.
Copying ONNX Runtime, dcm2niix, NIfTI readers, source maps, examples, and model data
into every app makes the composite artifact grow with the number of apps rather
than with the number of distinct runtime versions. A large single Pages artifact
also creates an operational cliff if capacity is checked only at deployment time.

## Decision

Standalone app builds remain self-contained. Composite builds verify checksums and
hoist shared runtime files into a versioned `/_runtime/` store, then rewrite only
the copied composite output. Scientific models, templates, and example NIfTI data
are immutable manifest entries fetched on demand.

The artifact audit fails above 750 MiB total, 100 MiB for an app, 20,000 files,
10 percent exact-content duplication, or the configured hosting per-file limit.
Treat 500 MiB total as the planning threshold: before crossing it, move immutable
app bundles and runtime assets to object storage/CDN and retain Pages as the small
catalog and release-pointer shell. A catalog with hundreds of apps should publish
content-addressed bundles independently rather than rebuild one ever-growing
artifact for each app change.

## Consequences

- Shared runtime changes intentionally select every affected consumer in CI.
- App-only changes test and release only the catalog-selected app.
- The nightly workflow still validates the complete integrated site.
- Artifact growth and accidental embedded scientific data fail before deployment.
- Migration is a measured capacity decision rather than an emergency host change.
