# Standalone validation

## Local hardware run, 15 September 2026

Source application bundles were built from commit `7244446`, including the Greedy coordinate-overflow fix. Electron 40.10.6 ran on macOS ARM64 with a hardware WebGPU adapter. Each app started in a fresh profile. The desktop host served only packaged assets and rejected external requests. All 24 workflows passed with zero missing packaged files or blocked external requests.

| App | Exercised workflow |
| --- | --- |
| MuscleMap | Segmentation, cleanup, metrics and provenance |
| VesselBoost | Vessel segmentation after explicitly skipping optional preprocessing |
| Spinal Cord Toolbox | Segmentation output |
| CALMaR | Brain extraction and NIfTI export |
| QSMbly | Compiled SWI calculation, all 4,096 output values checked |
| SeedSeg | Four lesion models and consensus |
| dicompare | Compiled Python worker analyzes four synthetic DICOM slices; checks acquisition grouping, file/slice counts and repetition time |
| Deface | Default-image defacing and NIfTI export |
| EasyMP2RAGE | Denoising and derivatives ZIP export |
| NiiMath | Add-one image operation and NIfTI export; a separate numerical check verified all 100,672 voxels with zero error |
| DICOM2VID | Volume-to-video conversion and MP4 export |
| BrowserQC | Small-volume QC and JSON export |
| SurfAnnotate | Surface import, border creation, fill and FreeSurfer label export |
| ZARRo | Explicit local OME-Zarr directory grant, volume loading and NIfTI export |
| SynthSR | Synthesis and NIfTI export |
| SynthSeg | Segmentation and NIfTI export |
| SYNcro | Full-size packaged T1 example through synthesis, extraction, registration and results ZIP export |
| dwi2trx | Tensor fitting, FA export, streamline tracking and TRX export |
| EdgeReg | Registration and registered-image export |
| Greedy | Registration and registered-image export |
| ANTs | SyN registration and registered-image export |
| Brain2Print | Segmentation, meshing and manifold STL export with binary triangle-count validation |
| TopoFit | Surface-fitting workflow and QC volume export |
| FireANTs | Registration and registered-image export |

The DICOM analysis check was added after the full matrix and passed separately against the same packaged application.

These tests verify runnable workflows and output structure. They do not replace each scientific package's accuracy/parity validation or establish validity for every possible clinical input. The small SynthSeg fixture is unsuitable for the SYNcro normalization test: it produced a non-finite deformation. The full-size packaged registration example passed. Extreme trial coordinates now have a Rust regression test and no longer crash the worker pool.

## Local Linux container check

The x86-64 distribution also ran in Docker on the local Apple silicon host through its Linux emulation. With `--network=none`, all 24 installed apps opened their Standalone dialogs without missing assets or external requests. The actual container entrypoint also completed the NiiMath batch job. All 100,672 output voxels matched the expected add-one result with zero error. The image includes `tini`: without it, Xvfb waits indefinitely when its launcher is PID 1. The runtime preflight and all-app container test exercise this startup path in CI.

## Published release

[Neurodesk Webapps 0.1.20260915](https://github.com/neurodesk/webapps/releases/tag/webapps-v0.1.20260915) was published from `89282bd`. [Release run 34948689850](https://github.com/neurodesk/webapps/actions/runs/34948689850) passed every job: locked bundle, macOS ARM64, Windows x64, Linux x64, Docker, Apptainer and publication. macOS signing and Apple notarization succeeded. The Linux container matrix started all 24 apps with networking disabled; Docker and Apptainer batch outputs passed the numerical check.

## Editions with and without models, 15 September 2026

[Release run 34984278938](https://github.com/neurodesk/webapps/actions/runs/34984278938), source `59dd783`, tested both editions on macOS ARM64, Windows x64 and Linux x64. All six platform/edition jobs passed the 24-app startup checks, eight portable workflows and the installed executable checks. Both Linux editions also passed the Docker startup test with networking disabled and the Docker/Apptainer numerical batch tests. [Repository CI 34984286284](https://github.com/neurodesk/webapps/actions/runs/34984286284) passed the application, browser and shared interface checks.

Locally, all 24 apps started in the edition without models, including from the packaged macOS executable. MuscleMap and SynthSR completed image workflows after downloading their pinned models. The bundle verifier rejects model files accidentally copied into this edition; a regression test loads the actual Electron Builder configuration and requires exactly one resource directory. Model-cache tests cover integrity failures, retry, concurrent requests, reconstructed model pieces and invalid paths. The full edition has no model-download fallback.

The final repository, desktop and shared layout regression run passed 163 tests. Neurodesk container downloads use the official CVMFS filenames; all 12 assigned Apptainer URLs returned HTTP 200. Docker and Apptainer versions are recorded separately where their published dates differ.

[Neurodesk Webapps 0.2.20260915](https://github.com/neurodesk/webapps/releases/tag/webapps-v0.2.20260915) contains all eight platform/edition downloads. Every published binary URL passed its availability check. A fresh production build using that catalog passed the 24-app interface audit, mobile layouts, six disclosure workflows and all-app Standalone link checks. Desktop and 320-pixel phone screenshots were reviewed; the dialog has no horizontal overflow and orders containers, downloads without models, then downloads with models included.

## Release gates

GitHub Actions builds one locked asset bundle, then starts every installed app on macOS ARM64, Linux x64 and Windows x64. Eight CPU-compatible workflows also run on each platform. Packaging is followed by another all-app startup test using the extracted executable. Linux additionally builds a Docker image, tests it with `--network=none`, and executes a batch job from the Apptainer SIF. Publication requires those jobs to pass and checks every archive part and the reassembled archive SHA-256.

The repository's production interface audit, phone layout tests and disclosure workflow tests passed locally. The phone suite now opens Standalone as well as Privacy. Published binary URLs and app-version coverage are checked again before web deployment.

## Reproducing the local test

After the documented build and bundle assembly:

```
NEURODESK_WORKFLOWS=1 node scripts/desktop/smoke.mjs
```

Set `NEURODESK_TEST_REPORT` to preserve screenshots, native downloads and `startup.json`. Use `NEURODESK_TEST_APP` with comma-separated IDs for a focused run. `NEURODESK_EXECUTABLE` selects an extracted release executable, and `NEURODESK_BUNDLE` selects its packaged offline resources. GitHub uploads the same reports as workflow artifacts.
