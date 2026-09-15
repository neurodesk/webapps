# Standalone releases for every app

Planning snapshot checked on 2026-09-15 UTC, 2026-09-14 in Los Angeles. This is the requested plan before implementation. No application code, public releases, or containers are changed by this document.

## Outcome

All 24 catalog apps get a Standalone action with ready-to-run GitHub downloads and a verified Neurodesk container option where one exists. The primary desktop deliverable is one Neurodesk Webapps Electron application containing the entire catalog. Individual Electron apps are generated subsets of the same build. Each batch app also gets an executable command for HPC. Every distribution includes its required models and runtime assets and works from a fresh installation without downloads. Source compilation instructions do not satisfy standalone delivery.

The [shared desktop architecture](webapps-desktop-architecture.md) incorporates the user's clarified airgap requirement and takes precedence over the earlier proposal to download models during setup. It describes the suite, individual app packages, complete offline installation sets and HPC execution.

Remove the lightNIIng link from the shared application bar across hosted, development, and packaged apps. Keep the ecosystem statement and link in About, which the repository requires.

This plan supersedes the coverage and delivery order in [the earlier offline executable plan](offline-executables.md). In particular, SurfAnnotate and ZARRo are included.

## What is actually released

I queried the first 100 entries from the [official GitHub release API](https://api.github.com/repos/neurodesk/webapps/releases?per_page=100), inspected asset names, and read the native workflows. This verifies publication metadata, not the contents or scientific behavior of downloaded binaries.

| App | Verified release with native assets | Gap |
| --- | --- | --- |
| Greedy | [0.2.20260914](https://github.com/neurodesk/webapps/releases/tag/greedy-v0.2.20260914), macOS ARM64, Linux x64, Windows x64, npm tarball, checksums and validation files | This checkout's Standalone dialog still tells users to compile it. Replace that text with verified downloads. |
| SynthSR | [0.3.20260910](https://github.com/neurodesk/webapps/releases/tag/synthsr-v0.3.20260910), all three native platforms | The newer 0.3.20260914 release contains only a web ZIP. The UI constructs native URLs from its package version, so it can link to nonexistent assets. |
| SynthSeg | [0.2.20260910](https://github.com/neurodesk/webapps/releases/tag/synthseg-v0.2.20260910), macOS ARM64 installer | The newer 0.2.20260914 release contains only a web ZIP. Add Linux and Windows packaging and replace compilation instructions. |
| SYNcro | [0.2.20260910](https://github.com/neurodesk/webapps/releases/tag/syncro-v0.2.20260910), Linux x64 and Windows x64 | The newer 0.2.20260914 release contains only a web ZIP. Add macOS packaging and close the Node/browser workflow differences. |
| Other 20 apps | No native assets found in this inspected release window | Existing web ZIPs are self-hosting bundles. They do not meet this request for executables. EdgeReg also has `ci.release: false` in the catalog. |

The current [web release workflow](../../.github/workflows/release.yml) creates public releases independently of native packaging. Fixing that ordering is part of this work.

## Build and distribution decisions

The initial required targets match Greedy: macOS ARM64, Linux x64, and Windows x64. Build and execute each artifact on its own target. CPU is the baseline where the engine supports it. Preserve Metal on Apple Silicon and explicitly identify GPU requirements where they are essential. Additional architectures are separate work, not implied support.

Use four existing or shared packaging paths:

1. **Rust or C/C++ executable.** Compile the existing scientific core with locked dependencies. Ship required runtime libraries, notices, and a small fixture. Use Greedy's release layout and SynthSR's signed, notarized macOS installer path.
2. **Compiled launcher with a private Node runtime.** Generalize [SYNcro's portable packaging](syncro-native-releases.md). Ship the JavaScript pipeline, pinned Node, ONNX Runtime native libraries where needed, and adjacent WASM assets. Users install neither Node nor npm. Reuse the scientific implementation instead of rewriting each pipeline in Rust just to obtain an executable.
3. **Desktop executable with bundled Chromium.** Build one shared Electron host for all 24 apps, using dicompare's packaging experience. Ship the built local apps, one runtime, and all required models/assets. Generate per-app installers from this same host. Electron supports packaged applications and installers, as described in its [official distribution documentation](https://www.electronjs.org/docs/latest/tutorial/tutorial-packaging). Packaged GPU execution still needs target-hardware testing. A hidden Electron window is not sufficient proof of headless HPC support; use the separate execution profiles in the desktop architecture.
4. **Bundled Python command where Python is already authoritative.** For dicompare's batch engine, freeze the pinned Python entry point and interpreter with PyInstaller, built on each OS. Its [official documentation](https://pyinstaller.org/en/stable/operating-mode.html) explains that users need no Python installation and that builds are OS-specific. This supplements dicompare's existing desktop app.

These are runnable binary distributions. Some contain private runtimes and several files, as SYNcro already does. A source ZIP, a web ZIP, a Dockerfile, an npm-only install, or a compiler command is not the deliverable.

### Models and runtime assets

Keep model sources and validation datasets on the pinned Hugging Face dataset, and keep generated runtime output out of Git. CI fetches and verifies assets while building the release. The desktop, CLI and container artifacts include the actual models, templates, atlases, external tensor files and runtime dependencies for every supported method. Deduplicate only byte-identical assets by hash. Installation and the first scientific run must work with networking disabled and empty caches. There is no setup-time model download or missing-asset network fallback. Bundle JavaScript, WASM, Python wheels and all other execution dependencies. ZARRo may use remote datasets by explicit choice; local Zarr input works offline.

### One release catalog

Add `registry/app-standalone.yml` and a validated loader, keyed by the canonical app IDs. Store the verified suite, individual desktop and native release tags, platform asset names and checksums, command examples, runtime requirements, included model hashes and container mappings. A native version may temporarily trail the web version, but the dialog must show that explicitly. Never derive unverified native URLs from the current web version or an ambiguous repository-wide `latest` release.

Build a candidate manifest from CI artifacts, verify it against the published GitHub assets, then promote it into the site. Release jobs must require all promised platform artifacts, their scientific checks, and macOS signing before claiming a complete standalone release. Keep the prior verified native release selected until the replacement is complete. Record engine and model versions so a published older executable cannot be presented as matching a newer method without validation.

## App-by-app executable plan

Every row is included in the shared Electron suite and can be packaged as an individual Electron app with its models. The table below describes additional native/CLI work and special desktop adaptations, not exclusions from desktop coverage. All rows target the three desktop platforms above. Headless GPU and browser-runtime adapters remain release gates for HPC batch claims; SurfAnnotate and ZARRo use graphical HPC sessions. The container assignment for every row is in the next section and the linked evidence document. New module paths below are proposals; linked source paths already exist.

| App | How to build the executable | Required workflow and release check |
| --- | --- | --- |
| MuscleMap | Extract file-based orchestration from [the inference worker](../../apps/musclemap/web/js/inference-worker.js). Package it with the shared native launcher, Node, ONNX Runtime CPU, and the complete checksum-pinned model files. Reuse shared geometry and metrics code. | Run the supported 2D and 3D models; verify segmentation, restored geometry, fat/IMF measurements and exported tables against browser reference runs. |
| VesselBoost | Add `packages/vesselboost` and `exes/vesselboost` using the same launcher. Adapt [the worker](../../apps/vesselboost/web/js/inference-worker.js) to filesystem I/O and ONNX Runtime CPU. Compile [its Rust preprocessing](../../apps/vesselboost/rust-preprocessing/Cargo.toml) for a Node-compatible WASM target, separating browser bindings where required. | Include N4, brain extraction, optional NLM, 0.3 mm resampling, sliding-window inference, thresholding, connected components and inverse orientation. Test skipped and enabled stages. Release the full pipeline, not just ONNX inference. |
| Spinal Cord Toolbox | Wrap [the existing pipeline](../../apps/spinalcordtoolbox/web/js/inference-pipeline.js) with the Node/ONNX Runtime packaging path and explicit local assets. Reuse existing Node inference tests as the extraction starting point. | Cover every exposed segmentation, labeling and lesion workflow with matching models and measurements. An upstream SCT command alone does not prove browser parity. |
| CALMaR | Extract the file/report entry point from [the inference pipeline](../../apps/calmar/web/js/inference-pipeline.js). Package Node, inference runtimes, registration kernels and local atlas resolution together. | Verify lesion mapping, registration, atlas summaries and report output against the existing miniature reference fixtures. Include every model, atlas and connectome shard required by all offered stages. |
| QSMbly | Add a native Rust CLI using the exact `qsm-core` and `qsmxt-config` pins in [the current WASM crate](../../apps/qsmbly/rust-wasm/Cargo.toml). Reuse the configuration and sequence in [the QSM worker](../../apps/qsmbly/js/qsm-worker-pure.js). | Cover field mapping, masks, background removal, inversion and referencing for every selectable method. Test generated configuration compatibility and magnitude/phase orientation. |
| SeedSeg | Extract [the worker pipeline](../../apps/seedseg/web/js/inference-worker.js) and package the shared launcher, Node and ONNX Runtime CPU. | Match cropping, normalization, connected components and restored fiducial coordinates, including empty detections. |
| dicompare | Restore [existing Electron builds](../../apps/dicompare/package.json) into active monorepo release CI with bundled Pyodide/wheels. Add a frozen Python batch command for the pinned engine used by [the worker](../../apps/dicompare/src/workers/pyodide.worker.ts). | Desktop schema editing, protocol comparisons and report export work offline. Batch output matches the same schemas and engine version. The old workflow under `legacy-ci` is not active release coverage. |
| Deface | Package the existing [application pipeline](../../apps/deface/src/main.ts) with the shared Electron runner and a batch entry point. Bundle niimath and the exact MindGrab assets; retain the current GPU path instead of silently substituting another extractor. | Exercise allineate, robust-FOV, Hellinger and MindGrab variants, including the 8 mm shell options. Preserve datatype and geometry. Check the actual output image for every method. |
| Easy MP2RAGE | Compile the existing [Rust CLI](../../apps/easy-mp2rage/crates/mp2rage-cli/Cargo.toml), `mp2rage-t1map`, on each target. Synchronize workspace and app date versions and reuse native packaging. | Run the existing pipeline parity tests for T1 mapping, B1 correction and UNI denoising from the extracted distributions. |
| NiiMath | Build pinned upstream C/C++ niimath source corresponding to the browser dependency and package the native command. Add the source pin and notices to this repository's release build inputs. | Verify the operations offered in the app, supported file types and output datatypes. Do not assume an arbitrary installed niimath has the same feature set. |
| MRI2VID, `dicom2vid` | Use the shared Electron runner for [the browser pipeline](../../apps/dicom2vid/web/js/pipeline.js) and [encoder](../../apps/dicom2vid/web/js/encode.js), with desktop and command modes. Bundle a tested encoder if the selected Chromium build lacks the required codec. | Test DICOM, NIfTI and MGZ, orientation, frame order, windowing, frame rate and playable exported video. The existing Python script is a useful DICOM reference but does not by itself cover the app's full input contract. |
| BrowserQC | Package the Node launcher with filesystem adapters, a pinned CPU-capable MindGrab runtime and [the shared QC calculations](../../apps/browserqc/src/qc.ts). The first implementation task must prove the exact MindGrab model works outside its browser worker. If it cannot, use the shared Electron runner without changing the scientific model. | Match 16chan18cls segmentation, geometry, metrics and exported report. A generic MRIQC container is a different analysis. |
| SurfAnnotate | Build a desktop application from [the existing app](../../apps/surfannotate/src/main.js) using the shared Electron package. Add local file-open/save integration and bundle all renderer assets. | Import surfaces, draw/select an ROI, export it, reopen it, and compare vertex IDs. This is an interactive executable, with no invented batch equivalent. |
| ZARRo | Build the [existing viewer](../../apps/zarro) with the shared Electron package. Add local directory access for Zarr stores and preserve explicit remote-store access. | Open local multiscale data offline; test remote ranges, measurements, navigation and saved output where supported. Desktop GPU rendering must pass on all targets. |
| SynthSR | Extend and reuse [the existing native implementation](../../exes/synthsr) and [release workflow](../../.github/workflows/synthsr-native.yml). Keep CPU everywhere and native Metal on Apple Silicon. | Reuse the numerical parity gates and extracted-package tests. Publish a complete current native release, then replace version-derived URLs with the verified catalog. |
| SynthSeg | Extend [the Rust CLI](../../exes/synthseg) and [macOS workflow](../../.github/workflows/synthseg-native.yml) with Linux and Windows builds using SynthSR's portable archive pattern. Package the required ONNX Runtime libraries and model exactly as the CLI expects. | Preserve f64 preprocessing, shared browser/native pre/postprocessing and the existing parity thresholds. Test default, fast and CT modes from each installed artifact. Existing macOS downloads can replace compile instructions immediately during implementation. |
| SYNcro | Extend [the compiled launcher](../../exes/syncro) to macOS ARM64 and reuse notarized installer packaging. Update [the Node adapter](../../packages/syncro/src/node.js) to implement the current shared pipeline options before advertising full parity. | Cover MindGrab/SynthStrip, Greedy/ANTs and the pathological-image plus lesion workflows. Current Node restrictions on additional inputs and engine selection must be resolved, not hidden by packaging. |
| dwi2trx | Package the current TypeScript pipeline with the shared Electron executable and a batch adapter. Bundle the vendored dtifit-enabled niimath and the pinned `@dipy/gpu-streamlines` runtime used in [main.ts](../../apps/dwi2trx/src/main.ts). | Run tensor fitting, gradient handling, tracking and TRX export on hardware with WebGPU subgroups on every target. Preserve radiological bvec handling. GPU tracking remains a stated requirement; a DIPY container is an alternative until parity is measured. |
| EdgeReg | Extract the niimath orchestration from [the app](../../apps/edgereg/src/main.js), package it with the compiled Node launcher and pinned engine, and enable catalog release CI. | Match affine estimation, output transforms and reslicing for supplied and brain-extracted inputs. Verify registration on a known transformed volume. |
| Greedy | Retain [the Rust workspace](../../exes/greedy) and [existing native distribution](../../.github/workflows/greedy-native.yml). Fix the dialog to point to the actual published binaries. | Keep affine/nonlinear and reslicing gates. Label the CLI's expected prepared inputs until the browser's optional brain-extraction orchestration is included and tested. |
| ANTs | Build a compiled Node launcher around [the existing registration package](../../packages/registration/README.md), shipping its pinned ANTs WASM kernel and helper files. Add an app command for registration and transform application. | Preserve the ANTsPy SyN schedule, seed, interpolation and gzip handling. State the WASM 4 GiB limit. Offer the full native ANTs container for larger jobs with its actual version shown. |
| Brain2Print | Extract the pipeline from [main.js](../../apps/brain2print/src/main.js) into the shared Electron batch runner, preserving MindGrab and niimath meshing. Bundle runtime dependencies and resolve weights explicitly. | Test both handedness fixtures, segmentation, mesh cleanup, watertightness and STL/OBJ/MZ3 export against [the existing mesh checks](../../apps/brain2print/src/mesh.js). |
| TopoFit | Add a Node/ONNX Runtime adapter for the injected `loadAsset`, `createSession` and `Tensor` interfaces in [the pipeline](../../packages/topofit/src/pipeline.js). Ship it through the compiled Node launcher with local model/template resolution and conforming/meshing dependencies. | Preserve white/pial/registration surfaces, conforming, patches, topology and geometry checks. Validate the large feature tensors on all targets; successful packaging is insufficient. |
| FireANTs | Package the pinned `@fireants/fireants` CPU/WASM entry point through the compiled Node launcher after proving its headless API. If its worker contract is browser-only, use the shared Electron runner with that same kernel. | Match all offered registration modes, warps, resampling and optional brain extraction. Test CPU on every target and validate GPU separately. Upstream Python FireANTs is not automatically identical to this C/WASM implementation. |

## Container assignments

Container research and version verification are recorded in [standalone-container-research.md](standalone-container-research.md). The final assignment table follows that evidence. An existing recipe alone is not proof of a downloadable image. Before activating a container link, pin its published tag and digest and run its advertised command.

The versions below have accepted Neurodesk release records. Full dated release IDs and immutable source links are in the evidence document. "New" means a proposed container that still needs publishing.

| App | Assigned Neurodesk container | Work or qualification |
| --- | --- | --- |
| MuscleMap | `musclemap` 1.4.0 | Verify the browser models and metrics against this release. |
| VesselBoost | `vesselboost` 2.0.64 | Available upstream prediction workflow; validate model and preprocessing correspondence. |
| Spinal Cord Toolbox | `spinalcordtoolbox` 7.3.3 | Assign the released CPU variant; separately verify any GPU variant. |
| CALMaR | New `calmar` | Package the completed Linux pipeline. |
| QSMbly | Existing `qsmbly` 0.11.0; `qsmxt` 9.11.0 for batch configuration validation | The old QSMbly image serves a local web app. Update it to include the new native CLI; validate QSMxT against the current config pin. |
| SeedSeg | Pending `prostatefiducialseg` 7.1.0 | Existing recipe, no verified accepted release. Complete its publication and model comparison. |
| dicompare | `dicompare` 0.5.4 | Existing local web-server workflow; update for current engine/schema compatibility. |
| Deface | New `deface` | Include all app methods. NiiMath can supply the affine engine after capability checks; pydeface is a different method. |
| Easy MP2RAGE | New `easy-mp2rage` | Consume the released Rust command. |
| NiiMath | `niimath` 1.0.20260703 | Verify each offered native operation. |
| MRI2VID | New `dicom2vid` | Include the converter and tested video encoder. |
| BrowserQC | New `browserqc` | Include the exact segmentation model and metrics. |
| SurfAnnotate | New `surfannotate` | Graphical Neurodesk application with local file integration. |
| ZARRo | New `zarro` | Graphical Neurodesk application with local and remote Zarr support. |
| SynthSR | `freesurfer` 8.2.0; new `synthsr` for the Rust implementation | Label FreeSurfer as the available upstream option. |
| SynthSeg | `synthseg` 8.2.0 | This provides upstream `mri_synthseg`; show the Rust release as a separate implementation. |
| SYNcro | `syncro` 0.1.1, then update this recipe | Existing upstream pipeline predates the current Greedy/MindGrab choices. Recipe 0.2.0 is not yet an accepted release in the checked catalog. |
| dwi2trx | New `dwi2trx` | Require validated GPU/subgroup access for tracking. |
| EdgeReg | New `edgereg`, using verified niimath runtime | Package registration and preprocessing together. |
| Greedy | `itksnap` 4.4.0 for upstream Greedy; new `greedy` for Rust | Name the two implementations explicitly. |
| ANTs | `ants` 2.6.5 | Browser kernel is 2.6.2. Validate the documented schedule and output agreement across versions. |
| Brain2Print | New `brain2print` | Include segmentation, meshing and export. |
| TopoFit | `topofit` 0.5.1 | Verify BrainNet/model and surface conventions against the browser export. |
| FireANTs | New `fireants` | Package the same C/WASM engine as the app. |

For apps without a matching existing container, create a Neurocontainers recipe around the validated Linux executable and its complete model set. Use the app ID as the proposed recipe name. Do not label these proposed images as available before publication. Existing container release records also need an airgap audit: startup-time weight or dependency fetching must be removed, with required assets included in the released image. Publish prebuilt SIF images for offline HPC transfer. Desktop/GPU images need Neurodesk's graphical session and validated GPU access; a terminal-only image cannot replace that.

## Shared interface changes

1. Remove the ecosystem navigation item once in [site/app-shell.js](../../site/app-shell.js). Update [the shell assertion](../../test/app-information.test.mjs) and the bar statement in [the design system](design-system.md). Retain About's ecosystem content.
2. Render one shared Standalone dialog from the new catalog using `createInfoDialog` and `renderCommand`. Register it through the shell control contract for all 24 apps, including apps without legacy hidden controls. Existing app handlers should defer to the same shared renderer.
3. Show the complete desktop suite and individual app downloads with explicit platform/version and checksum links. Include the app's HPC command package and Neurodesk instructions, distinguishing the same pipeline from upstream alternatives. State that models are included. Keep developer build instructions out of this user flow.
4. Keep unsupported or unpublished target status truthful during rollout. A placeholder does not count as completion. All 24 rows must reach released status before closing the work.
5. Update [the interface audit](interface-audit.md) as apps gain their verified Standalone action. Use the shared spacing and dialog vocabulary throughout.

## Implementation order

1. Inventory all runtime/model assets, add local-only resource resolution, and define the full offline release manifest. Add the shared Standalone renderer and lightNIIng bar removal.
2. Prove the shared Electron host with VesselBoost, SynthSeg, QSMbly, dicompare and ZARRo. These cover model inference, GPU execution, WASM, Python and local directory access. Then include the remaining apps and generate per-app subsets from the same build.
3. Complete SynthSeg's native platform matrix and VesselBoost's HPC pipeline. Repair SynthSR/SYNcro release selection, include SYNcro's models in the archive, add its macOS package and resolve its workflow gaps. Finish Greedy's download presentation.
4. Complete the remaining per-app native/CLI work in the table. Reuse shared asset resolution and execution adapters. Enable EdgeReg release CI. Validate browser-dependent batch paths without a display before claiming HPC batch support.
5. Publish complete desktop distributions and model-inclusive CLI archives and SIF images. Follow the shared architecture's multipart offline distribution design if a complete artifact exceeds GitHub's per-file limit.
6. Publish or update Neurocontainers recipes with all assets included, pin resulting image digests, verify the downloaded release kits, and run the catalog-wide interface review.

## Completion gates

- Extend the generator, registry validation, CI planner and public deployment selection so every future app inherits desktop packaging, bundled assets and its HPC execution profile. Enforce the [future-app admission and release rules](webapps-desktop-architecture.md#future-apps-inherit-standalone-support) with a required aggregate CI check. A new app cannot be published as web-only.
- Every catalog ID has a standalone record, works in the shared desktop suite and has a generated individual desktop package for its promised platforms. Batch-capable workflows also have verified HPC commands. Every Standalone action links to actual releases. No row is complete with a source-build recipe or web ZIP alone.
- GitHub releases carry per-platform archives/installers, SHA-256 files, source commit, engine/model versions, license notices and validation evidence. Retrieve the published assets and verify checksums after upload. Do not stop at successful CI artifact generation.
- Test installation and first execution with networking disabled, empty caches and no developer environment. All required models and runtime dependencies are included. Run scientific fixtures, verify errors and outputs, and exercise paths containing spaces. GUI apps pass real import/edit/export workflows. Headless HPC commands pass without a display. Unexpected network attempts fail the offline check.
- Preserve existing numerical gates. Container alternatives need their own documented method/version comparison. Never infer scientific equivalence from a matching tool name.
- For code releases, use `pnpm changeset` and `pnpm release` to produce date versions, changelogs and embedded strings. Coordinate native and web publication around those versions.
- Build the fresh production site with `pnpm build`, then run `pnpm audit:interfaces`, `pnpm test:mobile` and `pnpm test:interface-workflows`. Store screenshots and scratch artifacts under the storage-backed `TMPDIR`, review desktop and phone screenshots in both themes, and exercise downloads and container commands. No UI tests are claimed for this planning-only change.

## Adding an application after this rollout

1. Run `pnpm new-app <id>`. The generator adds entries to the standalone catalog, asset sources and asset lock alongside the app registry.
2. Add a real workflow to `scripts/desktop/workflows.mjs` and its ID to `workflowApps`. CI rejects incomplete coverage. Include every optional model and dependency in the asset sources, then refresh and review the checksummed lock. Large files remain outside Git.
3. Exercise the workflow with `NEURODESK_TEST_APP=<id> NEURODESK_WORKFLOWS=1 node scripts/desktop/smoke.mjs`. Missing network requests and missing local assets fail the test. Add CPU-compatible workflows to the GitHub matrix; retain hardware-GPU validation for GPU methods.
4. Add a changeset, run the repository release command, and increment the desktop suite version before publishing another immutable suite. Dispatch `standalone` with `publish=true`. Publication requires all three installed desktop packages and the HPC image to pass their gates.
5. Import the release's `standalone-catalog.json` into `registry/standalone.json`. It contains the exact app versions, archive URLs and checksums produced by CI. Review the Standalone dialog before merging.
6. Deployment and web-release workflows run `scripts/desktop/check-published.mjs`. They reject any app version absent from the published offline suite or any missing platform binary. Adding a webapp cannot silently bypass standalone distribution.

The catalog uses one complete suite for all apps. `assemble.mjs --app <id>` also supports an isolated app bundle using the same runtime and dependency closure. Separate per-app installers are optional; the complete suite is the required release for every app.
