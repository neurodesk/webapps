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

Before this design, the repository had no denoising, Gibbs unringing, motion correction, susceptibility correction, bias-field correction, b-vector rotation, multi-shell fit, NODDI or BIDS folder reader.

## Apps

| App | Methods | Reference | Gate on the app's validation data (see Data) |
| --- | --- | --- | --- |
| `dwidenoise` | Patch2Self version 1 (patch radius 0, OLS), a port of DIPY 1.12.1 | DIPY 1.12.1 `patch2self` | denoised NRMSE ≤ 1e-6 against DIPY version 1 in float64 on the slab oracle; on the stage 1 simulation, RMSE / raw noise 0.38 (i.i.d. noise) and 0.39 (spatially correlated noise) |
| `degibbs` | subvoxel shift | MRtrix `mrdegibbs` | NRMSE < 1 % |
| `n4` | N4 | ANTs `N4BiasFieldCorrection` | field correlation > 0.99 in mask |
| `hmc` | NiFreeze (default), SHORELine | NiFreeze, QSIPrep | registration: NiFreeze GP, for each volume and axis, within the native double spread of seed 1234 against seed 1235 (Q53); SHORELine gate awaits maintainer confirmation, [HMC plan, section 5](dwi-hmc-plan.md#5-reference-runs-and-gates); deterministic parts: motion decomposition 1e-6, SHORE prediction 1e-5 relative, GP prediction to the tolerance that [#448](https://github.com/neurodesk/webapps/issues/448) sets (proposed: 99.99 % of the mask voxels exact, ±1 at the others), b-vectors to the printed precision |
| `sdc` | SyN-SDC; later reverse-PE topup and Synb0-DisCo | native ANTs, same schedule | field median absolute difference < 0.5 Hz in brain |
| `noddi` | DTI (WLS, default; niimath dtifit as option), NODDI by AMICO (default), NODDI toolbox, nonlinear fit | FSL `dtifit`; AMICO; NODDI toolbox in Octave; dmipy | FA and MD median absolute difference < 0.01 in WM; NODDI maps < 0.02 in WM |

Each gate is a start value.
Make a gate tighter when the port shows what it can do. Do not make a gate looser.
The `hmc` registration gate is the exception (Q53): the start value was 0.2 mm and 0.2° for each volume, but native NiFreeze GP with a different seed, and QSIPrep with a different run, move more than that. Q53 requires the native double seed spread for the same volume and axis. Native `--float 1` fails that rule on 40/90 GP volumes in M0. The shell-maximum alternative and SHORELine extension in the HMC plan are proposals awaiting an issue-owner decision. The WebAssembly registration still runs `antsRegistration --float 1` (no 3DDouble build).
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
| MRtrix3 | MPL-2.0 | port for `degibbs`; that crate stays MPL-2.0 per file. Its `dwidenoise` (MP-PCA) is not ported (see the denoising decision) |
| DIPY 1.12.1 | BSD-3-Clause | port of Patch2Self version 1 for `dwidenoise` (`exes/dwi/denoise`) |
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

### Denoising decision, 18 October 2026 (Q49, Q56)

`dwidenoise` uses Patch2Self (Fadnavis et al. 2020), not MP-PCA.

- MP-PCA is rejected. US10698065B2 (NYU and the University of Antwerp, in force to 2036) covers noise estimation from the PCA eigenvalue spectrum, and the source file of MRtrix `dwidenoise` carries an NYU notice that limits its use to non-commercial research, separate from MRtrix's MPL-2.0. The port does not read or use either.
- The patent search (Q49) found no patent on Patch2Self. DIPY is BSD-3-Clause.
- The port is DIPY 1.12.1 `patch2self` version 1, patch radius 0, ordinary least squares: each volume is predicted from the other volumes of its group (b0 or diffusion-weighted) by one regression over all voxels. Version 1 is a linear method with one exact answer, so the port can be held to DIPY bit for bit. DIPY's default version 3 uses random subsets and does not repeat from run to run (NRMSE 0.016 between two runs on the simulation).
- DIPY 1.12.1 `model="ols"` centres the regressors in place (`copy_X=False`) and then predicts from the centred values, which adds a constant error to each volume (RMSE / raw 5.4 on the simulation). The port applies the fit to the original values, as `copy_X=True` does.
- On the stage 1 simulation, Patch2Self version 1 gave RMSE / raw noise 0.38 with i.i.d. noise, near MP-PCA (0.36 to 0.40), and 0.39 with spatially correlated noise, where MP-PCA gave 0.96 to 0.99.
- The float32 WebAssembly output on the ds005134 slab (67 × 92 × 10 × 137) equals the DIPY reference (`dwidenoise/validation`, with `copy_X=True`) bit for bit; the float64 port differs by at most 3.05e-5, the reference's own float32 rounding.

## Data

All datasets are OpenNeuro, CC0, one subject each. Decided 18 October 2026 after a search of about 120 OpenNeuro diffusion datasets.

| Use | Dataset | Why |
| --- | --- | --- |
| Primary: NODDI, HMC, SDC, N4 and the `noddi` example | ds005134 sub-01 | One run (Siemens Skyra, 2 mm, TE 91 ms): 13 b0, b = 500 ×12, 1000 ×48, 2000 ×64; 8 PA b0 volumes; T1w; `PhaseEncodingDirection`, `TotalReadoutTime` and `SliceTiming` in the sidecars |
| `degibbs` gate | ds005577 sub-107 | Full Fourier (ds005134 uses partial Fourier 0.75, which weakens Gibbs unringing); b = 1000 ×30, 3000 ×60, 11 b0 |
| Vendor check, no gate | ds007522 sub-HML0001 (Philips), ds006837 sub-15464 (GE) | The apps must run on other vendors' files and sidecars; results in [dwi-vendor-checks.md](dwi-vendor-checks.md) |
| AMICO parity, recorded above | ds001226 sub-CON01 | One run, b = 0 ×6, 700 ×16, 1200 ×30, 2800 ×50, 2.5 mm |
| Later: full blip-up/down | ds004146 | Full AP and PA DWI |

Rejected: ds003138, because each shell is a separate run with its own TE and one b0; the NODDI toolbox example, because its data licence is not stated and it has no reverse PE or T1w.

The `noddi` example is an axial slab of ds005134 sub-01 (slices 28-37, 67 × 92 × 10 × 137, 8.4 MB) with its 8 PA b0 volumes cut to the same box, for the later `sdc` app. Its sidecars omit the site and acquisition-time fields. It is in the Hugging Face dataset under `noddi/examples/` (revision `ce028ecc`). It is the first example of `noddi`, `dwidenoise` and `n4` ([#421](https://github.com/neurodesk/webapps/issues/421), [#431](https://github.com/neurodesk/webapps/issues/431)); in `noddi` it runs the tensor fit and NODDI and is the case of the command line's release check. dwi2trx's pinned single-shell DWI stays as the second example of each app; in `noddi` it exercises the NODDI refusal.
CI uses cropped data. Native reference outputs go to the Hugging Face dataset at a pinned revision.

## Build order

The tracking issue [#467](https://github.com/neurodesk/webapps/issues/467) lists the remaining work. Each step below names its issues and, as of 29 October 2026, its open items. Do the open work in this order:

- SyN-SDC, in sequence: [#462](https://github.com/neurodesk/webapps/issues/462) → [#464](https://github.com/neurodesk/webapps/issues/464) → [#465](https://github.com/neurodesk/webapps/issues/465) → [#466](https://github.com/neurodesk/webapps/issues/466). [#507](https://github.com/neurodesk/webapps/issues/507) also needs [#462](https://github.com/neurodesk/webapps/issues/462): it finds a reverse-PE schedule for ANTs restricted SyN that passes the gate, or records that ANTs is for single-PE data only.
- In parallel, with no open dependencies: [#425](https://github.com/neurodesk/webapps/issues/425), the NODDI toolbox fit in `noddi`; [#452](https://github.com/neurodesk/webapps/issues/452), the hmc input size limit for 16 GB and 8 GB machines, set from measured WebAssembly memory; [#495](https://github.com/neurodesk/webapps/issues/495), the move of `noddi` and `dwi2trx` from the vendored niimath build to the registry package.

1. `exes/dwi` workspace, `gradients` and `tensor` crates, BIDS folder reader ([#410](https://github.com/neurodesk/webapps/issues/410), [#411](https://github.com/neurodesk/webapps/issues/411)). Done.
2. `noddi` with DTI and AMICO. Done, with its command line ([#423](https://github.com/neurodesk/webapps/issues/423)), the niimath dtifit option ([#422](https://github.com/neurodesk/webapps/issues/422)), the oracle CI job ([#418](https://github.com/neurodesk/webapps/issues/418)), the shared input size limit ([#412](https://github.com/neurodesk/webapps/issues/412)), and the shared code, CI and vendor checks of the DWI apps ([#413](https://github.com/neurodesk/webapps/issues/413), [#414](https://github.com/neurodesk/webapps/issues/414), [#415](https://github.com/neurodesk/webapps/issues/415), [#416](https://github.com/neurodesk/webapps/issues/416), [#417](https://github.com/neurodesk/webapps/issues/417), [#419](https://github.com/neurodesk/webapps/issues/419), [#420](https://github.com/neurodesk/webapps/issues/420)). Open: [#495](https://github.com/neurodesk/webapps/issues/495).
3. `dwidenoise`: done. Patch2Self version 1 (`exes/dwi/denoise`, `packages/dwidenoise`, `apps/dwidenoise`), merged in [#380](https://github.com/neurodesk/webapps/pull/380) (with [#386](https://github.com/neurodesk/webapps/pull/386)). The `dwidenoise` command line ([#429](https://github.com/neurodesk/webapps/issues/429)) runs the app's worker pool on worker threads and is held to the app's downloads: the image by its decompressed bytes (the two zlib builds compress differently), the other files byte for byte. Also done: [#428](https://github.com/neurodesk/webapps/issues/428), [#430](https://github.com/neurodesk/webapps/issues/430), [#431](https://github.com/neurodesk/webapps/issues/431).
4. `degibbs`: done. The app is merged ([#379](https://github.com/neurodesk/webapps/pull/379)), with [#432](https://github.com/neurodesk/webapps/issues/432), [#433](https://github.com/neurodesk/webapps/issues/433) and [#434](https://github.com/neurodesk/webapps/issues/434).
5. `n4`, with an N4 entry point in the ANTs WebAssembly build: done in [#380](https://github.com/neurodesk/webapps/pull/380). Its command line (`packages/n4/bin/n4.js`, MindGrab on the CPU) is done in [#435](https://github.com/neurodesk/webapps/issues/435). The native comparison ([#436](https://github.com/neurodesk/webapps/issues/436)) and the rebuild check ([#437](https://github.com/neurodesk/webapps/issues/437)) are done.
6. `hmc`. The [HMC plan](dwi-hmc-plan.md) gives the milestones.
   - NiFreeze: done. Reference data and M0 ([#409](https://github.com/neurodesk/webapps/issues/409)), M1 ([#438](https://github.com/neurodesk/webapps/issues/438) to [#443](https://github.com/neurodesk/webapps/issues/443)), M2 ([#444](https://github.com/neurodesk/webapps/issues/444), [#445](https://github.com/neurodesk/webapps/issues/445), [#446](https://github.com/neurodesk/webapps/issues/446)), M3 and M5 ([#447](https://github.com/neurodesk/webapps/issues/447) to [#451](https://github.com/neurodesk/webapps/issues/451)), the app ([#453](https://github.com/neurodesk/webapps/issues/453)) and the command line ([#454](https://github.com/neurodesk/webapps/issues/454)). Open: [#452](https://github.com/neurodesk/webapps/issues/452).
   - SHORELine: the shore crate ([#456](https://github.com/neurodesk/webapps/issues/456)) and the prototypes ([#479](https://github.com/neurodesk/webapps/issues/479), [#480](https://github.com/neurodesk/webapps/issues/480), [#481](https://github.com/neurodesk/webapps/issues/481)) are done. [#455](https://github.com/neurodesk/webapps/issues/455) is closed because both SHORELine iterations of the reference runs use 3dSHORE, not a tensor. On 23 October 2026 the maintainers replaced the QSIPrep-parity milestones with DWI Correct ([#563](https://github.com/neurodesk/webapps/pull/563): `apps/dwicorrect`, `exes/dwi/shoreline`), so [#457](https://github.com/neurodesk/webapps/issues/457), [#458](https://github.com/neurodesk/webapps/issues/458) and [#459](https://github.com/neurodesk/webapps/issues/459) are closed as not planned.
7. `sdc` with SyN-SDC: the plan ([#460](https://github.com/neurodesk/webapps/issues/460)), the reference runs ([#461](https://github.com/neurodesk/webapps/issues/461)) and the field-fit crate ([#463](https://github.com/neurodesk/webapps/issues/463)) are done. Open: [#462](https://github.com/neurodesk/webapps/issues/462), [#464](https://github.com/neurodesk/webapps/issues/464), [#465](https://github.com/neurodesk/webapps/issues/465), [#466](https://github.com/neurodesk/webapps/issues/466) and [#507](https://github.com/neurodesk/webapps/issues/507). The [SDC port and validation plan](dwi-sdc-plan.md) gives the sdcflows 2.17.1 facts, the reference runs, the gate and the milestones.
8. NODDI toolbox and nonlinear methods in `noddi`: the reference outputs ([#424](https://github.com/neurodesk/webapps/issues/424), [#426](https://github.com/neurodesk/webapps/issues/426)) and the dmipy nonlinear fit ([#427](https://github.com/neurodesk/webapps/issues/427)) are done. Open: [#425](https://github.com/neurodesk/webapps/issues/425).
9. Reverse-PE correction: the options study ([#471](https://github.com/neurodesk/webapps/issues/471)) and the reverse-PE `sdc` app ([#473](https://github.com/neurodesk/webapps/issues/473)) are done. Synb0-DisCo stays deferred (next section).

## Deferred, and why

- **Topup.** FSL's licence does not permit a port. A clean-room implementation from Andersson et al. 2003 is a large separate project. [Reverse-PE options](dwi-reverse-pe-options.md) compares the alternatives: DR-BUDDI is the closest to topup, and PyHySCO is the first method that `apps/sdc` ships.
- **Synb0-DisCo.** Its only use is as the second image for a reverse-PE solver. [Synb0-DisCo front end](dwi-synb0-disco.md) (#508) measured it on six subjects. The model converts to ONNX and runs in ONNX Runtime Web (WebAssembly, 10 to 12 s and 1.8 GB for each of five folds) after each stride-1 ConvTranspose3d is written as a Conv3d. But the `sdc` solver with the synthetic b0 is not better than no correction in the field metric (11.0 Hz demeaned from topup, as for a zero field), and it makes T1w alignment worse on three subjects. The weights come from HCP and BLSA data, whose data-use terms are not checked. Its preprocessing needs N4 with WM scaling to 110, MindGrab, a rigid b0-to-T1w registration (EdgeReg after niimath `-allineate` gives a matrix; greedy before that) and only an affine T1w-to-MNI registration: the SyN warp is not used. Outputs are expected to be close to, not equal to, the original pipeline.
- **Eddy-style slice outlier replacement, slice-to-volume motion and least-squares reconstruction of blip-up/down data.** NiFreeze and SHORELine do not have them. FSL eddy cannot be ported.
- **Joint resampling across `hmc` and `sdc`.** It belongs to the pipeline specification.
