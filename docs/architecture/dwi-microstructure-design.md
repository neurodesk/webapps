# Diffusion preprocessing and microstructure apps

Design decisions, 18 October 2026. Names and paths below are the plan. They are not implemented APIs until the build order marks them done.

## Goal

Make FA, MD, AD, RD, V1, ICVF, ISOVF and OD maps from diffusion MRI with all processing in the browser.
Each stage is a separate app that is useful alone.
Each app has a portable Node command line that runs the same WebAssembly as the browser.
There is no pipeline app now.
A pipeline specification for all apps in this repository is a later, separate design.

## What the repository already has

| Need | Existing code |
| --- | --- |
| NIfTI + bval + bvec input | `apps/dwi2trx/src/dwi2trx/input.ts` (`resolveInput`, `resolveTriple`) |
| DICOM to NIfTI with bval, bvec and BIDS sidecar | `packages/runtime-support/src/dcm2niix-client/index.ts` (`readImageFiles` pairs each image with its sidecar) |
| bval/bvec parse, b0 index | `packages/dwi2trx/src/gradients.js` |
| Single-shell tensor fit | vendored niimath `--dtifit` (`packages/dwi2trx/src/tensor.js`) |
| Brain mask | MindGrab (`@brainchop/mindgrab`) |
| Affine registration | EdgeReg (`packages/edgereg`, niimath `-allineate`), greedy (`exes/greedy`) |
| Deformable registration | ANTs `antsRegistration` WebAssembly with full argv (`packages/registration/src/main.cxx`) |
| WebGPU U-Net inference | `packages/runtime-support/src/gpu-unet` (conv3d only) |
| Nonlinear least squares | `exes/fida/src/ops/nlinfit.rs`, `exes/lcmodel/src/solve.rs` |

The repository has no denoising, Gibbs unringing, motion correction, susceptibility correction, bias-field correction, b-vector rotation, multi-shell fit, NODDI or BIDS folder reader.

## Apps

| App | Methods | Reference | Gate on the app's validation data (see Data) |
| --- | --- | --- | --- |
| `dwidenoise` | MP-PCA | MRtrix `dwidenoise` | noise map median relative difference < 2 %, denoised NRMSE < 1 % |
| `degibbs` | subvoxel shift | MRtrix `mrdegibbs` | NRMSE < 1 % |
| `n4` | N4 | ANTs `N4BiasFieldCorrection` | field correlation > 0.99 in mask |
| `hmc` | NiFreeze (default), SHORELine | NiFreeze, QSIPrep | motion parameters within 0.2 mm and 0.2° per volume |
| `sdc` | SyN-SDC; later reverse-PE topup and Synb0-DisCo | native ANTs, same schedule | field median absolute difference < 0.5 Hz in brain |
| `noddi` | DTI (WLS, default; niimath dtifit as option), NODDI by AMICO (default), NODDI toolbox, nonlinear fit | FSL `dtifit`; AMICO; NODDI toolbox in Octave; dmipy | FA and MD median absolute difference < 0.01 in WM; NODDI maps < 0.02 in WM |

Each gate is a start value.
Make a gate tighter when the port shows what it can do. Do not make a gate looser.
Compare each NODDI method with its own reference only. The differences between methods are information for About, not a test.

### Rules for every app

- Order of use: denoise, degibbs, (topup), hmc, sdc, n4, mask, fit.
- Inputs: NIfTI + bval + bvec, DICOM, and BIDS folders.
- If the phase-encoding direction or the total readout time is necessary and not in a sidecar, ask for it in an optional sidebar field. Never guess the polarity. Without it, refuse the step that needs it.
- Outputs use BIDS-derivatives names and JSON sidecars, so that the next app can read the output of the last app. Example: `hmc` writes `*_desc-hmc_dwi.nii.gz`, a rotated `.bvec` and `*_desc-hmc_motion.tsv`.
- Each app resamples once. A joint resampling of motion and susceptibility belongs to the later pipeline specification.
- QC plots go in the collapsed console. There is no separate report page.

### Gradient rules

These rules are in the `gradients` crate with tests:

- A volume is b0 when b < 50 s/mm², as in dwi2trx.
- Shells are the non-zero b-values after rounding to the nearest 100 s/mm². Then 995, 1000 and 1005 are one shell.
- NODDI needs two or more non-zero shells. With one shell, `noddi` refuses NODDI and still makes the DTI maps.
- The DTI subset is the b0 volumes plus every shell up to b = 1200 s/mm² (Q48); data with no shell that low uses its lowest shell. ds005134 (500/1000/2000) fits 60 directions at b = 500 and 1000.

## Code layout

- `exes/dwi` is a Rust workspace. It has one crate per stage and shared crates: `gradients`, `tensor`, voxel-loop, solvers (NNLS, LASSO, Levenberg-Marquardt) and DIPY model ports (SHORE, SH, tensor).
- Each stage has its own WebAssembly build. Each app loads only its module.
- `packages/<stage>` holds the JavaScript wrapper, the committed `.wasm` and the command line, as `packages/easy-mp2rage` does.
- The committed `.wasm` is built with the pinned Rust, wasm-pack and binaryen `version_117` versions. CI rebuilds it and fails when the bytes differ.
- The WebAssembly modules take and return Float32 voxel arrays, volume after volume. NIfTI reading and writing stay in the shared JavaScript (`readNiftiFrames`, `createNiftiFromData` in `@neurodesk/webapp-components/file-io/nifti`), so the browser and the command line use one reader and the Rust crates need no NIfTI code.
- The generic BIDS folder reader goes in `@neurodesk/webapp-components/file-io`. It finds `dwi/*_dwi.nii.gz` with its bval, bvec and JSON, the `fmap/*_epi` files whose `IntendedFor` names that DWI, and `anat/*_T1w`.

## Port sources and licences

| Source | Licence | Use |
| --- | --- | --- |
| AMICO ≤ 1.5.4 (last BSD commit `a8e1a2e381`) | BSD-3-Clause | port candidate for `noddi` |
| AMICO ≥ 2.0.0 | non-commercial custom licence | research-use reference only, never ported |
| dmipy | MIT | port candidate for `noddi` (AMICO and nonlinear) and reference |
| NODDI toolbox 1.05 | Artistic License 2.0 | port for `noddi`; its bundled `erfi.m` has no licence and is not ported |
| NiFreeze | Apache-2.0 | port for `hmc` |
| QSIPrep (SHORELine) | BSD-3-Clause | port for `hmc` |
| MRtrix3 | MPL-2.0 | port for `dwidenoise` and `degibbs`; these crates stay MPL-2.0 per file |
| ANTs | Apache-2.0 | already built to WebAssembly; add an N4 entry point |
| sdcflows 2.17.1 | Apache-2.0 | port for `sdc` (SyN-SDC field fit); see the [SDC plan](dwi-sdc-plan.md) |
| Synb0-DisCo code and weights | MIT | later, for `sdc` |
| FSL (topup, eddy, dtifit) | FSL licence, no port | reference outputs only; topup is a clean-room implementation |

The AMICO source for `noddi` is chosen after a comparison of three candidates on the same data: a port of AMICO 1.5.4, a port of dmipy `amico_cvxpy`, and a clean-room prototype from Daducci et al. 2015.
AMICO 2.1.1, run for research only, is the common comparison.
The person who writes the clean-room prototype does not read the AMICO or dmipy source.

### AMICO comparison, 18 October 2026

Data: ds001226 sub-CON01 (b = 0/700/1200/2800, 102 volumes, raw), FSL `bet` b0 mask, white matter = FSL `dtifit` FA > 0.4.
dmipy fitted 4000 random brain voxels (1029 in white matter); the other fits used every voxel.
Each method ran with its documented defaults.

| Pair | ICVF r | ISOVF r | OD r | OD p95 abs. difference in WM |
| --- | --- | --- | --- | --- |
| AMICO 1.5.4 vs 2.1.1 | 0.999 | 1.000 | 0.909 | 0.168 |
| AMICO 1.5.4, 32761 vs 500 LUT directions | 1.000 | 1.000 | 0.998 | 0.022 |
| AMICO 1.5.4 vs clean-room | 0.60 | 0.996 | 0.45 | 0.38 |
| AMICO 1.5.4 vs dmipy `amico_cvxpy` | 0.65 | 0.994 | 0.41 | 0.49 |
| clean-room vs dmipy | 0.94 | 0.995 | 0.51 | 0.57 |

White-matter medians of OD: AMICO 1.5.4 0.222, AMICO 2.1.1 0.229, clean-room 0.159, dmipy 0.358.

Findings:

- Only a port of AMICO 1.5.4 can reproduce AMICO. The clean-room prototype and dmipy agree on ISOVF but are different methods for ICVF and OD.
- The paper does not specify what makes the difference: the OD grid (0.03, 0.06, then ten steps from 0.09 to 0.99), the 12 ICVF values from 0.1 to 0.99, the normalisation of each tissue atom before the LASSO, the merge of the b0 rows, the LASSO on the diffusion-weighted rows only (SPAMS mode 2, λ1 = 0.5, λ2 = 0.001), and the debias NNLS with the isotropic atom.
- dmipy's example uses a linear 12-point grid on OD and λ = 1e-4, so its OD is much higher.
- AMICO 1.5.4 keeps only the zonal (m = 0) spherical-harmonic coefficients of each atom (lmax 12) and rotates them with a 32761-direction table. By the addition theorem, a port can compute each voxel's atoms from those coefficients and Legendre polynomials of g·n. That needs no table (about 1.9 GB for this data) and differs from 1.5.4 only by its direction quantisation.
- The OD difference between AMICO 1.5.4 and 2.1.1 does not come from the table size. AMICO 2.x is a comparison for information only.

Decision (18 October 2026): port AMICO 1.5.4 and hold it to AMICO 1.5.4 output. The clean-room and dmipy candidates are not continued.

### AMICO port result

`exes/dwi/amico` is the port; its README lists what each part ports.
The WebAssembly module fitted all 111755 mask voxels of ds001226 sub-CON01 in 401 s on one thread (3.6 ms per voxel).
Absolute differences from AMICO 1.5.4 with its default 32761-direction table:

| Map | WM median | WM p95 | WM p99 | Brain maximum |
| --- | --- | --- | --- | --- |
| ICVF | 2.6e-5 | 4.1e-4 | 3.1e-3 | 0.099 |
| ISOVF | 1.2e-5 | 2.9e-4 | 2.9e-3 | 0.052 |
| OD | 7.7e-5 | 2.0e-3 | 7.3e-3 | 0.648 |

The port uses the exact fibre direction; AMICO uses the nearest table direction, about 1° away.
With AMICO's table direction the port agrees to a median of 2e-7 (`tests/oracle.rs`), so the remaining difference is that rounding, not the fit.

## Data

All datasets are OpenNeuro, CC0, one subject each. Decided 18 October 2026 after a search of about 120 OpenNeuro diffusion datasets.

| Use | Dataset | Why |
| --- | --- | --- |
| Primary: NODDI, HMC, SDC, N4 and the `noddi` example | ds005134 sub-01 | One run (Siemens Skyra, 2 mm, TE 91 ms): 13 b0, b = 500 ×12, 1000 ×48, 2000 ×64; 8 PA b0 volumes; T1w; `PhaseEncodingDirection`, `TotalReadoutTime` and `SliceTiming` in the sidecars |
| `degibbs` gate | ds005577 sub-107 | Full Fourier (ds005134 uses partial Fourier 0.75, which weakens Gibbs unringing); b = 1000 ×30, 3000 ×60, 11 b0 |
| Vendor check, no gate | ds007522 sub-HML0001 (Philips), ds006837 sub-15464 (GE) | The apps must run on other vendors' files and sidecars |
| AMICO parity, recorded above | ds001226 sub-CON01 | One run, b = 0 ×6, 700 ×16, 1200 ×30, 2800 ×50, 2.5 mm |
| Later: full blip-up/down | ds004146 | Full AP and PA DWI |

Rejected: ds003138, because each shell is a separate run with its own TE and one b0; the NODDI toolbox example, because its data licence is not stated and it has no reverse PE or T1w.

The `noddi` example is an axial slab of ds005134 sub-01 (slices 28-37, 67 × 92 × 10 × 137, 8.4 MB) with its 8 PA b0 volumes cut to the same box, for the later `sdc` app. Its sidecars omit the site and acquisition-time fields. It waits for an upload to the Hugging Face dataset; until then the app's example is dwi2trx's pinned single-shell DWI, which exercises the tensor fit and the NODDI refusal.
CI uses cropped data. Native reference outputs go to the Hugging Face dataset at a pinned revision.

## Build order

1. `exes/dwi` workspace, `gradients` and `tensor` crates, BIDS folder reader.
2. `noddi` with DTI and AMICO.

Status, 18 October 2026: the crates, the AMICO port and the `noddi` app are done. The first app slice reads NIfTI with bval and bvec, or DICOM (`readDiffusionSeries`), masks with MindGrab on the mean b0 or a supplied mask, and fits in Web Workers. These parts of steps 1 and 2 remain open:

- the BIDS folder reader;
- the niimath dtifit option (Q14 "allow both");
- the `noddi` command line;
- a CI workflow that runs the `exes/dwi` tests, `check:wasm` and `tests/oracle.rs` with a pinned oracle file (without it the oracle test skips, which the data-gated test rule forbids);
- the ds005134 example, after its upload to Hugging Face;
- a size limit for the input: `readNiftiFrames` holds the whole series as Float32, about 500 MB for a full-brain ds005134 DWI plus its decompressed data (dwi2trx's `input-limits.ts` is the pattern; the limit belongs in the shared package).
3. `dwidenoise`.
4. `degibbs`.
5. `n4`, with an N4 entry point in the ANTs WebAssembly build.
6. `hmc`: NiFreeze, then SHORELine.
7. `sdc` with SyN-SDC. The [SDC port and validation plan](dwi-sdc-plan.md) gives the sdcflows 2.17.1 facts, the reference runs, the gate and the milestones.
8. NODDI toolbox and nonlinear methods in `noddi`.
9. Later: reverse-PE topup, then Synb0-DisCo.

## Deferred, and why

- **Topup.** FSL's licence does not permit a port. A clean-room implementation from Andersson et al. 2003 is a large separate project. [Reverse-PE options](dwi-reverse-pe-options.md) compares the alternatives: DR-BUDDI is the closest to topup, and PyHySCO is the first method that `apps/sdc` ships.
- **Synb0-DisCo.** Its only use is as the second image for topup. It needs ConvTranspose3d and InstanceNorm3d kernels in `gpu-unet` and fp16 weights converted from the MIT `.pth` files. Its preprocessing uses N4 with WM scaling, MindGrab and EdgeReg. EdgeReg first needs a matrix output from niimath `-allineate`; greedy is the temporary replacement. Outputs are expected to be close to, not equal to, the original pipeline.
- **Eddy-style slice outlier replacement, slice-to-volume motion and least-squares reconstruction of blip-up/down data.** NiFreeze and SHORELine do not have them. FSL eddy cannot be ported.
- **Joint resampling across `hmc` and `sdc`.** It belongs to the pipeline specification.
