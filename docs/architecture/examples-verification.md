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
| CALMaR | Matched T1 and lesion mask for lesion processing. |
| QSMbly | Complete four-echo magnitude/phase images and acquisition metadata. |
| SeedSeg | Labelled synthetic T1 prostate signal-void phantom; software demonstration only. |
| dicompare | Complete 120-slice DICOM series, used as matching reference and test acquisition. |
| Easy MP2RAGE | Synthetic UNI, INV2 and SA2RAGE inputs with matching acquisition parameters. |
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

SeedSeg's phantom contains three idealized signal voids. It is not patient data
and does not validate implanted-gold-marker detection. A real seed42-model run
with production bias correction and softmax produced no detections at threshold
0.1 (maximum probability 0.000356). The full four-model browser ensemble also
completed and downloaded its consensus NIfTI with zero foreground at the default
threshold. The example text makes this limitation
explicit. Do not interpret a successful software run as clinical validation.

The MP2RAGE phantom exercises parameter handling and quantitative processing;
it is not clinical validation either. Its real WASM T1 output agreed with the
forward-model golden within 0.000151 ms, with exact NIfTI round-trip values.

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
