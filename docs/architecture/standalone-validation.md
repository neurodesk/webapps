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
| MRI2VID | Volume-to-video conversion and MP4 export |
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

## OpenRecon links, 15 September 2026

The shared Standalone dialog exposes OpenRecon for MuscleMap, QSMbly through QSMxT, Spinal Cord Toolbox, SynthSeg, TopoFit and VesselBoost. Each mapping was checked against the corresponding recipe in [neurodesk/openrecon](https://github.com/neurodesk/openrecon/). The interface links to Siemens teamplay C2P for the official package, the build repository and the specific recipe. Apps without a mapping omit the section.

Source `ad6f89e` passed 26 focused catalog, design-system and version tests, a fresh production build, the 24-app interface audit, all mobile layouts, six disclosure workflows and the all-app Standalone link test. The link test checks OpenRecon visibility, package names, destinations and section order. Desktop and 320-pixel phone screenshots were reviewed in dark and light themes, with no horizontal overflow. [Web CI 35023309215](https://github.com/neurodesk/webapps/actions/runs/35023309215) passed all application and shared-site checks. These tests cover the webapp integration; they do not run packages on an MRI scanner.

[Release CI 35023235467](https://github.com/neurodesk/webapps/actions/runs/35023235467) passed startup, portable workflow and installed-app checks for both editions on macOS ARM64, Windows x64 and Linux x64. Both Linux editions passed Docker and Apptainer checks. [Suite 0.3.20260915](https://github.com/neurodesk/webapps/releases/tag/webapps-v0.3.20260915) includes the OpenRecon links in the installed application dialogs. All published binary URLs passed availability checks; the final production build passed the 24-app Standalone link test with the updated release catalog.

Brain extraction and suite 0.4.20260915 landed while this change was in progress. The merge preserves that newer 25-app suite in the download catalog and adds the six OpenRecon mappings. Suite 0.4 predates the scanner-link UI; its installed copy receives the links on a subsequent suite release.

## fastprep hardware evidence, 18 October 2026

[Standalone run 39148546224](https://github.com/neurodesk/webapps/actions/runs/39148546224), source `ad4c57cd`, ran fastprep's complete offline workflow in the installed macOS ARM64 desktop on its Metal WebGPU adapter: the pinned motor-task example through brain extraction, registration, tissue segmentation, SynthSR distortion correction and the GLM, 40 files in the results archive, in 5.5 minutes. The Linux runner and the model-pack job failed the same workflow at tissue segmentation ("the mindmap module exited with status 1"), and Windows ran out of its 30 minutes. Electron 40 under Xvfb with the desktop's SwiftShader switches on a Linux host without a GPU reproduced the Linux failure at the same step and timing, and MindGrab's own log named the cause: it selects its WebGL2 backend, brain extraction returns a blank brain ("the network found no brain; the output will be blank") and tissue segmentation exits with status 1 after 49 seconds. fastprep is therefore listed with the hardware-GPU workflows in `scripts/desktop/ci-apps.mjs`, and `test/standalone.test.mjs` requires that listing for every app whose browser tests declare `ci.hardware_gpu` and compute in the browser.

## fastprep hosted evidence, 19 October 2026

What the 18 October Windows job showed: MindGrab's `auto` backend chose software WebGL2 on the GPU-less runner and each of the three MindGrab calls before the coregistration took 5.5 to 7.5 minutes; the workflow then sat at "Running niimath" from 19:55 until its 30-minute deadline. The two coregistration commands (`niimath -allineate`, `coreg_lpc.json` and `coreg_rigid.json`) did not finish in those 10 minutes. Why they stalled is unresolved: the slow MindGrab calls before them do not explain the interval, lingering resource pressure or different segmentation outputs might, and neither was shown.

What is proven on current main, where MindGrab runs its CPU module on a software renderer (#490) and SynthSR runs on WASM without an adapter (#403): the whole workflow completes on every hosted runner, with the same two niimath commands at 30 to 60 s and each niimath module instantiated in under 0.1 s. [Standalone run 39325045987](https://github.com/neurodesk/webapps/actions/runs/39325045987) (source `37d30f5`, main at `14b8248` with fastprep returned to hosted coverage, `publish=false`) is the green evidence: 40 files in the results archive on each runner, MindGrab on `cpu` and SynthSR on `wasm` where there is no GPU. Pipeline wall times: windows-latest 15:04 (MindGrab 103 to 175 s per call, coregistration 32.5 s and 59.4 s), ubuntu-22.04 under Xvfb 15:58, macos-15 5:05 (WebGPU), and the model-pack job passed its workflow step in 14:57. [Run 39325557715](https://github.com/neurodesk/webapps/actions/runs/39325557715) repeated this with per-command niimath timing in the technical log and passed fastprep's offline step on Windows in 14:30 (coregistration 33.0 s and 56.9 s); its Windows job then failed in "Package and test the installed suite" on LCModel's installed startup (`net::ERR_CONNECTION_FAILED`, then the 60-second Standalone-button timeout), after fastprep's installed startup had passed, so that run is not Windows validation of the suite. A Linux host without a GPU reproduced the hosted result locally in 10:41.

Timeout headroom, estimated rather than measured on a full suite: the normal nightly ([run 39195749092](https://github.com/neurodesk/webapps/actions/runs/39195749092)) took 17:25 on Windows and 26:49 on Linux; adding fastprep's workflow gives about 32:29 and 42:47 against the jobs' 100-minute limit, and fastprep keeps its own 30-minute deadline in `scripts/desktop/workflows.mjs`.

fastprep is back in the hosted desktop workflow coverage, listed in `cpuWorkflowApps` in `scripts/desktop/ci-apps.mjs`; `test/standalone.test.mjs` requires every app in that set, and fastprep by name, to stay in the hosted selection.

## Release gates

GitHub Actions builds one locked asset bundle, then starts every installed app on macOS ARM64, Linux x64 and Windows x64. Eight CPU-compatible workflows also run on each platform. Packaging is followed by another all-app startup test using the extracted executable. Linux additionally builds a Docker image, tests it with `--network=none`, and executes a batch job from the Apptainer SIF. Publication requires those jobs to pass and checks every archive part and the reassembled archive SHA-256.

The repository's production interface audit, phone layout tests and disclosure workflow tests passed locally. The phone suite now opens Standalone as well as Privacy. Published binary URLs and app-version coverage are checked again before web deployment.

## Reproducing the local test

After the documented build and bundle assembly:

```
NEURODESK_WORKFLOWS=1 node scripts/desktop/smoke.mjs
```

Set `NEURODESK_TEST_REPORT` to preserve screenshots, native downloads and `startup.json`. Use `NEURODESK_TEST_APP` with comma-separated IDs for a focused run. `NEURODESK_EXECUTABLE` selects an extracted release executable, and `NEURODESK_BUNDLE` selects its packaged offline resources. GitHub uploads the same reports as workflow artifacts.
