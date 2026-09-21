# Example coverage and verification

The September 2026 migration gives all 25 registered apps 32 declared examples
and a shared Example control in each input section. Examples do not start
processing on page load. The shared control supplies loading, cancellation, failure and retry states;
app adapters import each complete bundle through their ordinary input path.

## Data and scientific scope

Every example file is hosted in `neurodeskorg/webapps` on Hugging Face at an
immutable commit. New mirrors were published at
`560955bf9a1a669bbf2a89709b64f3e64eefe008`; existing mirrored files retain their
original pinned commits. `examples/sources.json` at the new commit records the
upstream URLs, descriptions and SHA-256 hashes. The offline source and lock
inventories record all declared files and checksums. Large files stay outside Git.

| Apps | Example purpose |
| --- | --- |
| MuscleMap | In-vivo head-to-upper-thigh MRI; excludes lower legs. Source license is CC BY-NC-SA 2.0. |
| VesselBoost | Brain MR angiography with visible vessels. |
| Spinal Cord Toolbox | Cord-centred T2 MRI. |
| CALMaR | Stroke T1 from OpenNeuro ds004884; the app computes the lesion mask for review before network mapping. |
| QSMbly | Real 3 T single-echo magnitude and phase images with acquisition metadata from the QSMxT example dataset. |
| SeedSeg | No example. The synthetic phantom was withdrawn on 2026-09-18 as unsuitable. |
| dicompare | Complete 120-slice DICOM series, used as matching reference and test acquisition. |
| Easy MP2RAGE | Real 7 T UNI, INV1, INV2 and measured B1 images from the Marques MP2RAGE reference dataset. |
| MRI2VID | Full-head anatomical MRI for video rendering. |
| SurfAnnotate | Actual cortical surface for landmark annotation and JSON export. |
| ZARRo | Cell microscopy stack, first channel/time point, with four resolution levels and three planes. |
| SYNcro, Greedy, ANTs, EdgeReg, FireANTs | Matched registration inputs. |
| dwi2trx | Diffusion image with gradients and required companion inputs. |
| Brain extraction, brain2print, TopoFit, SynthSeg | Appropriate anatomical MRI for each pipeline. |
| SynthSR | Curated FLAIR, T1, T2 and head CT choices; no unrelated angiography/diffusion gallery. |
| Deface | Full-head MRI with facial anatomy. |
| BrowserQC | Anatomical MRI plus matching BIDS metadata. |
| NiiMath | Anatomical T1/T2 inputs for image arithmetic. |
| NeSVoR | Six simulated, motion-corrupted fetal brain stacks with one brain mask from the SVRTK regression tests (Apache-2.0). Reconstruction needs a connected compute server; the browser test uses the Node reference server's simulated tool. |

SeedSeg has no example: its synthetic phantom was withdrawn because a real seed42 run produced no detections on it, so it could not demonstrate marker detection.

The MP2RAGE example produces a B1-corrected T1 map from real brain data; the browser test checks the map's grid, finiteness and a plausible median T1.

## Enforcement

`test/app-examples.test.mjs` rejects missing examples, mutable or noncanonical
URLs, incomplete file declarations, missing offline inventory and missing browser
coverage. No existing-app exemptions or runtime-generated-data exemptions remain.
The generator preserves this contract, including a real unchanged-copy download
test. New applications must replace that labelled demonstration with their method. `scripts/audit-interfaces.mjs` checks
exactly one accessible, visible Example selector on desktop and phone, matching
manifest options, an idle initial state and successful real input import. If a
browser has no WebGPU adapter and an app explicitly reports that limitation,
the audit records an import skip while still checking its interface. It does
not count that case as a successful import.

The shared selector tests cover retry, cancellation, stale completions, upload
replacement, destroyed controls, and companion download failure. App browser
tests cover the adapters and useful outputs where supported by the runner.

## Verification scope

The final audit covers all 25 apps at desktop and phone widths (50 interface
configurations). All interface checks passed. Real hosted example imports
passed for 24 apps; Deface’s two import checks were explicitly skipped because
this host has no hardware WebGPU adapter. Six interface rechecks used the
verified cache as described below.

Live checks encountered Hugging Face HTTP 429 responses after repeated catalog
downloads. CALMaR, dicompare and SurfAnnotate were rechecked using
`EXAMPLE_ASSET_CACHE` with their previously downloaded bytes. This optional audit
mode verifies every file against the offline SHA-256 and size, fails if anything
is missing or changed, and records `checksum-verified-cache` in its results. It
checks the real input workflow without claiming to recheck remote availability.
Their live hosted workflows also passed separately. Default audits use the
network. `SMOKE_APPS` restricts a rerun to named registered apps.

Real output checks include QSMbly mask preparation, reconstruction and NIfTI
download; EdgeReg registration and download; NiiMath arithmetic
with every output voxel checked, SurfAnnotate landmark JSON, ZARRo nonconstant
NIfTI export, dicompare comparison and printed image report, and the MP2RAGE
numerical check above. SeedSeg’s full four-model workflow produced its probability
maps and downloaded the synthetic consensus image after a missing ONNX runtime
file was added to staging. MRI2VID also encoded and downloaded a real MP4. Desktop and phone screenshots
were reviewed. All 144 repository tests and 62 shared component tests passed;
the separate shared showcase smoke was skipped because its Chrome discovery
found no binary. The production mobile suite passed for all 25 apps and the
catalog, and all six interface workflow checks passed. Eight generator tests
and four isolated template browser tests passed.

This host lacks the Rust/wasm-pack toolchain. Production JavaScript and static
bundles were rebuilt; unchanged generated scientific WASM kernels were reused
where the normal build requires that toolchain. A clean all-source `pnpm build`
therefore remains unverified here. GPU-only inference requires a supported
hardware WebGPU runner; example import and interface checks do not establish
numerical correctness of those models. Deface uses a WebGPU viewer: this host
cannot verify its real image import. Forced software WebGPU initializes the
viewer but fails during volume loading with Dawn’s external-instance error.
Its unsupported-WebGPU guidance and shared interface remain testable; the
positive workflow needs a hardware GPU runner.

## Independent rerun, 2026-09-19

Every app's example was rerun from a fresh production build with hosted bytes on an
8-core host without a hardware GPU. Selecting the example and running the main
action with default settings produced sensible output for ants, greedy, edgereg,
niimath, qsmbly, easy-mp2rage, surfannotate, zarro, vesselboost, dicom2vid,
dicompare, spinalcordtoolbox, topofit and calmar. brain-extraction, synthsr and
syncro (TRACE-only and CT examples) completed on their CPU paths. The rerun found
and fixed: FireANTs exceeded the engine's 15-minute watchdog on CPU and showed no
progress; the registration apps' empty viewer claimed to be loading default
images; MuscleMap's 90 % overlap default took hours without WebGPU; BrowserQC did
not ship the CPU MindGrab bundle and timed out segmentation after one minute;
SynthSR selected WebGPU whenever the API existed even without an adapter; and
brain extraction's automatic mode fell back to software WebGL, which never
finished. Seven apps placed the Example control after the file picker; the
control now precedes the picker everywhere and the interface audit enforces it.

Still open: SYNcro's TRACE plus T1 example needs a 2.8 GiB GPU buffer or more
than 2 GB of typed array on the CPU path; SynthSeg needs 1.8 GiB of GPU buffer;
CALMaR's "Lesion mask (native)" download was cancelled in headless Chromium while
its other downloads worked; deface, brain2print and dwi2trx tractography need a
hardware WebGPU adapter to verify. Browser tests still mock the example bytes in
the registration apps, and dwi2trx, synthseg, musclemap, calmar and
spinalcordtoolbox have no browser example test.
