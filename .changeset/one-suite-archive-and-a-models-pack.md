---
"@neurodesk/desktop": minor
---

Replace the two suite editions with one platform archive plus one platform-independent model pack.

The models-included edition embedded the same ~2.0 GB of model files in all four platform archives, which uploaded about 6 GB of identical bytes per release. The models now ship once as `webapps-VERSION-models.tar.gz`, whose entries are the sha256-named files the application already keeps in its model cache.

`createModelResolver` takes an optional pack directory and checks it before the cache and before any network fetch. A matching file is served where it is, so the pack can be read-only and shared. Set `NEURODESK_MODELS_DIR` to the absolute path of the extracted pack for a fully offline install, or bind-mount one shared pack into every HPC job.

The published catalog `suite` now carries four platform downloads plus a `models` record, and the per-download `modelsIncluded` edition flag is gone.
