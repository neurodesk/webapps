# Agent automation work packages

PR #99 extends the desktop job runner into a typed operation and MCP interface
for the 28 catalog applications. Existing schema-1 selector jobs remain supported.
The user reported the Mac larger-buffer experiment on 2026-09-30; see the hardware evidence below.

## Delivery checklist

- [x] WP1: Publish versioned app contracts and JSON Schema.
- [x] WP2: Share explicit completion, failure, cancellation and stale-run protection.
- [x] WP3: Return structured reports with artifact hashes and scientific provenance.
- [x] WP4: Validate requests and verify downloaded reports and artifacts before success.
- [x] WP5: Expose discovery, validation, asynchronous execution and resources over local MCP stdio.
- [x] WP6: Verify the initial brain-extraction and SynthSeg integrations and package the desktop.
- [x] Compare catalog input/output requirements and select the operation contract.
- [x] WP7: Support multiple input roles, DICOM selection, variable artifacts and viewer operations.
- [x] WP8: Complete all catalog adapters and the application template.
- [x] WP9: Add bounded viewer sessions with public crosshair, tab and region controls.
- [x] WP10 implementation: Add native SynthSeg label-volume summaries and real CPU/model checks.
- [ ] WP10 hardware: Run real WebGPU and full-volume native Metal parity on the user's Mac.
- [x] WP11 implementation: Add declaration and production registration gates plus workflow tests.
- [ ] WP11 hardware: Record the Apple-silicon adapter limits and larger-buffer planning evidence.
- [x] WP12: Finish integrated checks, release metadata, documentation and PR update.

## Operation contract

Each app owns `automation.json` and registers explicit awaited handlers through
`registerAppAutomation`. The same scientific processing runs for manual and agent
requests. Schema 2 describes named operations, input roles and formats, typed
parameters, engines, output roles and cardinality. The build stamps the version
and publishes the contract beside the page. Static apps also receive a vendored
copy so they can load the same contract without a bundler.

The shared browser layer validates parameters, prepares files and DICOM inputs,
assigns a run identity and publishes only the current run's actual returned
artifacts. Multiple DICOM candidates require explicit selection by converted
content hash. Raw-DICOM applications retain their own acquisition metadata and
series selection. Reports preserve original input hashes and conversion details.

The desktop transfers files through one hidden input and invokes fixed operation
commands. A successful run requires agreement between the contract, browser
report and downloaded artifact hashes. Cancellation terminates owned workers and
prevents late completion. Overall deadlines include preparation and export.
Schema-1 jobs still use their selectors and `failSelector` behavior.

Viewer operations retain their windows by default. Other operations can request
`retainViewer`. At most four sessions remain open. Viewer commands are serialized
and bounded to 30 seconds. Crosshair coordinates use public world-millimetre
APIs; unsupported controls are reported as unavailable. Closing a session releases
its window and directory grants without deleting completed outputs.

See [the automation guide](../../packages/desktop/AUTOMATION.md) for requests,
resources, DICOM selection and viewer controls. See
[scientific validation](../../packages/desktop/SCIENTIFIC-VALIDATION.md) for the
Mac commands and the distinction between buffer planning and inference.

## Scientific execution evidence

The checks below use real production code and inputs unless marked otherwise.
Transport, geometry and artifact checks do not establish clinical accuracy.

| Application | Evidence collected on Linux | Hardware work remaining |
| --- | --- | --- |
| Brain extraction | BET golden mask and MCP resource hashes; real MindGrab CPU and SynthStrip WASM masks and geometry | MindGrab GPU behavior on target hardware |
| SynthSeg | Six native CPU reference cases; exact reports, affine and per-label volumes; small final adapter cases | Native Metal and browser WebGPU reference parity |
| EdgeReg | Real fixed/moving registration and output files | None for tested CPU path |
| ANTs | Real SyN workflow and four output artifacts | None for tested CPU path |
| Greedy | Real affine registration and transform | None for tested CPU path |
| FireANTs | Real CPU registration | GPU backend parity remains separate |
| SynthSR | Real CPU model against reference, cancellation and report hashes | GPU inference remains separate |
| MuscleMap | Real model on synthetic input, metrics and cancellation | Scientific accuracy beyond the transport fixture |
| VesselBoost | Pinned TOF input, 1434 mask voxels, physical volume and output hash | None for tested CPU path |
| Spinal Cord Toolbox | Real T2 model, 23597 mask voxels and artifact hash | Other declared models need their own numerical oracles |
| SeedSeg | All four models on a synthetic three-seed fixture, geometry and six output files | Clinical accuracy is not established by this synthetic fixture |
| QSMbly | Real example through masking, ROMEO, V-SHARP and RTS; generated-mask and supplied-mask runs agree byte for byte after resolving voxel defaults | None for tested WASM path |
| Carotid Flow | Public example gives 231 and 211 mL/min; label and curve hashes match | None for tested method |
| NiiMath | Actual voxel arithmetic, cancellation and worker retry | Other NiiMath operations retain their upstream numerical tests |
| SurfAnnotate | Actual surface geometry, source summary and viewer controls | None for tested viewer path |
| ZARRo | Real Zarr chunk loading, world coordinates, layouts and measurement | Larger remote datasets remain data-specific |
| DICOMpare | Actual Python analysis and protocol comparison on synthetic DICOM metadata | Protocol validity depends on the supplied schema |
| MRI2VID | Real playable WebM, encoded dimensions, hash and explicit DICOM series selection | Other browser codecs remain platform-specific |
| Deface | Real affine method, cancel/retry, preserved geometry and retained voxel intensities | Other seven method accuracies remain separate |
| Disconnectome | ENIGMA result equals CLI TSV byte for byte; wrong-grid rejection | Atlas-specific scientific interpretation is unchanged |
| SYNcro | Existing UI checks and wrong-grid rejection before downloads | Complete supplied-image normalization test is opt-in |
| Brain2Print | Actual worker cancellation and corrected STL/MZ3 geometry serialization | Complete hardware segmentation/meshing test |
| DWI2TRX | Known-tensor CPU fit gives FA about 0.603; output checksum and gradient validation | Complete GPU tracking with subgroup support |
| TopoFit | Worker checksum failure, cancellation, surface bytes and actual UI patch workflows | Complete image-to-surface inference test is opt-in |
| Easy MP2RAGE | Real correction and denoising; SA2RAGE result agrees with Python golden within 0.1 ms | None for tested WASM path |
| BrowserQC | Real CPU segmentation, finite QC metrics, BIDS sidecar, cancellation/retry and propagated QC failure | GPU model inference remains separate |
| CALMaR | Supplied-lesion map equals the pinned Visual channel at every voxel; wrong-affine rejection; full CPU candidate workflow produces a binary 160×256×256 mask with 65,607 foreground voxels and requires human review | Candidate accuracy needs an expert lesion reference; target-machine execution can use the documented opt-in check |

Native SynthSeg's six reference cases include small, 1 mm and 2 mm images in
fast and default modes. Five cases had zero differing voxels; the 2 mm default
case differed at one of 5,611,200 voxels. All affine errors were zero. The final
operation adapter rerun matched both small reference cases exactly and verified
report volumes against the downloaded labels. These are CPU results.

The software adapter probe accepts a planned 1,981,808,640-byte buffer and rejects
the 3,623,878,656 bytes required by the 192×256×256 plan. It does not perform
inference. An adapter reporting about 4 GiB does not validate a larger SynthSeg
allocation. The 2 GiB cap remains unchanged until larger-volume parity has an
appropriate oracle and target-hardware evidence.

On 2026-09-30 the user reported a 3.38 GiB Mac experiment. Three default-mode
runs matched CPU exactly. One fast-mode run matched, but another reported
success with 197,959 differing voxels, 1.57%, above tolerance. An earlier
attempt lost its browser page. No swap use was observed. The cause remains
unresolved, and the user restored the original cap without changing this
branch. Keep the 2 GiB limit. Buffer allocation alone does not prove correctness.
This is user-reported evidence: the summary JSON remains on the user's Mac
and was not independently inspected here. It does not establish completion
of the full native Metal and catalog hardware validation checklist.

SynthSeg now publishes that budget in its operation contract. `apps_validate`
and `runs_start` reject oversize NIfTI headers before opening a processing
window. Tests compare the preflight geometry to the real Rust WASM preprocessing
and the declared bytes-per-voxel factor to the actual GPU graph planner. DICOM
geometry is explicitly deferred until conversion. Native execution is exempt.

The review follow-up also incorporates PR #98's duplicate-download fix with its
original authorship, renames public MCP tools to underscores, and declares input
cardinality. Real DICOM conversion now handles repeated slice basenames while
preserving original hashes. Closing a retained window releases its session.

## Integrated verification

Before the catalog extension, the initial two-app implementation passed source
and unpacked Linux desktop MCP checks after rebasing onto `main` at `5622530`.
The catalog pass adds a real retained-viewer exercise: BET produces the golden
246875-voxel mask, resources match their hashes, world coordinates and active
tabs update, and connection closure cancels work and closes viewers.

The released sources pass 80 desktop tests, 138 shared-component tests and their
browser showcase, 172 repository tests, five Mac evidence-runner tests, and all
36 lint tasks. The 29-task production build assembles all 27 apps. Every built
page publishes and registers the exact source contract. Static build regressions
cover both clean sources and obsolete vendored contracts. A generated template
also passes its actual browser download check.

The unpacked Linux desktop contains the same 14 modules as the tested source.
Its MCP check accepts a supported SynthSeg input, rejects an oversized input in
both validation and start, and completes the BET and retained-viewer checks
above. SynthSeg's seven browser transport tests include exactly one download per
export. Real WebGPU inference is checked separately on a hardware adapter.

The catalog interface audit and mobile checks pass for all 27 apps. Review of
93 desktop and phone captures found a populated DICOMpare overlap, now fixed and
covered by real DICOM imports at 320 and 390 pixels with touch emulation. The
final DICOMpare interface and mobile checks use a fresh production build. All
ten interface workflow checks pass on that build.

Mac scientific checks remain pending by user choice. The script and guide make
them runnable without remote machine access. CALMaR's complete CPU candidate
workflow passed in 7.3 minutes, preserving the source affine and dimensions,
verifying artifact hashes, and leaving the lesion unconfirmed for human review.

The first hosted CI run exposed missing build preparation in the browser jobs.
Those jobs now build each app before testing, so clean checkouts receive the
generated ONNX and Rust WASM runtimes. Removing VesselBoost's generated runtime
reproduced its initialization timeout locally; rebuilding restored the real
workflow. DICOMpare's unit runner now selects source tests, and its browser
command explicitly runs the automation and populated-phone Playwright tests.
All six previously failing CI commands pass locally after the build step,
including the real model workflows. DICOMpare's four Playwright cases and its
example-import check also pass. Hosted CI must confirm the updated commit.


## Merge integration, 2026-09-30

Main added White matter lesions while this PR was open. Its schema-2 adapter
uses the same awaited segmentation handler as the Run button, returns the
mask, probability image and lesion TSV, and records the actual backend and
model hashes. Cancellation terminates the worker and permits a new run.
The SynthSeg merge retains the single-download callback and the current
structured report handler. The 2 GiB browser cap is unchanged.
