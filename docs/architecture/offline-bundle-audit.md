# Offline bundle audit

Source inspection for the standalone plan, checked on 2026-09-15 UTC. This is an initial dependency audit, not a completed inventory or an offline execution test. No model files were downloaded.

## Packaging requirement

The user's requirement is a complete release that can be transferred to an airgapped machine and run on its first launch. Build CI can fetch pinned inputs. The installed application must already contain every model, atlas, template, code dependency and runtime needed by its advertised methods. A warmed browser cache or a first-run model installer does not meet that requirement.

Use the same verified asset inventory for the full Electron suite, individual desktop packages, command-line archives and containers. Keep large source assets on Hugging Face, as repository policy requires; include their verified copies in release artifacts rather than Git.

## Concrete blockers found

| Area | Source evidence | Required packaging change |
| --- | --- | --- |
| Runtime CDN imports | MuscleMap, VesselBoost, SeedSeg and SCT workers dynamically import `localforage` from jsDelivr. See [MuscleMap](../../apps/musclemap/web/js/inference-worker.js), [VesselBoost](../../apps/vesselboost/web/js/inference-worker.js), [SeedSeg](../../apps/seedseg/web/js/inference-worker.js) and [SCT](../../apps/spinalcordtoolbox/web/js/inference-worker.js). | Bundle this dependency and check the built worker files for remote imports. |
| SeedSeg protocol validation | [The app](../../apps/seedseg/web/js/seedseg-app.js) imports the dicompare controller from its public site and supplies a public schema URL. | Ship the controller and the exact schema locally, including their dependencies. |
| Model fetches and cache assumptions | [VesselBoost configuration](../../apps/vesselboost/web/js/app/config.js), [SeedSeg configuration](../../apps/seedseg/web/js/app/config.js) and [MuscleMap's generated catalog](../../apps/musclemap/web/js/app/model-catalog.generated.js) point at remote weights. [SynthSeg's worker](../../apps/synthseg/src/inference-worker.js) fetches its configured model on a cache miss. [SynthSR's Node resolver](../../packages/synthsr/src/model.js) downloads when no local model is found unless offline mode is set. | Resolve packaged files directly by asset ID. A missing packaged asset must produce a local installation error, with no network fallback. |
| CALMaR needs more than ONNX files | [Its manifest](../../apps/calmar/web/models/manifest.json) includes atlas, template, annotation and connectome entries. The supported Schaefer400 connectome has 10 shards with `totalShardBytes: 118000000`; its index is only 53,613 bytes. [The atlas loader](../../apps/calmar/web/js/modules/atlas-loader.js) fetches remote assets and lazy shards. Several source URLs use `resolve/main`. | Recursively include every index and referenced shard for every supported method. Pin mutable source URLs to immutable revisions as build inputs. Packaging just the small index would leave an offline failure. |
| SCT models and templates live in a second manifest | [The central SCT manifest](../../models/spinalcordtoolbox.manifest.json) has an empty asset list and points to [the task manifest](../../apps/spinalcordtoolbox/web/models/manifest.json), which includes ONNX models, PAM50 templates and disc-model metadata. CALMaR has the same central-manifest indirection. | Inventory task-level manifests rather than interpreting an empty central list as no dependencies. |
| TopoFit uses model and geometry assets | [Its model manifest](../../packages/topofit/model.manifest.json) contains model graphs, hemisphere faces, templates, registration arrays and subdivision edges. [The cortex atlas manifest](../../packages/topofit/cortex-atlas.manifest.json) adds a separately pinned atlas. | Bundle both manifests' assets and preserve their geometry conventions. |
| dicompare already has an offline branch | [The worker](../../apps/dicompare/src/workers/pyodide.worker.ts) chooses local Pyodide and bundled wheels for `file:` or `app:` execution, but chooses a CDN for an ordinary loopback HTTP origin. [The package scripts](../../apps/dicompare/package.json) stage Pyodide before Electron builds. | Reuse its bundled Python dependency work. Make the suite's explicit offline asset configuration select the local branch regardless of hosting protocol. Verify the complete wheel dependency closure on a clean installation. |
| Shared generated runtimes | [Greedy](../../apps/greedy/scripts/copy-runtime.mjs), [ANTs](../../apps/ants/scripts/copy-runtime.mjs), [FireANTs](../../apps/fireants/scripts/copy-runtime.mjs) and [SYNcro](../../apps/syncro/scripts/copy-runtime-assets.mjs) stage the same named MindGrab runtime family. [BrowserQC](../../apps/browserqc/scripts/copy-brainchop.mjs) and [Brain2Print](../../apps/brain2print/scripts/copy-brainchop.mjs) stage the distinct `16chan18cls` family. | Preserve generated JavaScript/WASM adjacency and inventory any transitive assets. Deduplicate by content hash, keeping distinct model variants. |

## Measured manifest sizes

These are uncompressed asset byte counts recorded in selected checked-in manifests. They exclude Electron, runtime libraries and additional dependencies, and are not a suite download-size estimate. The inventory is incomplete across the catalog.

| Asset group | Recorded bytes | Evidence |
| --- | ---: | --- |
| SynthSR ONNX | 52,980,984 | [Model manifest](../../packages/synthsr/model.manifest.json) |
| SynthSeg ONNX | 52,983,030 | [Model manifest](../../packages/synthseg/model.manifest.json) |
| SeedSeg's four ensemble models | 361,981,524 | Sum of four `bytes` entries in [the manifest](../../models/seedseg.manifest.json) |
| VesselBoost's four variants plus SynthStrip | 115,631,939 | Sum of five entries in [the manifest](../../models/vesselboost.manifest.json) |
| TopoFit model and geometry manifest | 179,810,016 | Sum of `assets[].bytes` in [the manifest](../../packages/topofit/model.manifest.json) |
| TopoFit cortex atlas | 2,293,792 | [Atlas manifest](../../packages/topofit/cortex-atlas.manifest.json) |

Do not add all central manifests to estimate suite size. Some contain examples, some redirect elsewhere, and some models appear in more than one app. The generated MuscleMap catalog also includes a separately released model variant; its active choices must be reconciled with the central manifest before estimating coverage or size. See [the generated catalog](../../apps/musclemap/web/js/app/model-catalog.generated.js) and [the central manifest](../../models/musclemap.manifest.json).

There is concrete deduplication evidence. [SYNcro's asset definitions](../../packages/syncro/src/assets.js) import SynthSR's actual manifest. Its native SynthStrip asset has SHA-256 `7b8eeecf3793a6c4510b9f5270ecc03d9c3262d26e08d568203a651ab4b84074`, matching [VesselBoost](../../models/vesselboost.manifest.json) and [CALMaR](../../apps/calmar/web/models/manifest.json). One copy can satisfy those exact assets. The optimized [browser SynthStrip graph](../../models/syncro.manifest.json) has a different hash and needs a separate copy even though it serves the same method.

The inventory must retain per-asset license notices. For example, [SYNcro's manifest](../../models/syncro.manifest.json) records Apache-2.0 for the browser SynthStrip graph and FSL non-commercial terms for its MNI template. A suite cannot replace those with one blanket license.

## Electron and HPC boundary

Packaging the browser UI does not remove its hardware constraints. [dwi2trx](../../apps/dwi2trx/src/main.ts) requires WebGPU and subgroups for tracking; [Brain2Print](../../apps/brain2print/src/main.js) and [SynthSeg's browser UI](../../apps/synthseg/src/main.js) reject unavailable WebGPU. These need validation in the selected Electron version on each supported OS/GPU combination.

For HPC, expose file-based batch commands using the same scientific engines and bundled assets. Run without a graphical login or display server where the engine supports it. Where only a browser GPU execution path exists today, a headless adapter and hardware validation remain implementation work. An Electron installer alone does not demonstrate that a scheduler job works. SurfAnnotate and ZARRo also retain interactive workflows; a CLI should only promise operations those applications actually implement.

## Release checks to add

1. Generate an asset lockfile covering each app, each exposed method, all transitive asset references, size, SHA-256, immutable origin and license.
2. Build a content-addressed asset directory and package the full selected dependency set. The full suite selects every app and method; an individual app selects its complete set.
3. Start extracted artifacts with fresh user directories, empty caches and external networking denied. Test first launch and real input/output, then every optional method that selects another model or atlas.
4. Record attempted external requests as test failures during offline workflows. User-selected remote datasets and documentation links are separate online actions; local input paths must remain fully usable without them.
5. Test command archives and container images under the same network restriction. Ship complete OCI/Apptainer artifacts that can be transferred to the airgapped HPC, rather than requiring an image pull or model download there.

The next audit step is the generated, complete lockfile. Until that exists and extracted releases pass the offline tests, no exact suite size or all-app offline readiness claim is supported.
