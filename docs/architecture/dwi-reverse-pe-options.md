# Reverse phase-encoding distortion correction: options

Decision document for [#471](https://github.com/neurodesk/webapps/issues/471), 19 October 2026.
The app that follows from it is [#473](https://github.com/neurodesk/webapps/issues/473).

## Question

A dataset can have b0 images with opposite phase-encoding (PE) directions, for example AP and PA.
A reverse-PE method calculates the susceptibility field from such a pair.
FSL `topup` is the usual tool, but its licence does not permit a port.
This document finds a method that we can port into the `sdc` app.

Synb0-DisCo is not an alternative to this method.
It makes a synthetic undistorted b0 from a T1w image and then needs a reverse-PE solver: it runs `topup` with the synthetic image as the second image (`acqparams` row `0 1 0 0.000`).
Its `--notopup` option stops before that step, so it can supply the solver that this document chooses.
Thus the solver comes first and Synb0-DisCo is a later front end.

## Recommendation

**No candidate passes the required image gate on every subject.**
Issue #471 requires T1w alignment no worse than topup's.
DR-BUDDI is worse on sub-0001, sub-0003 and sub-0005, so it does not pass that rule.
Its field is the closest to topup's: a mean demeaned Δfield of 1.43 Hz, the same as topup's own spread (topup with one b0 per side, 1.39 Hz).
Under the unaccepted wider limits below, it would be the only passing candidate.
The proposed 1.5 x field margin is also unaccepted; PyHySCO is at 1.52 x.

**What we build first: PyHySCO, then DR-BUDDI.**
DR-BUDDI took 42 minutes and 5 GB natively with 8 threads.
In a browser that is probably more than an hour, near the WebAssembly memory limit.
This measurement does not show that a browser port is usable.
PyHySCO took 4 s and 0.9 GB, its port is small, and its gap is small and stated here:

- Its AP-PA agreement is better than topup's on every subject (0.72 to 0.89 x).
- Its T1w alignment is a little worse on two subjects: BBR 1.024 x (sub-0003, inside topup's own spread there) and 1.030 x (sub-0005, outside it).
- Its field differs from topup's by 2.18 Hz (demeaned), against 1.43 Hz for DR-BUDDI.

Issue [#473](https://github.com/neurodesk/webapps/issues/473) schedules PyHySCO as the first method and default in `apps/sdc`.
That implementation choice does not establish a pass under issue #471's image gate.
DR-BUDDI is a follow-up issue ([#505](https://github.com/neurodesk/webapps/issues/505)) that starts with a WebAssembly build, memory and timing check before the full port.
When DR-BUDDI is usable in the browser, it becomes the "closest to topup" option.
FD-Net (5/6 under the proposed spread limits, 3.62 Hz) can be a third option only after the HCP data-use terms are checked.
ANTs restricted SyN and 3dQwarp fail the gate on every subject.

## Candidates

| Candidate | Source, version | Licence (file) | Conclusion | Status here |
| --- | --- | --- | --- | --- |
| FSL `topup` | FSL 6.0.7.23 | FSL licence | no port; reference tool only | run (reference) |
| ANTs SyN, restricted to the PE axis | ANTs 2.6.5 (native), commit `52bc0ab` 2.6.2 (WebAssembly) | Apache-2.0 (`COPYING.txt`) | port | run |
| PyHySCO | [EmoryMLIP/PyHySCO](https://github.com/EmoryMLIP/PyHySCO) `bff6655`, PyPI 0.0.4 | GPL-3.0 (`LICENSE`) | port into a GPL-3.0 package | run |
| AFNI `3dQwarp -plusminus` | AFNI 26.3.04, [afni/afni](https://github.com/afni/afni) `1dc9b75` | public domain (`LICENSE.txt`), CC-BY-4.0 for MCW parts since 12 May 2026 (`doc/README/README.copyright`) | port possible, large | run |
| TORTOISE DR-BUDDI | [QMICodeBase/TORTOISEV4](https://github.com/QMICodeBase/TORTOISEV4) `1ffb8f3`, 4.1.0, in QSIPrep 26.1.1 | GPL-3.0 (`LICENSE`); the repository also has a prebuilt BET-derived library (`external_libraries/bet/`) | port the solver only, never the bundled library; large | run |
| FD-Net | [icon-lab/FD-Net](https://github.com/icon-lab/FD-Net) `2f5c37e` | MIT (`LICENSE`) for code and weights; the weights come from HCP data, whose data-use terms must allow publication | ship only after the HCP terms are checked | run |
| Clean-room topup | Andersson, Skare and Ashburner 2003 | re-implementation from the paper | large separate project | not run |
| ACID HySCO | [ACID](https://bitbucket.org/siawoosh/acid-artefact-correction-in-diffusion-mri) `2eaff7c` | GPL-2.0-or-later (`README.txt`; the `LICENCE.txt` it names is missing at that commit) | PyHySCO is the same model | not run: needs a MATLAB licence |
| S-Net, TS-Net | [soanduong/S-Net-and-TS-Net-pytorch](https://github.com/soanduong/S-Net-and-TS-Net-pytorch) `c7a92cd` | MIT | no trained weights published | not run |
| sudistoc | [CIG-UCL/sudistoc](https://github.com/CIG-UCL/sudistoc) `90e5109` | Apache-2.0 | no trained weights published | not run |
| DrC-Net | [YuchuanQiao/DrC-Net](https://github.com/YuchuanQiao/DrC-Net) `e973e9e` | Apache-2.0, with a vendored GPL-3.0 `neuron/` | its input is FOD images, not b0 | not run |
| EPIC | [dominicholland/EPIC](https://github.com/dominicholland/EPIC) `f6bfa4a` | no licence ("Copyright 2010 Holland and Dale") | cannot port | not run |
| ANIMA distortion correction | [Inria-Empenn/Anima-Public](https://github.com/Inria-Empenn/Anima-Public) `d9fb323` | AGPL-3.0-or-later | below topup in Gu and Eklund 2019 | not run |

The licence policy for this work: GPL-3.0-compatible sources may be ported into a separate solver package.
The app that bundles that package is then distributed under GPL-3.0.
The SyN-SDC code stays Apache-2.0.

## Models and porting cost

| Candidate | Field model | Jacobian modulation | Images per PE direction | Field output | Code a port needs |
| --- | --- | --- | --- | --- | --- |
| `topup` | B-spline (cubic), movement model | yes | many | Hz (`--fout`), B-spline coefficients | not portable |
| ANTs SyN, restricted | SyN velocity field, Gaussian regularized | no | one (mean) | displacement field (mm) | reuses the `run(argv)` module of #444 and #462 |
| PyHySCO | 1D field per PE column, staggered grid, hyperelastic regularizer, Gauss-Newton with preconditioned CG | yes | one (mean) | displacement (mm) | Python/PyTorch, about 2.5k lines (`src/EPI_MRI`, `src/optimization`) |
| `3dQwarp -plusminus` | composed local patch warps (cubic/quintic Hermite) | no | one (mean) | half-warps to the midpoint (mm) | C with OpenMP: `3dQwarp.c` 4,152 lines, `mri_nwarp.c` 13,001, `thd_incorrelate.c` 2,069, plus AFNI's `mrilib` and a NEWUOA optimizer |
| DR-BUDDI | symmetric diffeomorphic, restricted to the PE axis, up and down fields opposite | yes | one per side (QSIPrep gives the mean) | ITK displacement fields (mm) | C++ on ITK 5/6 and Boost, optional CUDA: about 5.5k lines of `DRBUDDI*` plus about 80 KB of metric headers |
| FD-Net | 2D U-Net per axial slice, forward-distortion model with a sinc K-unit | yes | one per side | displacement (voxels) | TensorFlow 2.10, about 5M parameters, 21 MB weights; ONNX export needed |

## Published accuracy

- Gu and Eklund 2019 ([doi:10.3389/fninf.2019.00076](https://doi.org/10.3389/fninf.2019.00076)) compared reverse-PE methods on simulated HCP data.
  DR-BUDDI and topup were the best.
  b0 mean absolute error (LR): DR-BUDDI 2.58, HySCO 2.68, EPIC 3.20, topup 3.50.
  FA mean absolute error (LR, x 10⁻²): DR-BUDDI 1.70, topup 1.92, EPIC 3.14, HySCO 3.33.
  It did not test 3dQwarp or learned methods.
- Julian and Ruthotto 2024 (PyHySCO, [arXiv 2403.10706](https://arxiv.org/abs/2403.10706), Table 6), HCP 3T, n = 20.
  Relative improvement in image distance: PyHySCO 82.7 %, HySCO 79.0 %, topup 54.4 %.
  The metric is PyHySCO's own objective, so it favours PyHySCO.
- Zaid Alkilani et al. 2023 (FD-Net, [doi:10.1002/mrm.29851](https://doi.org/10.1002/mrm.29851)): "competitive with topup" on HCP test subjects, which are the same scanner and protocol as its training data.
- We found no published comparison of `3dQwarp -plusminus` with topup.
  Current sdcflows has a tested `init_3dQwarp_wf`, but it connects only `init_topup_wf` in production.
- We found no published blip-up/down method that uses ANTs SyN alone.
  DR-BUDDI is, in effect, the purpose-built version of that idea.

## Measurement

### Data

| Dataset | Subjects | AP b0 | PA b0 | T1w | Other |
| --- | --- | --- | --- | --- | --- |
| [ds005134](https://openneuro.org/datasets/ds005134) 1.0.0 (`34e971d`) | sub-01 | 13, in the DWI series | 8, `fmap/*_epi` | MPRAGE 0.8 mm | GRE field map (phasediff, ΔTE 2.46 ms) |
| [ds004146](https://openneuro.org/datasets/ds004146) 1.0.4 (`a0844ee`) | sub-0001 to sub-0005 | 3, in the ses-01 run-01 AP DWI series | 3, in the ses-01 run-01 PA DWI series | MP2RAGE UNIT1 (denoised) | |

ds005134 is a Siemens Skyra 3T, 2 mm, 116 x 116 x 69, TotalReadoutTime 0.038 s.
ds004146 is a Siemens Prisma fit 3T, 2 mm, 122 x 122 x 68, TotalReadoutTime 0.035 s.
Together they test both input forms that the app must read: reverse-PE b0 in `fmap/*_epi`, and b0 inside a reverse-PE DWI series.
`fetch.sh` takes each file from the public OpenNeuro bucket and checks it against the annex key in the git tree at the pinned tag.

### Preparation

`prep.sh` does this for each subject:

1. Take the volumes with b ≤ 50 from each direction.
   Crop both series to an even number of slices, because `b02b0.cnf` subsamples by 2 (ds005134 goes from 69 to 68 slices).
2. Align each direction's b0 volumes to its first volume (`mcflirt -refvol 0`) and average them.
   The first AP b0 is topup's reference frame, so every field lives on that grid.
3. Align the PA mean to the AP mean rigidly with ANTs (the sdcflows PEPOLAR setup).
4. T1w: MindGrab brain mask, FSL FAST white matter for the BBR cost.

topup gets all b0 volumes, as the protocol decided.
Every other method gets the same mean AP and aligned mean PA pair.

### Methods as run

| Method | Command (see `methods.sh`) |
| --- | --- |
| `topup` | `topup --config=b02b0.cnf --nthr=8` on all b0 volumes; `topup-single` on the first AP and the first PA b0 only |
| ANTs | `antsRegistration` SyN, PA onto AP, `--restrict-deformation` on the PE axis, CC radius 4, the SyN-SDC schedule (`SyN[0.8,6.0,10.0]` 200x100 then `SyN[0.8,2.0,0.5]` 10); field = half the displacement |
| PyHySCO | its command-line defaults (Gauss-Newton, Jacobi-PCG, α 300, β 10⁻⁴, 50 iterations, single precision); CPU with 8 threads, and once on the GPU |
| 3dQwarp | `-plusminus -blur -1 -1 -minpatch 9 -noweight -pblur 0.05 0.05 -nopadWARP -noXdis -noZdis` (sdcflows) |
| DR-BUDDI | the TORTOISE `DRBUDDI` binary from QSIPrep 26.1.1, b0 only, inputs written as QSIPrep's `GatherDRBUDDIInputs` writes them (LPS, float32, dummy `.bmtxt`) |
| FD-Net | the 42-subject DWI weights, each axial slice with the PE axis first, zero-padded to 144 x 168 |

### One field convention and one resampler

Every method's output becomes a field in Hz with topup's sign on the AP b0 grid (`fields.py`).
`calibrate.py` finds the sign that relates topup's field to the sampling displacement: it corrects the first AP b0 with topup's field and keeps the sign that reproduces topup's own `--iout`.
`correct.py` then applies every field the same way: linear interpolation along the PE axis and Jacobian modulation.
Thus the metrics compare fields, not each tool's resampler.

### Gate, ranking and choice

The target is a field as close as possible to topup's.

**Required image gate, from issue #471.**
A method must pass both checks on every subject:

- **AP-PA agreement.**
  After correction, the mean absolute AP-PA difference in the brain, divided by the mean corrected b0 intensity, is at most 1.1 x topup's value.
- **T1w alignment.**
  The BBR cost of the corrected mean b0 against the T1w white matter (FSL `flirt -cost bbr`, one shared start) is no greater than topup's value.

**Proposed alternatives, not accepted.**
The first proposal allows BBR at most 1.02 x topup's value while keeping AP-PA at most 1.1 x.
The second uses the larger of those limits and topup-single's ratio on each subject.
It was proposed after phase 2 showed sub-0003, where topup with one b0 per side fails the proposed fixed limits itself (AP-PA 1.23 x, BBR 1.065 x).
Both proposals loosen the issue's rule and need the issue owner's decision before they set acceptance.
The results retain the counts under both proposals. They are not passes under the required gate.
`aggregate.py` uses the required gate for acceptance and prints the proposed counts separately.
A method with a missing subject result cannot pass every subject.

**Ranking.**
The methods are ranked by the median absolute difference of their field from topup's in the brain, after the median offset is removed (the demeaned Δfield).
A constant field is a translation along the PE axis.
topup's movement model and the rigid PA-to-AP alignment each absorb a different part of it, so the raw offset is not a property of the field.
On sub-01, topup's own offset from the GRE field map is -5.6 Hz.
The raw Δfield is reported too.
Twice the difference between topup and topup with one b0 per side is a reference line for topup's own spread, not a threshold.

**Choice.**
The licence is a hard filter.
Issue #471 chooses the cheapest port among the methods that pass its required image gate.
No measured candidate qualifies on every subject.
A proposed alternative adds a field margin: the cheapest passing port wins only if its mean demeaned Δfield is at most 1.5 x that of the closest method; otherwise the closest method wins.
That extra selection rule is unaccepted.

**Reported only:**

- the AP-PA agreement without Jacobian modulation, which does not penalize methods without an intensity model (3dQwarp, ANTs);
- the field difference from the ds005134 GRE field map, raw and demeaned;
- wall time and peak memory with 8 threads.

The brain mask is MindGrab on topup's corrected mean b0, the same for every method.

Issue #471 treats a median absolute field difference of 0.5 Hz as a warning, not as the image gate.
topup with one b0 per side differs from full topup by 0.84 Hz on sub-01.

### Conventions settled on sub-01

Phase 1 found three errors in the first scripts, and each fix comes from the tool's own definition, not from the scores:

- `antsRegistration --restrict-deformation` is a per-stage option. The first run gave it only to the second stage, and the warp had x and z components of up to 2.9 mm.
- FD-Net's K-unit pushes undistorted voxel i to position i + f(i) (`out[j] = Σ_i im[i]·sinc(i + f(i) − j)`), so the correction samples the distorted image at x + f(x). The first conversion had the opposite sign, and its field correlated with topup's at r = −0.90.
- The 3dQwarp `_MINUS` warp applies to the base (AP): resampling AP with it reproduces `qwarp_MINUS` at r = 0.998.

## Results

The full tables, with every method and subject, come from `aggregate.py runs`.
All times are native, with 8 threads; PyHySCO also ran once on the RTX 5080.

### Summary over six subjects

| Method | Proposed spread limits | Proposed fixed limits (AP-PA 1.1, BBR 1.02) | Mean Δfield demeaned (Hz) | Mean Δfield (Hz) | Mean r | Mean time (s) | Max peak RAM (GB) |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `topup` | 6/6 | 6/6 | 0 | 0 | 1 | 163 | 1.04 |
| `topup`, one b0 per side | 6/6 | 5/6 | 1.39 | 1.43 | 0.992 | 40 | 0.26 |
| DR-BUDDI | **6/6** | **6/6** | **1.43** | 3.94 | 0.981 | 2530 | 4.96 |
| PyHySCO | 5/6 | 4/6 | 2.18 | 4.49 | 0.954 | 4.3 (GPU 1.9) | 0.94 (GPU 1.81) |
| FD-Net | 5/6 | 5/6 | 3.62 | 5.01 | 0.931 | 6.6 | 1.28 |
| FD-Net, PA as first input | 4/6 | 3/6 | 3.70 | 4.62 | 0.924 | 6.6 | 1.29 |
| ANTs restricted SyN | 0/6 | 0/6 | 4.06 | 5.91 | 0.728 | 369 | 0.73 |
| `3dQwarp -plusminus` | 0/6 | 0/6 | 12.2 | 12.4 | 0.354 | 35 | 0.35 |

topup's time is high on sub-01 (438 s) because it gets all 21 b0 volumes there.
The PyHySCO GPU run gives the same field as the CPU run.

### Image gate ratios to topup, per subject

AP-PA / BBR, each divided by topup's value.
The BBR ratios divide the costs as `aggregate.py` prints them (4 significant digits); from the exact costs four of them differ by 0.001 (`sdc/reverse-pe-options/README.md`). The gate uses the exact costs.

| Subject | `topup`, one b0 per side | DR-BUDDI | PyHySCO | FD-Net |
| --- | --- | --- | --- | --- |
| ds005134 sub-01 | 1.03 / 0.995 | 0.81 / 0.987 | 0.89 / 1.005 | 0.84 / 0.989 |
| ds004146 sub-0001 | 1.05 / 1.000 | 0.84 / 1.007 | 0.82 / 1.011 | 0.94 / 1.018 |
| ds004146 sub-0002 | 1.03 / 1.001 | 0.81 / 0.997 | 0.79 / 1.009 | 0.85 / 1.009 |
| ds004146 sub-0003 | 1.23 / 1.065 | 0.87 / 1.009 | 0.85 / 1.024 | 0.91 / 1.018 |
| ds004146 sub-0004 | 1.02 / 1.002 | 0.70 / 0.971 | 0.72 / 0.976 | 0.77 / 0.980 |
| ds004146 sub-0005 | 1.04 / 1.002 | 0.90 / 1.016 | 0.88 / **1.030** | 1.01 / **1.034** |

Every reverse-PE method agrees better between AP and PA than topup, because each one fits the mean pair directly.
The T1w alignment separates them.
Under issue #471's required rule, these T1w alignment results fail:

- DR-BUDDI: sub-0001 (1.007), sub-0003 (1.009), sub-0005 (1.016).
- PyHySCO: sub-01 (1.005), sub-0001 (1.011), sub-0002 (1.009), sub-0003 (1.024), sub-0005 (1.030).
- FD-Net: sub-0001 (1.018), sub-0002 (1.009), sub-0003 (1.018), sub-0005 (1.034).

The wider-limit counts do not establish a passing method under the required rule.

### Demeaned Δfield from topup (Hz), per subject

| Subject | `topup`, one b0 per side | DR-BUDDI | PyHySCO | FD-Net |
| --- | --- | --- | --- | --- |
| ds005134 sub-01 | 0.79 | 1.93 | 2.73 | 4.25 |
| ds004146 sub-0001 | 0.97 | 1.14 | 1.55 | 3.31 |
| ds004146 sub-0002 | 0.85 | 1.32 | 1.90 | 3.25 |
| ds004146 sub-0003 | 3.93 | 1.58 | 3.31 | 4.77 |
| ds004146 sub-0004 | 1.16 | 1.38 | 1.87 | 2.96 |
| ds004146 sub-0005 | 0.66 | 1.22 | 1.74 | 3.21 |

### Second reference: the GRE field map (ds005134 sub-01)

All methods agree with the GRE field in shape; topup's correlation with it is 0.94.
topup's offset from it is -5.6 Hz, which the demeaned value removes.
Demeaned difference from the GRE field: topup 2.74 Hz, topup with one b0 per side 2.86, DR-BUDDI 3.29, PyHySCO 3.60, FD-Net 4.47, ANTs 2.91, 3dQwarp 7.29.
The GRE map puts the methods in the same order as topup does, except ANTs, whose field is smooth but whose images fail the gate.

### Why ANTs and 3dQwarp fail

Neither has Jacobian modulation, and the gate's AP-PA metric includes it.
Without it (`appa_mad_nojac`, reported only), ANTs has the best AP-PA agreement on every subject (0.84 to 0.91 x topup), and 3dQwarp has it on sub-01 only (0.74 x).
But their fields differ from topup's in shape (mean r 0.73 and 0.35), and the modulated images and the BBR cost fail on every subject.
3dQwarp's own corrected outputs also fail (AP-PA 0.119 against topup's 0.073 on sub-01), so the cause is not our resampler.

## ANTs reverse-PE decision (#507)

ANTs restricted SyN is **not offered for reverse-PE pairs**. The tested SyN-SDC
schedule failed the required image gate on all six subjects; it also passed zero
subjects under either proposed relaxed image limit. Its mean field correlation
with topup was 0.728 and mean demeaned field difference was 4.06 Hz (tables above).
Better unmodulated AP-PA agreement does not satisfy the modulated-image and BBR
gates, so it does not justify exposing this schedule as a correction option.

This decision uses the existing six-subject results and pinned native artifacts
below; no new schedule or successful gate is claimed. A future reverse-PE schedule
must satisfy the original six-subject gate before it can become an app option.
No thresholds are relaxed by this decision.

Single-PE, T1w-guided ANTs SyN-SDC remains a separate planned method (#462–#466).
Its grid/precision experiment and accuracy/memory gates are pending; it is not
currently available in the app. The app's canonical About text states both limits.

## Port gate

A port passes when its browser field agrees with the native field of the same method on ds005134 sub-01: median absolute difference < 0.1 Hz in the brain.
This applies to the CPU WebAssembly path and, separately, to the WebGPU path.
The native fields come from the reference runs above. They are pinned on Hugging Face ([#504](https://github.com/neurodesk/webapps/issues/504)): `<subject>/<method>/field_hz.nii.gz` under `sdc/reverse-pe-options/` (see "Pinned results").
The browser run must use the same mean AP and PA pair, so the app's preparation also needs a check against `prep.sh`.

For DR-BUDDI, a port is not started until a WebAssembly build of the solver runs sub-01 inside the browser memory limit in an acceptable time.

## Follow-up issues

1. **Pin the evaluation data on Hugging Face** ([#504](https://github.com/neurodesk/webapps/issues/504)). Done: see "Pinned results".
2. **DR-BUDDI in WebAssembly** ([#505](https://github.com/neurodesk/webapps/issues/505)). First a feasibility check: build the solver (not the bundled BET library) with the ITK WebAssembly toolchain of `packages/registration`, run sub-01 in a browser, and measure time and memory, also with fewer iterations or a coarser schedule. Port into `apps/sdc` only if that passes and the field still passes the gate.
3. **WebGPU path for PyHySCO** ([#506](https://github.com/neurodesk/webapps/issues/506)). The Gauss-Newton and PCG steps as WebGPU kernels, held to the CPU field by the port gate.
4. **ANTs restricted SyN** ([#507](https://github.com/neurodesk/webapps/issues/507)). It failed the gate on every subject with the SyN-SDC schedule. Decision: do not offer ANTs for reverse-PE data; see [the recorded decision](#ants-reverse-pe-decision-507). Single-PE SyN-SDC remains pending #462.
5. **Synb0-DisCo front end** ([#508](https://github.com/neurodesk/webapps/issues/508)). Its `--notopup` output (a synthetic undistorted b0) as the second image for the chosen solver, for data without a reverse-PE b0. Needs its own check against topup with the same synthetic image.
6. **fastprep PEPOLAR** ([#509](https://github.com/neurodesk/webapps/issues/509)). Use the `sdc` solver package in fastprep for reverse-PE field estimation.

## Reproduce

The scripts are in [`dwi-reverse-pe-options/`](dwi-reverse-pe-options/).
From the repository root, export `ROOT` as a scratch directory.
The scripts need Apptainer, AWS CLI, the container images below, and the method environments under `ROOT` that `common.sh` and `methods.sh` name.
Install the workspace dependencies first so the checked-in MindGrab driver can load its pinned package.
Then run:

```bash
export ROOT=/path/to/scratch/reverse-pe
export SCRIPTS="$PWD/docs/architecture/dwi-reverse-pe-options"
bash "$SCRIPTS/fetch.sh" "$ROOT"
bash "$SCRIPTS/prep.sh" <subject> <ap.nii.gz> <ap.bval|-> <pa.nii.gz> <pa.bval|-> <t1w.nii.gz>
bash "$SCRIPTS/methods.sh" <subject> <method>      # topup first, then the others
bash "$SCRIPTS/post.sh" <subject> <method>...
bash "$SCRIPTS/gre.sh" ds005134-sub-01 <magnitude1.nii.gz> <phasediff.nii.gz>
bash "$SCRIPTS/post.sh" ds005134-sub-01 <method>...  # add the GRE metrics
bash "$SCRIPTS/phase2.sh"                         # the other five subjects
python3 "$SCRIPTS/aggregate.py" "$ROOT/runs"
```

`aggregate.py` requires all six subject summaries by default.
An explicit subject list selects a subset for a preliminary report.
A failed optional method does not stop `post.sh` from recording completed methods; it cannot pass the all-subject gate.
A missing or failed topup baseline stops post-processing with an error.
### Pinned results

The prepared inputs (AP mean, PA mean and its alignment to the AP mean, b0 mask, T1w white-matter segmentation), every method's field in Hz and every `metrics.json` and `summary.json` are on the Hugging Face dataset `neurodeskorg/webapps`, `sdc/reverse-pe-options/`, at commit `d9f25191` (167 files, 268 MB, CC0 sources).
`results.manifest.json` pins each file's size and SHA-256, and the folder's `README.md` describes each file.
The tables above come back without OpenNeuro, the containers or `epic`:

```bash
python3 "$SCRIPTS/fetch_results.py" /path/to/results    # or name subjects to fetch only them
python3 "$SCRIPTS/aggregate.py" /path/to/results
```

After a new upload, `fetch_results.py --pin <40-hex commit>` rewrites the manifest.

The script checks need no imaging tools:

```bash
python3 -m unittest discover -s docs/architecture/dwi-reverse-pe-options -p 'test_*.py'
```

| Tool | Version |
| --- | --- |
| FSL | Neurodesk `fsl_6.0.7.23_20261013` |
| ANTs | Neurodesk `ants_2.6.5_20261012` |
| AFNI | Neurodesk `afni_26.3.04_20261015` |
| QSIPrep (TORTOISE) | `qsiprep:26.1.1`, `sha256:b7d91d9755fd97647632a1f900238425239cd834c97e9866b20af39e224d383a` |
| PyHySCO | 0.0.4, PyTorch 2.8.0 (CUDA 12.8) |
| FD-Net | `2f5c37e`, TensorFlow 2.10.0 (CPU) |
| MindGrab | `@brainchop/mindgrab` 0.1.20260925, CPU, through `@neurodesk/node-drivers` |

These are verified published OCI artifacts for the three dated Neurodesk tags above:

| Published artifact | OCI manifest digest |
| --- | --- |
| `vnmd/fsl_6.0.7.23:20261013` | `sha256:0748f16e5c0a0a75f27875da84076377843b8095f1ba5f41974578aac135d7de` |
| `vnmd/ants_2.6.5:20261012` | `sha256:4f303bfd2be37a9514614d71065bfc11052e299f3a9cab52df28114d96061807` |
| `vnmd/afni_26.3.04:20261015` | `sha256:a863229b68640435eb04e4ce63eca1b50bddc1c0431f0b728c5295169e7fe655` |

The Docker Registry V2 manifest responses were checked on 20 October 2026; each response's SHA-256 equals its `Docker-Content-Digest`.
Use the repository name with `@sha256:…` to identify the published artifact independently of its tag.
The measured runs used the named CVMFS SIF files in `common.sh`.
Their original bytes and SIF checksums remain unavailable.
An OCI manifest digest is not a SIF checksum and does not prove the exact original environment.
These published pins do not complete issue #471's original-environment evidence, and the measurements have not been rerun from them.

The runs used `epic` (32 cores, 123 GB, RTX 5080), with every method limited to 8 threads.
The prepared inputs, every method's field and the metrics are on Hugging Face ("Pinned results").
