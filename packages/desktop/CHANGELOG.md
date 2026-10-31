# @neurodesk/desktop

## 0.47.20261031

### Patch Changes

- Updated dependencies [d8ac48c]
- Updated dependencies [b84a269]
  - @neurodesk/webapp-components@0.22.3

## 0.47.20261027

### Patch Changes

- 46d4ee1: Adopt NeuroFlow v0.2.1. Its `neuroflow-mcp` inspects FSL gradient tables, so generated tool inputs now declare `bval` and `bvec` formats again and the runtime rejects a swapped pair before launch. `bval-bvec`, which names a pair of files, has no inspector and stays only in `neurodesk/data`. The `neuroflow` CI job builds the v0.2.1 commit, and the docs point to the release's prebuilt binaries and their `SHA256SUMS`. Exported workflows need `neuroflow-mcp` 0.2.1 or later.
- Updated dependencies
  - @neurodesk/webapp-components@0.22.2

## 0.46.20261027

### Patch Changes

- Updated dependencies
  - @neurodesk/webapp-components@0.22.1

## 0.46.20261025

### Patch Changes

- Pace automated artifact exports to respect Chromium's ten-download burst limit, which could leave completed model and tractography runs waiting until their deadline. Report the current exported artifact and verify rapid multi-file completion in real Electron before the full scientific CI workflow.

## 0.45.20261025

### Patch Changes

- Keep the last run phase and message, desktop stderr, and process-exit diagnostics when an exported NeuroFlow operation fails or times out. Save this evidence outside temporary desktop scratch without publishing partial scientific results or changing the execution deadline.

## 0.44.20261025

### Patch Changes

- eaf21e9: Fail automation promptly when its browser renderer exits, retaining the exit reason. Preserve independent NeuroFlow comparison snapshots and desktop stderr/shutdown diagnostics, and report NODDI loading, fitting and output stages through automation without changing numerical outputs or timeouts.

  Add an explicitly diagnostic DWI models-only workflow replay with original preprocessing/model settings and exact independent model comparisons. Default full T1/DWI validation remains unchanged.

## 0.44.20261024

### Patch Changes

- d9c35b4: Recognize canonical Windows extended paths and WebDAV UNC server suffixes containing @ before URL credential checks. Keep credential-bearing URL refusals on every platform, and exercise a real extended-path file approval on Windows.

## 0.43.20261024

### Patch Changes

- Updated dependencies
  - @neurodesk/webapp-components@0.21.1

## 0.42.20261024

### Patch Changes

- Updated dependencies [328cb77]
  - @neurodesk/webapp-components@0.20.1

## 0.41.20261024

### Patch Changes

- Updated dependencies [bd5f3a8, 0066f60]
  - @neurodesk/webapp-components@0.22.0
- Updated dependencies [14a8b29]
- Updated dependencies [a028e96]
- Updated dependencies [650ce5f]
- Updated dependencies [343c256]
- Updated dependencies [941884c]
  - @neurodesk/webapp-components@0.20.0

## 0.40.20261024

### Patch Changes

- 37a1791: Ask for source approval before loading custom label tables and font atlas or metrics files through the NiiVue MCP tools.
- Updated dependencies [941884c]
- Updated dependencies [a028e96]
- Updated dependencies [650ce5f]
- Updated dependencies [343c256]
- Updated dependencies [941884c]
  - @neurodesk/webapp-components@0.21.0
- Updated dependencies
  - @neurodesk/webapp-components@0.19.3

## 0.39.20261024

### Minor Changes

- 3a7e5bb: The desktop MCP server also offers NiiVue's own agent tools (`@niivue/nv-mcp`): each retained NiiVue viewer is a tab, so `list_tabs`, `where_am_i`, `go_to_point`, `set_view`, `screenshot` and the rest act on it through its session. Viewers register a `niivue` capability and answer the new `viewers.niivue` command. Loading tools can also load a local file or another URL once a person approves it in a dialog, or when it is listed in `NEURODESK_APPROVED_SOURCES`, for that viewer only; `NEURODESK_SOURCE_APPROVAL=deny` refuses without asking. An address with a user name or password is refused before anyone is asked, however it is written. The new `sessions_grant` tool approves a file or any http(s) URL ahead of time, and each approval or refusal is recorded under `sources` in the run record.

### Patch Changes

- 37a1791: Ask for source approval before loading custom label tables and font atlas or metrics files through the NiiVue MCP tools.
- 4c15920: Each viewer window now has its own browser session and its own address on the local server. An app's service worker makes most of its requests, and the desktop could not tell which window they came from. Remote run inputs such as ZARRo's OME-Zarr URL failed to load over http, any window could read the https sources granted to another, and a request refused in a retained viewer failed the run in progress in another window. Requests are now checked against, and counted for, the window that made them. The desktop fetches a viewer's approved https sources and its compute server requests in that viewer's session, so a cookie a host sets stays with that viewer. A closed viewer's session is cleared before another viewer reuses it, and a session that fails to clear is not reused. Before it quits, the desktop waits for every clear to settle, even when one fails.
- Updated dependencies [3a7e5bb]
- Updated dependencies [72cbb8d]
  - @neurodesk/webapp-components@0.20.0
- Keep shared example and runtime assets in the edition without models when a model has identical bytes, so model-pack builds verify successfully and examples remain available offline.
- Pair acquisition JSON and gradient inputs by automation role so metadata survives diffusion pipelines. Split DWI Correct and SDC inputs into single-image roles, require explicit acquisition values for automated correction, and expose correction settings. Export a corrected mean-b0 image for downstream brain masks. Use a generic single-volume error for shared image readers.
- Generate artifact format qualifiers from MIME types and gradient roles, and preserve explicit artifact encodings. Keep gradient input formats in contract metadata until NeuroFlow gains inspectors. Type DWI brain masks as masks so pipeline bindings reject scalar images.
- Updated dependencies
  - @neurodesk/webapp-components@0.19.2

## 0.38.20261024

### Patch Changes

- Updated dependencies [3fc9cf2]
  - @neurodesk/webapp-components@0.19.1

## 0.38.20261022

### Minor Changes

- d32b485: Add NiiVue viewer tools to the desktop MCP server: `viewers_volumes` lists loaded volumes and their display settings, `viewers_display` sets slice type and per-volume colormap, display range, opacity and visibility, and `viewers_screenshot` returns the redrawn viewer as an MCP PNG image captured from the window.

### Patch Changes

- Updated dependencies [d32b485]
  - @neurodesk/webapp-components@0.19.0

## 0.37.20261020

### Patch Changes

- Updated dependencies
  - @neurodesk/webapp-components@0.17.2

## 0.36.20261020

### Patch Changes

- Updated dependencies [a36fde4]

  - @neurodesk/webapp-components@0.18.0

- Updated dependencies
  - @neurodesk/webapp-components@0.17.1

## 0.35.20261020

### Patch Changes

- Updated dependencies [14db080]

- Updated dependencies [03261d0]

- Updated dependencies [c865c0c]

  - @neurodesk/webapp-components@0.17.0

- Updated dependencies [c865c0c]

- Updated dependencies [4b40da1]

  - @neurodesk/webapp-components@0.17.0

- Updated dependencies [4b40da1]

  - @neurodesk/webapp-components@0.17.0

## 0.35.20261019

### Patch Changes

- Updated dependencies [af2e8db]

- Updated dependencies [b3404ec]
  - @neurodesk/webapp-components@0.16.3

## 0.34.20261020

### Patch Changes

- Updated dependencies [3f1d770]

- Updated dependencies [d9718cd]
  - @neurodesk/webapp-components@0.16.3

## 0.34.20261019

### Patch Changes

- 2d3e637: The macOS release retries Apple stapling when `xcrun stapler` fails on a transient transport error (`NSURLErrorDomain` connection lost, timed out, offline or cannot connect, or stapler code 68), up to four attempts with a 15 s, 30 s, 60 s backoff, each retry logged. `@electron/notarize` staples once and never retries, so one dropped connection to api.apple-cloudkit.com failed the nightly desktop release. The app is notarized once; a notarization failure, a certificate-trust error or an invalid signature still fails at once.

## 0.34.20261018

### Patch Changes

- Updated dependencies [7c0d201]
  - @neurodesk/webapp-components@0.16.2

## 0.33.20261018

### Patch Changes

- 803cb7e: Complete anatomy, modality, input and hardware metadata for NODDI, Degibbs, N4, DICOM to BIDS and Dwidenoise. Align six existing cards with their supported startup without WebGPU.

- f2cfdd3: Share the checksum-verified ONNX Runtime asyncify binary in composite sites while keeping pthread modules inside each app's service-worker scope. This keeps the expanded catalog within its existing hosting budget.

## 0.32.20261020

### Patch Changes

- Updated dependencies [c865c0c]

  - @neurodesk/webapp-components@0.17.1

- Updated dependencies

- Updated dependencies
  - @neurodesk/webapp-components@0.18.0

## 0.32.20261018

### Patch Changes

- Updated dependencies [46935f7]
  - @neurodesk/webapp-components@0.16.1

## 0.31.20261020

### Patch Changes

- Updated dependencies [a36fde4]
- Updated dependencies
- Updated dependencies

  - @neurodesk/webapp-components@0.17.0

- Updated dependencies [a36fde4]

- Updated dependencies

- Updated dependencies
  - @neurodesk/webapp-components@0.17.0

## 0.31.20261018

### Patch Changes

- Updated dependencies [ea2a6d2]

- Updated dependencies [0511cd7]

- Updated dependencies [3329c39]

  - @neurodesk/webapp-components@0.16.0

- Updated dependencies [b67e4e9]

  - @neurodesk/webapp-components@0.15.1

- Updated dependencies [b67e4e9]

  - @neurodesk/webapp-components@0.15.1

## 0.30.20261020

### Patch Changes

- 2d3e637: The macOS release retries Apple stapling when `xcrun stapler` fails on a transient transport error (`NSURLErrorDomain` connection lost, timed out, offline or cannot connect, or stapler code 68), up to four attempts with a 15 s, 30 s, 60 s backoff, each retry logged. `@electron/notarize` staples once and never retries, so one dropped connection to api.apple-cloudkit.com failed the nightly desktop release. The app is notarized once; a notarization failure, a certificate-trust error or an invalid signature still fails at once.
- Updated dependencies [ea2a6d2]
- Updated dependencies [3f1d770]
- Updated dependencies [d9718cd]
- Updated dependencies [c1a4dda]
- Updated dependencies [3329c39]
- Updated dependencies [46935f7]

  - @neurodesk/webapp-components@0.16.0

- 2d3e637: The macOS release retries Apple stapling when `xcrun stapler` fails on a transient transport error (`NSURLErrorDomain` connection lost, timed out, offline or cannot connect, or stapler code 68), up to four attempts with a 15 s, 30 s, 60 s backoff, each retry logged. `@electron/notarize` staples once and never retries, so one dropped connection to api.apple-cloudkit.com failed the nightly desktop release. The app is notarized once; a notarization failure, a certificate-trust error or an invalid signature still fails at once.

- Updated dependencies [ea2a6d2]

- Updated dependencies [3f1d770]

- Updated dependencies [d9718cd]

- Updated dependencies [c1a4dda]

- Updated dependencies [3329c39]

- Updated dependencies [46935f7]
  - @neurodesk/webapp-components@0.16.0

## 0.30.20261018

### Patch Changes

- Updated dependencies [b68209b]
  - @neurodesk/webapp-components@0.15.0

## 0.29.20261018

### Patch Changes

- Updated dependencies [2ae93ae]
- Updated dependencies [ccb2970]
- Updated dependencies [67a5a8f]

  - @neurodesk/webapp-components@0.14.4

- Updated dependencies [2ae93ae]

- Updated dependencies [ccb2970]

- Updated dependencies [67a5a8f]
  - @neurodesk/webapp-components@0.14.4

## 0.29.20261017

### Patch Changes

- b243e7b: Include the shared Inter font and its licence in offline suite and single-app bundles so the composite theme loads without a missing font request.
- Updated dependencies [b547d52]

  - @neurodesk/webapp-components@0.14.3

- b243e7b: Include the shared Inter font and its licence in offline suite and single-app bundles so the composite theme loads without a missing font request.

- Updated dependencies [b547d52]
  - @neurodesk/webapp-components@0.14.3

## 0.29.20261016

### Patch Changes

- Updated dependencies
  - @neurodesk/webapp-components@0.14.2

## 0.28.20261016

### Patch Changes

- Updated dependencies [7443048]
  - @neurodesk/webapp-components@0.14.1

## 0.28.20261015

### Patch Changes

- Updated dependencies [dd65e6a]
- Updated dependencies [dcc74e7]

  - @neurodesk/webapp-components@0.14.0

- Updated dependencies [dd65e6a]

- Updated dependencies [dcc74e7]
  - @neurodesk/webapp-components@0.14.0

## 0.28.20261014

### Patch Changes

- Updated dependencies [27c9549]
- Updated dependencies [850e642]
- Updated dependencies [ad92e2f]

  - @neurodesk/webapp-components@0.13.0

- Updated dependencies [27c9549]

- Updated dependencies [850e642]

- Updated dependencies [ad92e2f]
  - @neurodesk/webapp-components@0.13.0

## 0.28.20261012

### Patch Changes

- Updated dependencies
  - @neurodesk/webapp-components@0.12.3

## 0.28.20261010

### Patch Changes

- Updated dependencies
  - @neurodesk/webapp-components@0.12.2

## 0.27.20261010

### Patch Changes

- Keep the SynthSeg geometry adapter's normalized header byte order consistent with the shared endian-aware NIfTI reader.

- Updated dependencies
  - @neurodesk/webapp-components@0.12.1

## 0.27.20261009

### Patch Changes

- Wait for partial output cleanup before publishing a failed or cancelled automation run, so clients cannot observe a completed run while its outputs are still being removed.

## 0.26.20261009

### Patch Changes

- 501ea0c: Pin every offline source to an immutable URL so a host redeploy can no longer fail the nightly checksum check. CALMAR assets move to fixed Hugging Face and GitHub commits, QSMbly loads Inter from versioned font files, and the unused QSMbly OSF multi-echo files and NiiVue demo images (NiiMath, SynthSR) leave the bundle. `test/offline-asset-pins.test.mjs` rejects unpinned sources.
- 3adf140: Write the models pack without GNU tar. The archive is now produced in Node as a plain USTAR stream, so it builds on macOS and Windows as well as Linux and stays byte-identical for the same models. Its checksum differs from packs written by GNU tar, so the next release uploads the pack once more.
- Updated dependencies [66bf9e9]
- Updated dependencies [501ea0c]

  - @neurodesk/webapp-components@0.12.0

- 501ea0c: Pin every offline source to an immutable URL so a host redeploy can no longer fail the nightly checksum check. CALMAR assets move to fixed Hugging Face and GitHub commits, QSMbly loads Inter from versioned font files, and the unused QSMbly OSF multi-echo files and NiiVue demo images (NiiMath, SynthSR) leave the bundle. `test/offline-asset-pins.test.mjs` rejects unpinned sources.

- 3adf140: Write the models pack without GNU tar. The archive is now produced in Node as a plain USTAR stream, so it builds on macOS and Windows as well as Linux and stays byte-identical for the same models. Its checksum differs from packs written by GNU tar, so the next release uploads the pack once more.

- Updated dependencies [66bf9e9]

- Updated dependencies [501ea0c]
  - @neurodesk/webapp-components@0.12.0

## 0.26.20261007

### Patch Changes

- Updated dependencies [22aa4bf]
  - @neurodesk/webapp-components@0.11.1

## 0.25.20261007

### Patch Changes

- Updated dependencies
  - @neurodesk/webapp-components@0.11.0

## 0.24.20261007

### Patch Changes

- c040105: Build the bundle's dicompare worker from this repository instead of downloading it from dicompare.neurodesk.org, whose redeploys failed the nightly build, and fix SeedSeg's offline asset list, which still named NiiVue 0.44.0. Offline asset verification now fails when an app's locked asset list differs from its sources.
- Updated dependencies [70f2770]

  - @neurodesk/webapp-components@0.10.2

- c040105: Build the bundle's dicompare worker from this repository instead of downloading it from dicompare.neurodesk.org, whose redeploys failed the nightly build, and fix SeedSeg's offline asset list, which still named NiiVue 0.44.0. Offline asset verification now fails when an app's locked asset list differs from its sources.

- Updated dependencies [70f2770]
  - @neurodesk/webapp-components@0.10.2

## 0.24.20261004

### Patch Changes

- Updated dependencies
  - @neurodesk/webapp-components@0.10.1

## 0.23.20261004

### Patch Changes

- Updated dependencies [0204fe1]
- Updated dependencies [ec85a09]

  - @neurodesk/webapp-components@0.10.0

- Updated dependencies [0204fe1]

- Updated dependencies [ec85a09]
  - @neurodesk/webapp-components@0.10.0

## 0.22.20261004

### Patch Changes

- Verify SYNcro with its packaged pinned T1 and explicit WASM SynthSR, SynthStrip, and Greedy backends.

## 0.21.20261004

### Minor Changes

- Generate NeuroFlow 0.1.1 qualifiers and scalar single-file bindings against the merged upstream schema. Resolve verified app coordinate references, reject invalid qualifier inheritance, and validate NIfTI encoding before legacy and schema-version-2 runs.

### Patch Changes

- Updated dependencies
  - @neurodesk/webapp-components@0.9.0

## 0.20.20261003

### Patch Changes

- Share operation parameter schemas across browser and desktop automation. Both callers now use the same defaults, enum values, bounds, recursive arrays, decimal multiples and safe integer rules. Preserve MCP parameter metadata and bundle the validator for native ESM development, standalone releases and the composite catalog.
- Updated dependencies

  - @neurodesk/webapp-components@0.8.0

- Share operation parameter schemas across browser and desktop automation. Both callers now use the same defaults, enum values, bounds, recursive arrays, decimal multiples and safe integer rules. Preserve MCP parameter metadata and bundle the validator for native ESM development, standalone releases and the composite catalog.

- Updated dependencies
  - @neurodesk/webapp-components@0.8.0

## 0.19.20261003

### Patch Changes

- Share browser download tracking, validation ordering and completion-report publication across selector jobs and typed operations. Publish completion only after offline and retained-viewer checks pass, hide pending viewers, and preserve CLI artifact retention and MCP failure cleanup.

## 0.19.20260930

### Minor Changes

- Add a repository CLI that generates schema-validated NeuroFlow tool bundles from automation contracts, with a shared desktop MCP launcher, portable tool names, verified artifact delivery and cancellation. Document the mapping and draft a portable data-constraint RFC.

## 0.18.20260930

### Patch Changes

- Updated dependencies
- Updated dependencies

  - @neurodesk/webapp-components@0.7.0

- Updated dependencies

- Updated dependencies
  - @neurodesk/webapp-components@0.7.0

## 0.17.20260930

### Patch Changes

- Updated dependencies
  - @neurodesk/webapp-components@0.6.2

## 0.17.20260928

### Patch Changes

- Use portable underscore MCP tool names, explicit input cardinality, and declared SynthSeg browser geometry limits for preflight validation. Preserve duplicate DICOM filenames during conversion, release viewer sessions when their windows close, and prevent cancellation/retry races.

  Resolve QSM voxel-dependent defaults for supplied masks before reconstruction, so generated-mask and supplied-mask runs produce the same output. Add complete Mac scientific validation commands and evidence checks. The SynthSeg GPU buffer ceiling remains unchanged.

- Updated dependencies
  - @neurodesk/webapp-components@0.6.1

## 0.16.20260928

### Minor Changes

- Expose typed operations across the application catalog, including multiple inputs, DICOM series selection, variable artifacts and viewer workflows. Share awaited processing and cancellation between each app and its agent adapter. Publish verified result reports and scientific provenance.

  Add bounded desktop viewer sessions and MCP controls using public viewer APIs. Native SynthSeg now reports per-label counts and physical volumes. Include real-model CPU checks and a Mac runner for Metal, WebGPU and buffer-planning evidence without raising the validated SynthSeg limit.

### Patch Changes

- Updated dependencies
- Updated dependencies [93381e8]
- Updated dependencies [93381e8]

  - @neurodesk/webapp-components@0.6.0

- Updated dependencies

- Updated dependencies [93381e8]

- Updated dependencies [93381e8]
  - @neurodesk/webapp-components@0.6.0

## 0.15.20260928

### Minor Changes

- Publish versioned app automation contracts and checksummed run reports for brain extraction and SynthSeg. Add shared run identities, explicit completion and cancellation, and SynthSeg label-volume summaries. Generate browser jobs from the contracts and expose discovery, validation, asynchronous execution, cancellation and artifact resources through the desktop's local MCP server, with an optional native SynthSeg engine.

## 0.14.20260928

### Patch Changes

- 83f8fce: Batch jobs now fail as soon as an application reports an error in its status line (`#statusText.error`), with the application's message, instead of waiting for the job timeout. The check also runs while outputs are still downloading and once more before the success report is written, and the job timeout now bounds the download wait. A job can set `failSelector` to another selector, or to `null` to keep waiting.

## 0.14.20260918

### Patch Changes

- Include MuscleMap's clearer input image type, preview, and segmentation controls alongside the current app releases.

## 0.13.20260918

### Patch Changes

- Include the original TOF-MRA example for VesselBoost alongside the corrected Calmar example.

## 0.12.20260918

### Patch Changes

- Use suite 0.12 for Calmar; concurrent SeedSeg, MuscleMap and VesselBoost publishers already selected 0.10 and 0.11.

## 0.11.20260918

### Patch Changes

- Reserve a distinct offline suite version for Calmar's corrected example while the SeedSeg suite release is in progress.

## 0.10.20260918

### Patch Changes

- Remove SeedSeg's unsuitable synthetic example from the offline suite.

## 0.9.20260918

### Minor Changes

- b5143b7: Replace the two suite editions with one platform archive plus one platform-independent model pack.

  The models-included edition embedded the same ~2.0 GB of model files in all four platform archives, which uploaded about 6 GB of identical bytes per release. The models now ship once as `webapps-VERSION-models.tar.gz`, whose entries are the sha256-named files the application already keeps in its model cache.

  `createModelResolver` takes an optional pack directory and checks it before the cache and before any network fetch. A matching file is served where it is, so the pack can be read-only and shared. Set `NEURODESK_MODELS_DIR` to the absolute path of the extracted pack for a fully offline install, or bind-mount one shared pack into every HPC job.

  The published catalog `suite` now carries four platform downloads plus a `models` record, and the per-download `modelsIncluded` edition flag is gone.

### Patch Changes

- 28baa44: Build the model pack from fixed archive headers so one model set always produces one archive, and reference an already published archive in a new suite instead of uploading its bytes again.

## 0.8.20260917

### Patch Changes

- Publish an offline suite containing TopoFit 0.7.20260917.

## 0.7.20260917

## 0.7.20260916

## 0.6.20260916

## 0.6.20260915

### Patch Changes

- Prevent Niimath input loading from overwriting processed results during offline batch jobs.

## 0.5.20260915

### Patch Changes

- Include T1 and T2 head MRI examples for Brain extraction.

## 0.4.20260915

### Minor Changes

- Add Brain extraction with BET, MindGrab and SynthStrip, including the pinned model and an offline extraction check.

## 0.3.20260915

### Patch Changes

- Add OpenRecon scanner-console package links for MuscleMap, QSMbly via QSMxT, Spinal Cord Toolbox, SynthSeg, TopoFit and VesselBoost.

## 0.2.20260915

### Minor Changes

- Offer desktop and HPC downloads both with and without models. Put official Neurodesk Docker and Apptainer downloads first, simplify installation details, and separate standalone choices into clear sections.
