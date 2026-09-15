# One offline Neurodesk Webapps desktop application

## Desktop architecture

Build one Electron application containing all 24 webapps, all models needed by their supported methods, and all execution dependencies. Make this the main desktop download. Generate optional individual-app Electron distributions from the same packaging configuration. Continue to deliver command-line executables and Apptainer images for HPC batch work.

This incorporates the user's clarified requirement: models are included in the distributed package. Installation and first execution must work on an airgapped machine with an empty cache. There is no model downloader, first-run provisioning step, or remote fallback in these offline distributions. The host and packaging are implemented in `packages/desktop` and `scripts/desktop`. All 24 representative workflows passed locally; platform release results are gated by GitHub Actions. See [validation](standalone-validation.md) and the [user guide](../../packages/desktop/STANDALONE.md).

## Three ways to use the same applications

| Distribution | Intended use | Included contents |
| --- | --- | --- |
| Neurodesk Webapps desktop suite | Local workstation, airgapped workstation, or graphical HPC session | One Electron runtime, all 24 app interfaces, bundled execution engines, all required models/templates/atlases and runtime assets |
| Individual desktop app | A user needs only VesselBoost, SynthSeg or another selected app | The same desktop shell restricted to one app, plus that app's complete dependency and model set |
| HPC command-line package or Apptainer image | Scheduler jobs without a graphical session | Batch commands, required native or private runtimes, and the complete corresponding model/asset set |

All 24 interfaces are candidates for the shared Electron host because they already run as browser applications. This is architectural feasibility, not a claim that every existing worker, WebGPU feature and file API already works in an Electron build. Keep the three-platform desktop target of macOS ARM64, Linux x64 and Windows x64, and verify each app on each target.

The full suite is the primary deliverable. Per-app desktop installers are generated subsets, so they do not require 24 independent Electron implementations. Existing native commands remain useful both in the suite and as separate HPC releases.

## Shared desktop host

Use the canonical app registry and [site assembly](../../scripts/build-site.mjs) to select the production bundles. Keep the shared application bar, About/Cite content and existing app interfaces. Replace the hosted catalog destination with a local app picker. Remove the lightNIIng topbar link as already requested.

Create one desktop package that owns window lifecycle, app selection, local file access, job execution and asset resolution. Each app gets an isolated renderer context/session. Opening an app loads its code and models when needed; merely installing the full suite does not load every model into RAM. Closing a workspace releases its GPU resources and workers. Confirm unsaved work before destroying an active workspace.

Use a local standard, secure protocol such as `neurodesk://vesselboost/` for bundled resources, with stable per-app origins. Enable fetch and required worker capabilities, and test cross-origin isolation, SharedArrayBuffer and threaded WASM explicitly. Electron's [protocol API](https://www.electronjs.org/docs/latest/api/protocol) supports custom schemes and explains how standard schemes resolve resources and enable browser storage. Keep a loopback-only local server as an implementation fallback if a required worker/runtime cannot operate under the custom scheme; it must not expose an external service or require internet access.

Renderers use context isolation and sandboxing. A small preload interface provides only the file and execution operations that the app needs. Native computation runs in child processes, leaving the interface responsive. Follow Electron's [security guidance](https://www.electronjs.org/docs/latest/tutorial/security) for local content, isolated renderers and validated inter-process messages.

The [existing dicompare Electron code](../../apps/dicompare/electron/main.ts) provides useful packaging experience, but is not a finished shared host. It currently disables the renderer sandbox, opens developer tools in production, and uses file URLs. Its [build configuration](../../apps/dicompare/electron.vite.config.ts) warns rather than fails when offline Pyodide assets are missing. The suite must correct those behaviors.

## Models are part of the product

Build an asset inventory from every app's model manifest and actual runtime loads. It must include all selectable models, model shards and external ONNX tensor files, templates, atlases, lookup tables, registration data, Python wheels, WASM helpers, shader files, fonts and other resources required by a supported workflow. Bundle resources needed by built-in demonstrations or remove their remote-only entry points from the offline edition. User datasets are supplied locally; an airgap cannot provide ZARRo's remote archives.

During release construction, CI fetches pinned assets from the approved source storage, validates checksums and assembles the offline package. Large source assets stay out of Git. The resulting GitHub release artifacts contain the actual assets, not just their manifests or download URLs.

Store large assets as ordinary read-only resource files outside `app.asar`, alongside required native executables and libraries. Electron documents the [limitations of ASAR and unpacked resources](https://www.electronjs.org/docs/latest/tutorial/asar-archives). The installer places these files automatically. Neither the user nor a batch job has to locate a model directory or fetch missing weights.

Deduplicate identical files by cryptographic hash across apps. A shared filename or model family is insufficient: different precision, export format or model revision remains a different asset. Include both browser and native model representations where the chosen execution paths need them. A read-only shared store supplies models; writable job output and temporary files go elsewhere. On HPC, keep temporary work in the configured scratch directory rather than copying large models into each user's home.

Route desktop and HPC model access through a shared local resolver. Missing or corrupted resources report an incomplete installation with the exact asset name. They never start a download. Offline builds omit analytics, update polling, remote imports and automatic example fetching. External dataset access, if retained for connected ZARRo use, is an explicit optional operation and is not needed for local operation.

The final download and installed sizes need a complete asset inventory. Do not estimate them by adding only manifest fields that happen to contain a size. Some weights are shared; others have additional tensor files or runtime-specific exports. [The bundle audit](offline-bundle-audit.md) records current evidence and gaps.

## GitHub distribution and installation

Publish the suite under its own date-versioned tag, for example `webapps-desktop-vMAJOR.MINOR.YYYYMMDD`. Embed a manifest listing each app version, source commit, execution engine, included model hashes and platform requirements. Keep existing app-specific release tags for native and individual desktop distributions.

Prefer a single complete installer/archive per platform when it fits the hosting limit. GitHub requires [each release asset to be under 2 GiB](https://docs.github.com/en/repositories/releasing-projects-on-github/about-releases). If the complete suite exceeds that, publish a multipart offline installation set in the same GitHub release, with checksums and a supplied local installer/assembly tool. The installer reads all parts from the transferred directory, verifies them, and installs the complete suite without network access. Missing parts stop installation. They do not trigger a downloader. The application must still be one installed product even if its transport uses several files.

Ship Linux HPC archives and prebuilt Apptainer SIF images with models already present. Large SIF images can use the same multipart transport and offline assembly. Import or transfer the completed image before running on the disconnected cluster; `apptainer pull` is not part of the job. Containers with bootstrap scripts that fetch weights at startup fail this requirement.

Carry model and dependency redistribution notices in the distribution. Check those terms for each included asset during packaging. If an asset cannot be redistributed, resolve that specific release blocker rather than silently replacing inclusion with a first-run download.

## HPC execution

Use native Rust/C++ commands where they already exist. For shared JavaScript pipelines, use the packaged private Node runtime and local models. Python-based commands include their interpreter and dependencies. Add a common command dispatcher as a convenience while retaining useful per-app commands. For example, the following is a proposed interface, not an existing command:

```sh
webapps run synthseg --input scan.nii.gz --output segmentation.nii.gz
```

HPC execution must provide exit codes, file outputs, logs, cancellation and explicit resource controls. It must work from an extracted package or prebuilt SIF without npm, pip, compilation, internet access or prepopulated caches. Use CPU engines where they implement the required method, and prove numerical agreement with the browser pipeline.

Electron on Linux requires graphics infrastructure even when its window is hidden, as its [headless testing documentation](https://www.electronjs.org/docs/latest/tutorial/testing-on-headless-ci) explains. Therefore an Electron wrapper with a hidden window does not count as a general headless HPC backend. For browser-dependent batch pipelines such as dwi2trx, implement and validate a display-free GPU adapter, or explicitly provide a graphical HPC execution profile while the batch adapter remains open work. Software-rendered tests cannot validate GPU tractography. Apptainer GPU execution also depends on compatible host drivers and device bindings, described in [its GPU documentation](https://apptainer.org/docs/user/latest/gpu.html).

SurfAnnotate's manual drawing and ZARRo's interactive exploration use a graphical HPC session, such as the cluster's remote desktop. Their interactive workflows are not scheduled batch operations. All computational workflows promised as batch-capable must have a separately tested headless command. Desktop completion must not be reported as completion of that batch work.

## Future apps inherit standalone support

Standalone support is part of app admission and release, rather than a separate task after a webapp is published. The following controls are planned implementation work, not checks already enforced by this repository.

### Generate the complete integration

Extend [the app generator](../../scripts/new-app.mjs) and [canonical template](../../templates/app-template) so `pnpm new-app <id>` creates the standalone descriptor, local asset resolver integration, shared desktop registration and an offline workflow test entry point. Computational apps also receive the file-based execution adapter interface and batch test entry point. An interactive app declares a graphical HPC profile instead of a fictitious batch command.

The descriptor declares supported methods, required asset IDs, execution backend, platform/hardware requirements, fixtures and expected outputs, plus the container assignment. Model-free apps explicitly declare an empty model set; they still inventory other runtime assets. Scaffolded TODOs allow local development but cannot pass release readiness. Shared packaging owns Electron configuration, installers, model inclusion and CI; new apps do not copy their own release workflow.

### Derive coverage from one catalog

Use [the canonical registry loader](../../scripts/lib/apps-registry.mjs) for desktop assembly, standalone descriptor validation, CI matrices and container build planning. Cross-check that every public app has exactly one valid standalone descriptor and appears in the suite. Individual desktop packages derive from that same descriptor. There is no separate hand-maintained Electron app list and no `desktop: false` escape for a public app.

Required fields must include a real execution profile and fixture contract. A generic page-load test or `--help` test cannot satisfy the scientific workflow gate. Adding a new model or optional method updates the asset closure and its offline test coverage, not just the UI options.

### Keep incomplete apps out of public deployment

Currently the generator creates experimental entries with `ci.release: false`, while [site assembly](../../scripts/build-site.mjs) copies every registered app. That combination permits a webapp to be deployed without any native release. Introduce a validated release-ready selection used consistently by production site assembly, the public catalog and suite assembly. Local builds and explicit development previews can include incomplete scaffolds.

Promotion to public availability requires verified desktop artifacts on all promised platforms, a complete bundled asset set, and the appropriate tested HPC profile. For an interactive app, that means its graphical package/image; for a batch app, it means its headless command. Container claims additionally require a published, model-complete image and tested command. Neither `experimental` status nor disabling a CI flag may bypass this public deployment gate.

During migration, track the existing 24 gaps explicitly. Do not allow future app IDs into a legacy exemption list. Remove the migration exception mechanism when the current catalog is complete.

### Make CI enforce the contract

Extend [the CI planner](../../scripts/lib/app-plan.mjs) to schedule standalone checks for new apps and for changed engines, asset locks, model manifests, platform requirements and packaging code. It currently treats registry and lockfile paths as non-code; changes to standalone coverage or resolved dependencies must trigger validation even when no `apps/<id>/` file changed. Shared desktop host changes require the full app compatibility matrix.

Use one stable aggregate check, proposed name `standalone-ready`, as a required repository ruleset check. It verifies that every required platform and execution job actually ran and passed; missing or skipped jobs cannot produce success. Configuration of that repository rule is a separate implementation step, not a consequence of naming a workflow job.

The required checks cover descriptor/catalog equality, complete asset hashes, installed suite and individual package execution, first-use offline tests with empty caches, scientific output assertions and the declared HPC profile. GPU workflows require tests on the relevant hardware; a skipped GPU job leaves release readiness incomplete. Extend [generator tests](../../test/new-app.test.mjs) to prove a newly scaffolded app enters both desktop assembly and the test matrix, and that an unfinished fixture or missing asset blocks public promotion.

### Publish only complete release sets

Replace the independent web-only publication path in [release.yml](../../.github/workflows/release.yml) with preparation of a candidate release set. Build the webapp, individual desktop artifacts, suite and applicable CLI/container artifacts before promotion. Verify the expected artifact list, checksums, embedded app/model versions and test evidence. Test the actual packaged files, not just their build directories.

Upload to draft releases, verify the uploaded artifacts, then publish the complete set and deploy its verified catalog. GitHub publication and site deployment are not one transaction; retry failed publication steps while keeping the prior site/catalog selected until the full set is available. A failed Windows build must not quietly produce a public web-only app. A new app enters the public site and a complete suite release together.

Keep versioned artifacts immutable and run periodic link and clean-install checks to detect later deletion, broken downloads or asset drift. The app author is responsible for the scientific pipeline, asset declarations and meaningful fixtures; the shared packaging system supplies distribution automatically once those checks pass.

## Build sequence

1. Finish the asset inventory and introduce local-only resource resolution. Extend the generator and registry contract so future apps enter the same packaging and validation path automatically. Remove setup-time model downloading from the proposed distribution contract.
2. Build the shared Electron host and prove a representative slice: VesselBoost for model inference and preprocessing, SynthSeg for WebGPU plus native execution, QSMbly for threaded/WASM behavior, dicompare for Pyodide, and ZARRo for local directory access. This proves the host's main dependencies before multiplying platform releases.
3. Add every remaining app to the suite, bundle all supported models, measure installed/download sizes and validate every exposed workflow offline. Generate individual app packages through the same app-selection manifest.
4. Complete the per-app CLI plan, starting with SynthSeg, VesselBoost, SynthSR and SYNcro. Extract shared execution modules so desktop and HPC use the same algorithms and model versions. Track GPU-only headless adapters as explicit work.
5. Produce the signed desktop suite, individual binary packages and model-complete HPC images. Verify published artifacts, then connect every Standalone dialog to the corresponding verified release and container choice.

## Proof of airgap support

Install the released artifact on a clean target machine with networking disabled before installation. Start with empty caches and no user-installed Python, Node, models or developer toolchains. Run the scientific fixtures and GUI workflows, including every selectable model and optional stage. Record attempted network requests as test failures, rather than relying only on blocked requests eventually falling back to local files.

For each desktop target, verify GPU requirements, threaded WASM, import, computation and export. For each headless target, run without a display and through the intended scheduler/container environment. Record included asset hashes and numerical validation alongside the release. This is stricter than running offline after a successful connected first run.
