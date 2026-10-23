# Offline executable rollout

The [catalog-wide standalone release plan](standalone-rollout-plan.md) and [shared Electron architecture](webapps-desktop-architecture.md) supersede this document's coverage, packaging and delivery order. Every app is included in the desktop suite, including SurfAnnotate and ZARRo. Models ship inside desktop, command-line and container distributions. The remaining catalog notes below are historical background; the Greedy implementation notes remain useful.

The catalog has 24 apps. Twenty-two have useful batch workflows. SurfAnnotate and ZARRo remain interactive applications unless a separate batch operation is requested.

This plan records source and release configuration, not verified public availability. Greedy is the implementation in this change. The remaining rows are planned work.

## Distribution contract

Each completed CLI has an Apple ARM installer signed with Developer ID and notarized, a Linux x64 archive, a Windows x64 archive, and an npm-installable command. Each release uses its app's `MAJOR.MINOR.YYYYMMDD` version. Package licenses, attribution and runtime dependencies travel with the executable.

Offline means installation and first execution need no network or existing model cache. Model sources and validation datasets stay on the pinned Hugging Face dataset, outside Git; release artifacts include the required model files and runtime assets. A missing asset reports an incomplete installation. There is no runtime model download step.

Every target must run a scientific fixture from an extracted archive and an installed npm package. A help/version check alone does not validate a pipeline. Existing numerical parity gates remain in place. Release evidence must distinguish generated fixture checks from reference-dataset parity and from network-disabled execution.

The Apple installer carries a stapled notarization ticket so installation can be assessed offline. This follows [Apple's notarization workflow](https://developer.apple.com/documentation/security/customizing-the-notarization-workflow). The Greedy workflow uses `macos-15`, an [Apple ARM GitHub runner](https://docs.github.com/en/actions/reference/runners/github-hosted-runners).

## Delivery order

1. Finish Greedy's existing Rust CLI distribution and run the release workflow on all three target runners.
2. Package Easy MP2RAGE's existing Rust CLI. Add Linux and Windows distributions for SynthSeg, then its npm CLI. Publish SYNcro's signed macOS installer. Verify SynthSR's current release assets against the contract.
3. Adapt engines already usable outside a browser: ANTs, EdgeReg, NiiMath, dicompare and FireANTs. Check upstream packaging and licenses before choosing an adapter or a native bundle.
4. Extract the inference and quantitative pipelines listed below. Prove filesystem input/output and offline model resolution before packaging. Preserve the browser algorithm and numerical tests.
5. Address GPU and video workflows after proving their runtime on each target. Avoid announcing platform support based on compilation alone.

## Catalog coverage

Paths in this table are relative to the repository root. Existing implementation does not imply that a release artifact has been published or validated.

| App | Useful batch operation | Existing code and next work |
| --- | --- | --- |
| `greedy` | Affine/deformable registration and reslicing | `exes/greedy` has the Rust CLI. This change adds native release CI and the bundled npm command. macOS signing and target-runner verification remain release gates. |
| `me-ica` | Multi-echo fMRI denoising (tedana's workflow) | The engine and its `meica` CLI live in [niivue/meica-rs](https://github.com/niivue/meica-rs), which builds native release archives; list them as the Standalone download once the first release is tagged. |
| `easy-mp2rage` | T1 mapping, B1 correction, UNI denoising | `apps/easy-mp2rage/crates/mp2rage-cli` and `mp2rage_t1/cli.py` already provide CLIs. Package the Rust binary and synchronize its version. |
| `fastprep` | fMRIPrep-style preprocessing of a BIDS subject | `exes/fastprep` (Rust CLI, needs niimath, brainchop, greedy-rs, synthsr, topofit and glm on `PATH` or in `bin/`) and `exes/glm`. Add native release packaging that bundles or pins those tools and the MNI template. |
| `synthsr` | Super-resolution image synthesis | `exes/synthsr`, `packages/synthsr` and `.github/workflows/synthsr-native.yml` provide native target packaging, Apple notarization and a Node CLI. Audit published assets and offline model provisioning. |
| `synthseg` | Brain segmentation | `exes/synthseg` has a CLI and macOS release workflow. Add Linux/Windows builds, dependency packaging and npm CLI delivery. The current JS package is private and browser-oriented. |
| `syncro` | MNI normalization and aligned lesion transformation | `exes/node-cli` launches a private Node runtime. Linux x64 and Windows x64 portable packages, a macOS arm64 installer and an npm CLI exist; each portable package bundles its models. The Node workflow is narrower than the browser workflow. |
| `ants` | Affine and SyN registration | `packages/registration` already runs its kernel under Node for SYNcro. Add an app-level command and distribute the runtime. Preserve the WASM memory limit in the command contract. |
| `edgereg` | Affine registration | `apps/edgereg/src/main.js` owns orchestration around niimath. Extract file-based execution and reuse the existing engine. |
| `niimath` | Image maths | `apps/niimath/package.json` uses `@niivue/niimath`. Assess upstream native distribution and reuse it rather than porting the algorithm. |
| `dicompare` | Protocol comparison and validation | `apps/dicompare/src/workers/pyodide.worker.ts` uses the upstream Python engine. Package that engine for batch work; schema editing remains interactive. |
| `fireants` | Registration | `apps/fireants` uses `@fireants/fireants`. Prove its CPU/headless API and dependency bundle on all targets. |
| `elastix` | Rigid, affine and B-spline registration | `@itk-wasm/elastix` ships Node pipelines (`elastixNode`, `defaultParameterMapNode`), and elastix itself has native releases and the `itk-elastix` Python package. Wrap the app's presets, float32 casting and chained parameter-file output in a command before packaging. |
| `musclemap` | Muscle segmentation and fat metrics | `apps/musclemap/web/js/inference-worker.js`. Extract orchestration and supply native inference and a model cache. |
| `vesselboost` | Vessel segmentation | `apps/vesselboost/web/js/inference-worker.js` and Rust preprocessing. Add a headless inference adapter and model provisioning. |
| `spinalcordtoolbox` | Segmentation, labeling and lesion analysis | Use the existing pinned native SCT container and `sct_deepseg`; a separate portable Node CLI is not planned (#175). The [command-line guide](../../apps/spinalcordtoolbox/README.md#command-line) covers Docker, Windows through Docker and Apptainer, persistent offline model preparation, and the native five-fold versus browser single-fold `lesion_ms` distinction. The shared Standalone action also offers OpenRecon. |
| `calmar` | Lesion mapping and reporting | `packages/calmar`: shared prepare/map orchestration, explicit candidate review, CPU models and both offline connectivity packs. |
| `qsmbly` | QSM reconstruction | `apps/qsmbly/js/qsm-worker-pure.js` and `rust-wasm`. Add native input/output and an execution adapter for the full reconstruction sequence. |
| `seedseg` | Fiducial marker segmentation | `apps/seedseg/web/js/inference-worker.js`. Add headless inference, local model resolution and packaging. |
| `deface` | Batch MRI defacing | `apps/deface/src/main.ts` and `src/mindgrab`. Separate reusable execution from UI and provide headless inference. |
| `browserqc` | Segmentation and QC reports | `apps/browserqc/src/qc.ts` separates metrics, but `src/main.ts` owns inference. Add headless execution and report export. |
| `topofit` | Cortical surface reconstruction | `packages/topofit/bin/topofit.js` runs reconstruction on the CPU with `onnxruntime-node`; `exes/node-cli` packages it with its models for Linux x64, Windows x64 and macOS arm64. Surface analysis and DICOM input remain web-only. |
| `dwi2trx` | Tensor fitting and tractography | `apps/dwi2trx/src/dwi2trx` needs WebGPU and subgroup support for tracking. Prove a headless GPU runtime and retain the vendored dtifit-enabled niimath. |
| `noddi` | Diffusion tensor and NODDI (AMICO) fitting | `packages/noddi` holds the WebAssembly fit built from `exes/dwi`; the app needs no WebGPU. A Node command line over the same module is the next step of [the diffusion design](dwi-microstructure-design.md). |
| `degibbs` | Gibbs-ringing removal (MRtrix mrdegibbs port) | `packages/degibbs` holds the WebAssembly port built from `exes/dwi/degibbs`; a Node command line over the same module follows, as for noddi. |
| `sdc` | Reverse phase-encoding distortion correction (PyHySCO port) | `packages/sdc` holds the WebAssembly build of `exes/sdc`, which also builds the native `sdc` command line; its release packaging follows. |
| `n4` | N4 bias-field correction (ANTs) with the MRtrix dwibiascorrect procedure | `packages/n4` holds ANTs N4BiasFieldCorrection in WebAssembly, separate from `packages/registration`; a Node command line over the same module follows, as for noddi. |
| `dwicorrect` | Motion, eddy-current and susceptibility correction (FSL eddy/topup method) | `exes/dwi/shoreline` builds the native `shoreline` command line on the core that `packages/shoreline` runs in WebAssembly; its release packaging follows. MindGrab masking and the PyHySCO field estimate stay in the app. |
| `dwidenoise` | Patch2Self denoising (DIPY 1.12.1 version 1 port) | `packages/dwidenoise` holds the WebAssembly port built from `exes/dwi/denoise`; a Node command line over the same module follows, as for noddi. |
| `brain2print` | Segmentation to printable mesh | `apps/brain2print/src/mesh.js` has pure mesh validation. Extract the `src/main.js` pipeline with headless MindGrab and niimath meshing. |
| `brain-extraction` | BET, MindGrab and SynthStrip brain extraction | Packaged in suite 0.4.20260915 with pinned models, the shared extraction adapters and an offline BET extraction/export check. |
| `disconnectome` | Lesion-to-bundle disconnection scores | `packages/nii2tvx/bin/disconnectome.js` runs the app's WASM query core in Node and writes the app's TSV, byte-identical to native `exes/nii2tvx`; `exes/node-cli` packages it with both pinned TVX atlases for Linux x64, Windows x64 and macOS arm64. DICOM input and the tract display remain web-only. |
| `carotid-flow` | Carotid detection and flow curves from a phase-contrast slice | `packages/carotid-flow/bin/carotid-flow.js` writes the app's three downloads byte for byte from NIfTI input; `exes/node-cli` packages it for Linux x64, Windows x64 and macOS arm64. DICOM input and label editing remain web-only. |
| `lcmodel` | FID-A preprocessing and LCModel metabolite fitting of single-voxel MRS | `packages/lcmodel/bin/lcmodel.js` runs the app's fit and fit-group operations through the shared `pipeline.js` and the app's WebAssembly module, and writes the app's downloads byte for byte; `exes/node-cli` packages it with all 25 pinned basis sets for Linux x64, Windows x64 and macOS arm64. Tissue correction from a T1 (MindMap) remains web-only (#203); entered fractions work. |
| `white-matter-lesions` | FLAIR lesion masks, probability maps and lesion tables | `packages/white-matter-lesions/bin/flames.js` runs the app's pipeline and output writer on the CPU with `onnxruntime-node`; `exes/node-cli` packages it with SynthStrip and all five FLAMeS folds for Linux x64, Windows x64 and macOS arm64. DICOM input and mask editing remain web-only. |
| `nesvor` | Slice-to-volume MRI reconstruction | `exes/compute-server` runs the pinned CUDA container on Linux with NVIDIA. Its archive includes the browser frontend; Docker, model preparation and real CUDA validation remain separate. |
| `mri2vid` | Volume-to-video conversion | `packages/mri2vid/bin/mri2vid.js` runs the app's readers, series selection and frame pipeline from `packages/mri2vid`, draws frames into buffers and encodes VP9 with libvpx (libav.js WebAssembly) into the app's muxers; `exes/node-cli` packages it for Linux x64, Windows x64 and macOS arm64. Its release check holds frame count, size, timing and key frames to the recorded Chromium videos. WebM frame PSNR compares with both recorded browser frames and rendered source; MP4 frame PSNR compares with rendered source. Windowing, rotation and stretching remain web-only; MP4 is VP9, not H.264. |
| `surfannotate` | No default batch equivalent | Manual surface ROI drawing and vertex selection. Excluded from this rollout. |
| `zarro` | No default batch equivalent | Interactive OME-Zarr exploration. Conversion or extraction would be a separately scoped command. |
| `dicomview` | No default batch equivalent | Interactive DICOM browsing. Its batch steps already ship as command lines: dcm2niix for conversion and dicompare for protocol summaries and checks. |
| `dcm2niix` | No default batch equivalent | Interactive BIDS curation: scan types, fieldmap targets and metadata are user decisions. Upstream dcm2niix already ships the converter command line. |

## Greedy release gates

`.github/workflows/greedy-native.yml` builds native archives, creates an npm tarball containing all three native binaries, and installs that tarball offline on each target. It retains the existing browser wrapper but does not npm-publish the generated threaded WASM directory.

The release job runs only on manual dispatch with `sign_release=true`. It requires an existing draft or prerelease whose tag resolves to the workflow commit. Native tests must pass before signing. The signing job reuses the SynthSR Apple credential setup, signs and notarizes an installer, and validates its extracted executable. npm assembly then uses that exact signed executable; all three runners test the resulting tarball before the publisher attaches artifacts to the release. This workflow does not publish to the npm registry; its `.tgz` is npm-installable.

The standalone `.pkg` is the signed and notarized Apple distribution. On release dispatches, the npm tarball contains the exact Developer ID-signed executable extracted from the notarized installer. The stapled ticket travels with the separate `.pkg`; raw executables cannot carry a stapled installer ticket. Test runs use the ordinary CI-built executable. The tarball has no runtime dependencies or install-time download script. Windows binaries statically link the C runtime.

`scripts/greedy-third-party-notices.py --check` validates the committed license notices against the locked native dependency tree. Both native and npm packages include those notices.

The first hosted run must verify Windows execution, macOS package construction, signature identities, notarization, Gatekeeper assessment, and the final uploaded assets. Local Linux verification cannot establish those facts. A reference-dataset parity test still requires `GREEDY_BENCH_DIR`; generated fixture checks do not replace it.
