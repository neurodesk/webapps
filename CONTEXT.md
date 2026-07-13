# Domain context

## Webapp

A browser-native Neurodesk tool published in the hosted webapp catalog. A webapp owns
its scientific workflow, worker messages, preprocessing, outputs, and specialist UI.

## App catalog

The validated `registry/apps.yml` inventory. It is the source of truth for public
paths, build adapters, source provenance, licences, and scientific asset manifests.

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
