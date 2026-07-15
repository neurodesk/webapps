# Domain context

## Webapp

A browser-native Neurodesk tool published in the hosted webapp catalog. A webapp owns
its scientific workflow, worker messages, preprocessing, outputs, and specialist UI.

## App catalog

The validated `registry/apps.yml` inventory. It is the source of truth for public
paths, build adapters, source provenance, licences, and scientific asset manifests.

The catalog also owns each webapp's shell adapter, CI toolchains, maintainers,
support status, shared-runtime coverage, and release eligibility. Automation must
derive those facts from the catalog rather than repeat app lists in workflows or tests.

## Composite site

The single static artifact assembled under `dist/` and served from
`webapps.neurodesk.org`. Each webapp occupies one path below the site root.

## Scientific asset

A model, atlas, connectome, template, or large fixture. Large scientific assets live
on Hugging Face, are described by immutable manifests, and are not committed to Git.

## Shared browser-imaging runtime

Framework-free modules that are identical across at least two webapps and provide
leverage without absorbing app-specific scientific behavior. Adoption requires
parity tests against the app-local implementation.

## Runtime asset store

The versioned, same-origin files assembled once under `dist/_runtime/` and consumed
by multiple webapps in the composite site. Standalone app builds remain self-contained;
the composite-site adapter rewrites only its copied outputs to use the shared files.

## App plan

The generated CI and release selection derived from the app catalog plus the changed
paths in a commit range. App-local changes select that webapp; shared modules and build
infrastructure select every webapp that can be affected.
