# HMC port and validation plan

Plan, 18 October 2026, for step 6 of the [diffusion design](dwi-microstructure-design.md). Readers checked NiFreeze `main` 3bcfb00 and 0.1.0, QSIPrep 26.1.1 SHORELine, DIPY and the repository's ANTs WebAssembly build. A skeptic verified each report against the cited source lines. File:line citations refer to those sources unless a path starts with a repository folder. The NiFreeze mean-b0 and GP ports, Node command line, browser app and their validation are implemented; DWI Correct ([#563](https://github.com/neurodesk/webapps/pull/563)) replaced the SHORELine milestones below. Section 8 records the decisions (Q50-Q55). Section 9 gives the M0 native reference results; section 6 now includes measured WebAssembly runtime and memory. The work items are children of the tracking issue [#467](https://github.com/neurodesk/webapps/issues/467); the [build order](dwi-microstructure-design.md#build-order) gives their status and the order of the open work.

## 1. Crate layout (`exes/dwi`)

| Crate | Status | Content |
|---|---|---|
| `gradients` | reuse, extend | Add a b0 rule for each method. NiFreeze uses `b <= 50` and scales b by the gradient vector norm (`data/dmri/utils.py:36,269-280`). QSIPrep uses `b < 100` (`cli/parser.py:589-594`). The current rule is `b < 50` and it rejects short vectors (`gradients/src/lib.rs:6,45-58`). |
| `tensor` | reuse; extend only for the tensor option | `fit_dipy_wls` follows dipy 1.7 with an f64 Cholesky solve (`tensor/src/lib.rs:106-123`). The non-default SHORELine tensor option would need a dipy 1.12.1 variant: `pinv`, float32 log, eigenvalue floor `1e-6/max(B)` (`dti.py:1476-1512`). Parity does not: every reference iteration is 3dSHORE ([#455](https://github.com/neurodesk/webapps/issues/455), closed). |
| `hmc` | new | Dataset, b0 split, `advanced_clip`, leave-one-out loop, motion decomposition, bvec rotation, TSV. |
| `gp` | new | Spherical kriging kernel, sklearn log marginal likelihood, L-BFGS-B. |
| `shore` | new | BrainSuite 3dSHORE basis, ridge solve, leave-neighbourhood-out rule. |
| `hmc-wasm` | new | wasm-bindgen entry, as in `noddi-wasm`. |

Put ANTs in a new package `packages/hmc-registration` beside `packages/registration`, as `packages/n4` does (`n4/README.md:4`). Do not change `packages/registration`. Its wasm is sha256-pinned (`src/node.js:6`), and SYNcro parity depends on it.

## 2. Registration engine

Use the ANTs 52bc0ab WASM kernel for both methods. Do not use greedy for parity, because its NMI metric is different from GC and Mattes. Greedy can be a later "fast" option with no parity claim.

Changes in the new module:
- Do not build `antsRegistration3DDouble.cxx`; keep its stub (`unsupported.cxx:10`). NiFreeze emits no `--float` (`nipype registration.py:463-467`), so native ANTs selects double (`antsRegistration.cxx:706-746`). The WASM module runs NiFreeze's argv with `--float 1`. The 2026-10-24 decision in #451 compares WASM with native float, using the existing per-volume, per-axis seed-spread limits about the world grid centre (sections 5 and 8). Keep the native-double comparison as the measured cost of float precision.
- Add `AverageImages` and `AverageAffineTransform` entry points. Add `--apply` with HammingWindowedSinc, LanczosWindowedSinc and BSpline. Today `--apply` has only linear and nearest (`apply.cxx:28-31`).
- Expose a generic `run(argv)`. Always pass `--random-seed`, because ENV is not exported (`CMakeLists.txt:37`). The kernel uses one thread (`main.cxx:15`).

NiFreeze argv:
- Use `b0-to-b0_level0` verbatim (`registration/ants.py:280-295`). Add `--masks [ brainmask, NULL ]` after each stage (`ants.py:412-415`). M0 confirmed it: NiFreeze 3bcfb00 uses `b0-to-b0_level0` for every volume, and no code path selects `dwi-to-b0_level0`.
- Settings: GC Rigid[12.0]/[1.96], Random 0.4/0.18, 20 + 10 iterations, shrink 3/2, smoothing 2.71/0 vox, histogram matching on, winsorize [0.063, 0.991], no `-r`, double precision in native NiFreeze (`--float 1` in the port). Each stage stops at its iteration limit, not by convergence.
- Fixed = prediction. Moving = raw volume.
- `--align-config` has no effect (`ants.py:400-404`).

SHORELine argv:
- Use the strings that container nipype 1.11.0 renders from `shoreline_precise_Affine.json` (model stage) and `shoreline_precise_Rigid.json` (b0 stage). The b0 stage is always Rigid (`hmc.py:241,273-274`).
- Settings: `--float 1`, Mattes 48 bins, Random 0.15/0.2, smoothing 8x2 mm / 2 mm, shrink 2x1/1, winsorize [0.002, 0.998], BSpline.
- Fixed = prediction. Moving = original volume. No initial transform (`hmc.py:618-622`).
- Capture the real cmdline from the work directory. M0 did this: `hmc/reference/qsiprep-{r1,e1,e2,e3}/collected/{b0,model}/*/NNN/command.txt`.

## 3. Model ports and numerical risks

- **NiFreeze `trivial`** is the CLI default (`cli/parser.py:85-101`). The target is the b0, or the median of the b0s.
  - Risk: `advanced_clip` must match exactly. It uses a median filter with `ball(3)`, percentiles 35/99.98 of the filtered values, a clip of the unfiltered data and `round(255x)` (`data/filtering.py:64-177`).
  - The clip writes in place only for float arrays (`filtering.py:116-117`).
  - `_to_nifti` calls the clip with `inplace=True` (`registration/ants.py:83-87`). The trivial model returns `dataset.bzero` itself, which is float64. Thus the first visit writes the clipped map into `dataset.bzero`, and each later visit clips the clipped map again. On ds005577 the second clip changes nothing (section 9), but on other data it can, and then the visit order changes the result. The port copies this (Q55).
  - Read the scipy `median_filter` boundary mode before the port.
- **NiFreeze GP** is on main 3bcfb00 only. PyPI 0.1.0 has no GP (`0.1.0 model/base.py:63-74`).
  - Kernel: spherical kriging + WhiteKernel. a is in (0.1, 2.35) and starts at 0.1, on its bound. lambda starts at 2.0. alpha is 1e-10, with `normalize_y` (`model/_dipy.py:115-121,232-237`; `model/gpr.py:54-57,694,757-759`).
  - One shared hyperparameter set is fitted again for each volume.
  - The DWI model writes `False` into `dataset.brainmask` where `bzero < 1e-5` (`model/dmri.py` `_compute_data_mask`), before NiFreeze writes the registration mask. The GP runs therefore register with, and fit on, the mask minus those voxels (11 voxels on ds005577). The trivial model does not do this.
  - On ds005577 every fit stops with a and lambda on their lower bounds (section 9). Copy the bounds, L-BFGS-B and `normalize_y` exactly.
  - The GP fit and prediction are deterministic and do not depend on the visit order: the 90 predictions are byte-identical in three runs with different seeds and precisions (section 9). Thus the GP prediction has a fixed tolerance gate, not a spread rule.
  - Risks: L-BFGS-B active-bound handling, the sum over voxel targets, the scipy defaults and the WhiteKernel bounds. Read these from the installed versions. Do not use values from memory.
- **3dSHORE** is the QSIPrep default. Port the BrainSuite basis, not dipy `ShoreModel`.
  - Basis: 72 columns, odd n included, n-outer order (`utils/brainsuite_shore.py:531-541,673-679`). SH with Condon-Shortley phase (`utils/shm.py:243-317`). zeta 700, q = sqrt(b).
  - The 1e-8 ridge is load-bearing, because rank(M) is 29-65 of 72. A `pinv` or `lstsq` port fails.
  - Compute `w = m_predᵀ solve(A, Mᵀ)` one time for each target, and apply it to all voxels.
  - Write `0⁰ = 1` explicitly.
- **SHORELine iterations** all use `shoreline_model`, 3dSHORE by default: QSIPrep 26.1.1 builds `initial_model_iteration` and `shoreline_iteration001` with the same `SignalPrediction(model=config.workflow.shoreline_model)` (`hmc.py:587,747`), and all four reference runs record `shoreline_model = "3dshore"`.
- **SHORELine tensor** (`shoreline_model = "tensor"`, not the default) uses dipy 1.12.1 WLS. Outside the mask the target is `max(b0_mean, 1e-4)`, not 0 (`dti.py:25,2362-2393`).

## 4. b-vectors and outputs

| Item | NiFreeze | SHORELine |
|---|---|---|
| Rotation | voxel 3x3 of `inv(A) inv(M) A`, no renormalisation (`data/dmri/utils.py:312-317`) | inverse affine on points 0 and 5v, LPS world, renormalised (`interfaces/gradients.py:1028-1060`) |
| Precision | `%.6f` | `%.8f` |

Port both rules exactly for the harness. The app output uses the rule of the selected method.

The app writes a BIDS derivative:
- `*_desc-hmc_dwi.nii.gz`, with the b0 volumes kept.
- `*_desc-hmc_dwi.bvec` and `*_desc-hmc_dwi.bval`.
- `*_desc-hmc_motion.tsv`.
- One ITK `.mat` transform for each volume.

TSV columns:
- `trans_x trans_y trans_z` in mm.
- `rot_x rot_y rot_z` in rad, as a rotation vector.
- `framewise_displacement` (SPM convention, 50 mm radius).

The frame is RAS+. NiFreeze matrices map reference to scan in RAS. Decompose them with the same code.

Translation: QSIPrep's `get_ras_motion_params` (`interfaces/gradients.py:905-944`) moves the point `A[:3,:3]·c`, with `c = (shape-1)/2`. That is the grid centre minus the origin, not the world grid centre `A·c`. Thus the result depends on the grid `A` that the tool decomposes on:

| Reference | Grid | Pivot `A[:3,:3]·c` (mm) | Voxel origin from world origin |
|---|---|---|---|
| NiFreeze `motion.tsv` (M0, from `motion_affines`) | raw DWI, LAS | (-119.0, 103.4, 94.6) | 184.4 mm |
| QSIPrep `motion_params_*.csv` and confounds | conformed `b0_mean`, LPS, 120 × 120 × 75 | (-119.0, -130.6, 50.8) | 187.9 mm |

- Both grids have the same world centre (0.89, 3.46, -3.53) mm. The difference from the world-centre translation is `(A - I)·(-origin)`, where `A` is the full 3 × 3 linear part of the transform. For NiFreeze (rigid) `A = R`, so the difference is about |θ| × 184.4 mm on the raw grid (trivial b1000: 3.0 mm against 1.5 mm). For the SHORELine affine transforms, scale and shear also contribute.
- The 1e-6 gate applies on the grid of the tool that made the reference: the port decomposes NiFreeze transforms on the raw DWI grid and SHORELine transforms on the conformed `b0_mean` grid.
- The TSV uses QSIPrep's formula word for word. The M0 comparison files give both conventions.

Framewise displacement: the M0 NiFreeze `motion.tsv` has 90 rows (NiFreeze drops the b0 volumes). Thus its FD is between consecutive DWI volumes, and its row 1 is 0. QSIPrep's confounds have 101 rows, and row 1 is `n/a`. The app keeps the b0 volumes (Q51) and writes 101 rows, so its FD differs from the M0 `motion.tsv`. The M1 test compares FD on the 90 DWI rows only, with the reference's own neighbours.

## 5. Reference runs and gates

First, record the dtype, `scl_slope` and b0 count of both datasets. On float data the in-place clip makes the volume order change the result. This decides whether volumes can run in parallel.

- **NiFreeze**, main 3bcfb00, Python 3.12:
  - Command: `ITK_GLOBAL_DEFAULT_NUMBER_OF_THREADS=1 nifreeze dwi.nii.gz --gradient-file dwi.bvec dwi.bval --brainmask mask.nii.gz --models trivial --seed 1234 --nthreads 1 --write-hdf5 --output-dir out`. The mask is MindGrab (`mindgrab` model) of the mean b0 (Q52).
  - Run it again with `--models gp`.
  - The HDF5 file holds `motion_affines`.
  - Patch the temporary directory so that it keeps `sample_*`, `predicted_*` and `*0GenericAffine.mat`.
- **QSIPrep** 26.1.1 container (ANTs 2.6.0.dev1-gb775a15):
  - Command used in M0: `qsiprep bids out participant --participant-label 107 --output-resolution 2 --anat-modality none --hmc-method shoreline --denoise-method none --unringing-method none --dwi-biascorrect none --ignore sdc --nthreads 10 --omp-nthreads 1 -w work --skip-bids-validation --notrack --stop-on-first-crash`. `--anat-modality none` is the DWI-only flag. QSIPrep then registers the b0 template to MNI152NLin2009cAsym for its ACPC space, which does not change the HMC transforms.
  - `--nthreads 10` lets nipype run independent nodes in parallel. Each node still computes on one thread (`--omp-nthreads 1`, and the OMP, OpenBLAS, MKL and ITK thread variables set to 1). The first run (r1, local host) used `--nthreads 1`.
  - Keep `work`. `config.toml` records the seeds that QSIPrep drew (master, ants, numpy).
  - Run it three times, because SHORELine has no seed option (`config.py:751-778`). M0 ran e1, e2 and e3 at the same time on the host epic, and r1 on the local host.
  - QSIPrep takes no external mask for HMC. Each run makes its own SynthStrip mask of its own b0 template (r1: Dice 0.947 against the MindGrab mask on ds005577). The masks of the four M0 runs differ: against r1, 25-30 voxels, Dice 0.9999.

Gates:
- Deterministic checks (fixed tolerances; these stay):
  - Decomposing the reference `.mat` files gives `motion_params.csv` and `motion.tsv` to 1e-6, on the grid of the tool that made the reference (section 4).
  - The SHORE prediction on the reference inputs agrees to 1e-5 relative.
  - The GP prediction on the reference inputs agrees to the tolerance that [#448](https://github.com/neurodesk/webapps/issues/448) sets (proposed: 99.99 % of the mask voxels exact, and ±1 at the others). The native predictions are byte-identical over seeds and precisions.
  - bvec rotation agrees to the printed precision.
- Registration (WASM, `--float 1`): first replay the kept inputs, then run end to end. The [2026-10-24 maintainer decision in #451](https://github.com/neurodesk/webapps/issues/451) replaces native double as the comparison target with native `--float 1`. The existing per-volume, per-axis Q53 seed-spread limits remain unchanged.
  - Let `d_seed[v, k] = |gp(seed 1234) - gp(seed 1235)|` for DWI volume `v` and axis `k` (trans x/y/z in mm about the world grid centre, rotation-vector x/y/z in degrees).
  - A WASM volume passes when `|wasm(seed 1234) - gp-float(seed 1234)| <= d_seed[v, k]` on each of its six axes about the world grid centre `A·c`. The run passes when every volume passes.
  - **Proposed alternative, not accepted:** for each shell `s` and axis `k`, use `L[s, k] = max over the volumes v of shell s of d_seed[v, k]` instead. This would loosen Q53. It needs an issue-owner decision before it can be an acceptance gate.
  - The limits, from `hmc/reference/compare/q53-seed-rule.json`: b1000 0.117 / 0.248 / 0.219 mm, 0.291 / 0.228 / 0.195°; b3000 0.426 / 0.709 / 0.402 mm, 0.550 / 0.591 / 0.788°. Native `--float 1` passes this proposed alternative on all 90 volumes (largest ratio to its proposed limit 0.72). This is not a pass under Q53.
  - M0 measured these limits on GP only, from one seed pair. The trivial model has no seed pair in M0.
  - Native `--float 1` fails the historical comparison against double on 40 of 90 volumes (58 of 540 world-centre cells), because one seed pair gives some cells a spread near 0. Keep that precision-cost report and the QSIPrep-pivot comparison visible. Neither is a substitute for the accepted native-float, world-centre gate. Also report same-shell raw-mean image correlation in the GP mask for WASM, native float and native double.
- **Complete GP loop, 2026-10-24:** all 90 predictions are exact; the accepted native-float world-centre gate passes all 540 cells. The additional QSIPrep-pivot comparison fails one translation cell (volume 52), retained in the report. At the world centre that difference is 0.029730 mm against a 0.036337 mm limit. Matched cubic-spline output QC gives median raw-mean correlations 0.902327/0.635975 (WASM), 0.902327/0.635975 (native float), and 0.902354/0.634689 (native double), for b1000/b3000. No path has a volume drop over 0.02. Linear QC separately reproduces the archived native-double 0.909626/0.673994; interpolation must be matched when comparing these values. The package README gives the reproduction commands.
- **Proposed SHORELine registration gate, decision pending:** extend the shell-maximum alternative to the QSIPrep 26.1.1 repeat spread of e1, e2 and e3 (host epic). This proposal in `hmc/reference/qsiprep/spread-e123-rule.json` is not an accepted extension of Q53. [#408](https://github.com/neurodesk/webapps/issues/408) requires maintainer confirmation of the SHORELine rule.
  - Let `d[v, k]` = the maximum over the pairs (e1, e2), (e1, e3), (e2, e3) of `|run_a - run_b|` for volume `v` and axis `k` (trans x/y/z in mm about the world grid centre, rotation-vector x/y/z in degrees of QSIPrep's `decompose44` rotation). For each shell `s` (b0, b1000, b3000) and axis `k`, the limit is `L[s, k] = max over the volumes v of shell s of d[v, k]`.
  - Under this proposal, a WASM volume would pass when `|wasm - ref| <= L[s, k]` on each of its six axes. The run would pass when all 101 volumes pass. `ref` is the QSIPrep run whose inputs the WASM run replays. Only `qsiprep-r1` keeps the fixed images, so M2 replays the argv of r1's `command.txt` files with r1's ANTs seed (57526, as `ANTS_RANDOM_SEED`) against r1's images and compares with r1's `.mat` files.
  - The limits: b0 0.007 / 0.018 / 0.022 mm, 0.037 / 0.030 / 0.015°; b1000 0.026 / 0.031 / 0.029 mm, 0.051 / 0.043 / 0.061°; b3000 0.046 / 0.055 / 0.141 mm, 0.208 / 0.096 / 0.183°. By QSIPrep's translation formula (for a check in its own convention): b0 0.037 / 0.040 / 0.089 mm, b1000 0.170 / 0.152 / 0.188 mm, b3000 0.350 / 0.637 / 0.461 mm. These are the shell maxima of the repeat-spread table in section 9.
  - The spread includes the per-run seed and the per-run SynthStrip mask: each run drew its own ANTs seed and made its own b0 template and SynthStrip mask (the model-stage `--masks`, 25-30 voxels different). Thus the limits are not seed noise only.
  - The cross-host run r1 is not always within these limits: against e1, e2 and e3, 4, 10 and 9 of 101 volumes are over a limit at the world centre (largest ratio 1.80), and 4, 8 and 3 by QSIPrep's formula (largest ratio 1.58) (`qsiprep/spread-r1-e{1,2,3}.json`). The limits rest on three runs on one host. The M2 replay keeps r1's inputs, so it does not have the template and mask change.
  - The SHORELine transform is affine (|scale − 1| up to 0.026, shear up to 0.013), so its rotation is not unique. The limits use the rotation of QSIPrep's `decompose44` (transforms3d), because the port must match QSIPrep's `motion_params_*.csv` to 1e-6. With the polar factor of the same affine, the b3000 maximum is 0.073 / 0.081 / 0.094° and 0/101 volumes are over 0.2°; with `decompose44` it is 0.208 / 0.096 / 0.183° and 1/101.
  - The mask displacement does not depend on a convention: the largest b3000 displacement of the mask voxels between two runs is 0.48-0.50 mm (MindGrab mask 0.484 mm for e1-e3 and 0.488 mm with r1; e1 SynthStrip mask 0.497 and 0.500 mm). The six-axis limits ignore scale and shear.
- The QSIPrep repeat spread is above the fixed gate for b3000 (section 9). M0 reports this result. The proposed SHORELine acceptance rule remains blocked on the maintainer decision required by #408.
- On the slab, report the through-plane axes separately. ds005577 is the main SHORELine gate.

## 6. Runtime and memory

The first estimates (2-10 s for each call, NiFreeze trivial 1-6 min, SHORELine 10-40 min) were too low for SHORELine. M0 measured the native reference tools on ds005577 (120 × 120 × 75 × 101, 2 mm, 90 DWI volumes). Each computation used one thread; the epic QSIPrep runs ran 10 nipype nodes in parallel:

| Run | Wall time | Per DWI volume | Peak memory |
| --- | --- | --- | --- |
| NiFreeze trivial, double | 407-421 s | about 4.6 s | 0.83-0.97 GB |
| NiFreeze GP, double | 647-707 s | about 7.5 s | 1.35-1.38 GB (with the scikit-learn patch, section 9) |
| QSIPrep SHORELine, 2 iterations, Affine, r1 (local, `--nthreads 1`) | 17954 s (5.0 h), CPU 16987 s | 74 s for each iteration: registration 40.8 s + SHORE prediction 32.8 s (mean of the 180 nipype nodes of each kind) | 7.54 GB (cgroup peak, page cache included) |
| QSIPrep SHORELine, e1/e2/e3 (epic, `--nthreads 10`, three runs at the same time) | 3551 / 3761 / 3785 s (4.7-5.1× faster than r1), CPU 28666 / 30481 / 30508 s | - | 18.0-18.1 GB (cgroup peak, page cache included) |

- The GP fit without the patch needs about 11.5 GB: scikit-learn 1.9.1 builds an (89, 89, 161668) float64 array (10.2 GB) for the gradient. The port must sum over the targets first, as the patch does.
- Each epic run used 1.7-1.8 times the CPU seconds of r1, because the three runs and their 10 parallel nodes shared one host.
- QSIPrep time by node (r1): model-stage registrations 7335 s, SHORE predictions 5897 s, b0 template registrations 2238 s (22 × 102 s, Rigid, 1000 iterations). The remaining 2.5 ks is conform, SynthStrip, ACPC registration and outputs.
- The GP target memory estimate stays: about 1.6e5 mask voxels × 90 volumes.
- Anchors for the WASM build: SYNcro WASM, affine + SyN at 1 mm, 186 s (`packages/syncro/validation/README.md:33`); N4 on the slab, 1.9 s (`packages/n4/README.md:22`). Each kernel starts at 256 MiB (`CMakeLists.txt:35`), so 4 workers need about 1 GiB.

### Measured WebAssembly pipeline (#452)

The completed matrix contains 120 successful trials: two inputs, two methods, two hosts, three worker counts, and five repeats per configuration. Every trial completed all expected registrations and resamples, produced finite corrected frames and motion/b-vector tables, kept original b0 frames unchanged, and verified all artifact hashes. The decompressed corrected-image bytes and all remaining emitted artifact bytes are hash-identical across hosts and worker counts within each input/method combination; gzip container bytes are not compared. Full input trials processed 101 frames and 90 DWI volumes; slab trials processed 137 frames and 124 DWI volumes. These are software-output checks, not new scientific accuracy gates.

Measurements used source `4ef5de3f7265dccb5157707da9e1ca37ff0193f3`, HMC app/package `0.4.20261024`, HMC WASM SHA256 `9ab321e70b7533264e80b5a5fbd4343fd0cfa19e232c56d550cbb2243f3c8f22`, and registration WASM SHA256 `d552ee295d79cd1722ced2c13c58d9afa0a5008275bbe70593d8caf9243de9ef`. All trials have the same 72-file source/manifest/lock identity map. The host was Linux `7.0.0-29-generic`, AMD EPYC-Milan, eight logical CPUs, 33,649,500,160 bytes RAM (31.34 GiB), Node `v24.19.0`, and Chromium `156.0.8078.4`. No 16 GB limit was imposed; the CPU quota was unavailable.

The reserved host ran one trial at a time. Worker order rotated across five repeats: `1,2,4`; `2,4,1`; `4,1,2`; `1,4,2`; `2,1,4`. Hosts were blocked rather than alternated: all 60 Node trials preceded all 60 Chromium trials. Input order was full then slab, and method order mean-b0 then GP. Within-host worker comparisons therefore have alternating repeats, but Node-versus-Chromium differences can include host-order drift and are not a browser overhead estimate. No profile ran during timing.

The timed region calls `correctNiFreeze`, including model preparation, lazy targets, registration-worker startup, registration, resampling, and gzip output. Input fetch/decode and output verification are outside that region. RSS sampling starts with the child process/browser launch and includes input preparation plus correction, stopping before verification. RSS is absolute summed process-tree resident memory, not private memory or WASM capacity; shared pages can be counted twice and sampling can miss short peaks. Timing trials use supplied masks, exclude automatic masking and the production viewer, and start in fresh processes. Seconds per DWI divide the complete correction time by 90 or 124, not by all frames and not by registrations alone.

Full is ds005577 sub-107, `120 × 120 × 75 × 101`, from HF revision `a4ba04733c316430add7e9f8467887a1a47b6e65`, image SHA256 `06d5a733005a9e463f1ca6b581d0a8725378b60967c23dd63d49cc04362e83b9`. Its pinned MindGrab mask has 161,668 effective GP voxels. Slab is ds005134 sub-01, `67 × 92 × 10 × 137`, from HF revision `ce028ecca10e9abe7988f965e03ad51627ca9c52`, image SHA256 `1e7c8461d9bfc3c80633f930dc1df16d892a6bfd5e15db4c5a2be9d021e48d00`. Its supplied mask is pinned at HF revision `5c224669930eef653ea42e1dc40c7449930e29bd`. The full bval/bvec/mask pins and all slab pins are recorded by `packages/hmc/validation/benchmark-pins.mjs`.

All entries below are the median and observed minimum/maximum of five trials. Displayed values are rounded; equal displayed bounds need not mean zero variation. GiB is bytes divided by 2³⁰.

| Input | Model | Host | Workers | Wall seconds, median [min, max] | Seconds / DWI, median [min, max] | Peak RSS GiB, median [min, max] |
| --- | --- | --- | ---: | ---: | ---: | ---: |
| full | mean-b0 | node | 1 | 155.06 [154.56, 155.61] | 1.723 [1.717, 1.729] | 3.44 [3.43, 3.47] |
| full | mean-b0 | node | 2 | 86.23 [86.22, 86.67] | 0.958 [0.958, 0.963] | 3.53 [3.49, 3.54] |
| full | mean-b0 | node | 4 | 52.88 [52.73, 53.68] | 0.588 [0.586, 0.596] | 3.59 [3.54, 3.62] |
| full | mean-b0 | chromium | 1 | 152.33 [151.93, 152.71] | 1.693 [1.688, 1.697] | 3.72 [3.72, 3.72] |
| full | mean-b0 | chromium | 2 | 86.55 [86.16, 86.76] | 0.962 [0.957, 0.964] | 3.72 [3.72, 3.72] |
| full | mean-b0 | chromium | 4 | 54.19 [54.02, 54.33] | 0.602 [0.600, 0.604] | 3.73 [3.73, 3.74] |
| full | GP | node | 1 | 409.89 [407.57, 410.37] | 4.554 [4.529, 4.560] | 3.51 [3.48, 3.52] |
| full | GP | node | 2 | 306.94 [304.64, 307.54] | 3.410 [3.385, 3.417] | 3.47 [3.40, 3.56] |
| full | GP | node | 4 | 294.56 [293.76, 296.65] | 3.273 [3.264, 3.296] | 3.51 [3.48, 3.57] |
| full | GP | chromium | 1 | 406.83 [406.67, 408.57] | 4.520 [4.519, 4.540] | 3.75 [3.75, 3.75] |
| full | GP | chromium | 2 | 309.09 [307.14, 309.41] | 3.434 [3.413, 3.438] | 3.75 [3.75, 3.75] |
| full | GP | chromium | 4 | 298.39 [295.77, 299.17] | 3.315 [3.286, 3.324] | 3.75 [3.75, 3.76] |
| slab | mean-b0 | node | 1 | 15.73 [15.65, 15.77] | 0.127 [0.126, 0.127] | 0.59 [0.56, 0.59] |
| slab | mean-b0 | node | 2 | 8.55 [8.45, 8.60] | 0.069 [0.068, 0.069] | 0.64 [0.62, 0.66] |
| slab | mean-b0 | node | 4 | 5.02 [4.99, 5.06] | 0.041 [0.040, 0.041] | 0.75 [0.75, 0.78] |
| slab | mean-b0 | chromium | 1 | 15.26 [15.16, 15.55] | 0.123 [0.122, 0.125] | 0.79 [0.78, 0.80] |
| slab | mean-b0 | chromium | 2 | 8.62 [8.51, 8.87] | 0.070 [0.069, 0.071] | 0.84 [0.83, 0.86] |
| slab | mean-b0 | chromium | 4 | 5.50 [5.44, 5.57] | 0.044 [0.044, 0.045] | 0.95 [0.94, 0.96] |
| slab | GP | node | 1 | 163.79 [163.46, 164.70] | 1.321 [1.318, 1.328] | 0.66 [0.59, 0.66] |
| slab | GP | node | 2 | 149.36 [149.25, 149.74] | 1.205 [1.204, 1.208] | 0.71 [0.68, 0.71] |
| slab | GP | node | 4 | 148.63 [148.16, 148.96] | 1.199 [1.195, 1.201] | 0.75 [0.74, 0.77] |
| slab | GP | chromium | 1 | 161.85 [161.62, 162.08] | 1.305 [1.303, 1.307] | 0.82 [0.81, 0.82] |
| slab | GP | chromium | 2 | 148.66 [148.28, 149.67] | 1.199 [1.196, 1.207] | 0.87 [0.85, 0.87] |
| slab | GP | chromium | 4 | 147.79 [147.73, 148.75] | 1.192 [1.191, 1.200] | 0.96 [0.95, 0.98] |

### Limiter and worker default

Choose two registration workers by default for the HMC app, automation contract and command line, based on GP scaling. In Chromium, full-input median time falls from 406.83 s at one worker to 309.09 s at two. Four workers reduce it to 298.39 s, a further 3.46%. The full-input ranges do not overlap, so this is a measured but small benefit. Slab medians are 148.66 s versus 147.79 s at two and four workers, with overlapping ranges. Node shows the same limited scaling beyond two workers. This recommendation balances the small GP gain against extra worker capacity; the measurements do not prove two workers always use less RSS.

Mean-b0 benefits substantially from four workers: Chromium full medians fall from 86.55 s at two workers to 54.19 s at four, and slab from 8.62 s to 5.50 s. Four workers are therefore a reasonable explicit throughput option for mean-b0 on a host comparable to this one. The chosen default stays at two for both methods, with explicit worker overrides retained; changing the method does not automatically change concurrency.

A separate untimed full-input GP profile with four workers completed 101 frames, 90 registrations/resamples, and 106 verified artifact hashes. The main isolate recorded 273,180 samples. Synchronous GP target generation accounted for 85.84% of weighted sample time, or 88.91% after excluding idle; gzip accounted for 4.05%. Each ANTs worker was 87.69–87.97% idle. `packages/hmc/src/nifreeze.js` supplies a lazy target factory, and `pool.js` calls it before dispatching registration inputs. The `nifreeze_predict` export in `exes/dwi/hmc-wasm/src/lib.rs` constructs the model, fits/predicts, and clips the target in one call. These samples support serial target generation as the main limiter. They do not distinguish model construction, fit, prediction, or clipping costs. Worker profiles use a different clock origin, so no cross-thread interval comparison or registration-versus-resampling cost split is claimed. V8 samples do not cover all native background threads. The instrumented run supplies no timing or speedup estimate.

### Whole-app memory and proposed input qualification

The estimator's linear-memory maximum is 1 GiB (`packages/hmc/scripts/build-wasm.sh`); each registration kernel starts at 256 MiB and can grow to 4 GiB (`packages/hmc-registration/CMakeLists.txt`). These capacities are not observed RSS or a whole-app memory ceiling. Host memory also holds input/working images, corrected Float32 data, compression buffers, transferred worker data, and viewer/results state. Teardown releases model allocations and terminates workers, but does not promise surviving WASM memories shrink or that RSS falls immediately.

Separate production-browser observations on the same 32 GB host included automatic mean-b0 MindGrab CPU masking, the viewer, processing and output display. They used the same full input, GP, seed 1234, and effective 161,668-voxel mask. All five cycles completed and verified 105 scientific files against the accepted supplied-mask reference, including decompressed corrected image, gradients, motion and 101 transforms. The transform ZIP was inventoried/extracted; its container bytes were not reference-compared. The sidecar was checked separately for automatic-mask provenance.

| Workers | State | Observed processing RSS peak, bytes | GiB |
| ---: | --- | ---: | ---: |
| 1 | Fresh page | 5,907,345,408 | 5.502 |
| 2 | Fresh page | 5,971,673,088 | 5.562 |
| 4 | Fresh page | 5,479,096,320 | 5.103 |
| 4 | Direct rerun, previous results retained | 5,781,221,376 | 5.384 |
| 4 | Input replacement, previous results retained | 6,548,115,456 | 6.098 |

These are one observation per state, not repeated timing trials or memory upper bounds. Summed Chromium process-tree RSS was sampled nominally every 100 ms from before navigation. Maximum gaps within processing were 145–396 ms; longer 4.8–5.1 s gaps occurred in verification pauses. The four-worker page paused 253.4 and 303.6 seconds for artifact verification between cycles, so the observations do not bound instantaneous back-to-back reruns. The largest peak occurred during replacement input masking/model startup, not the registration-status interval. Status timestamps do not identify the exact allocation responsible. Observer/reference-file memory was outside the browser process tree.

Propose an initial qualification limit tied to the measured full-input case: signed-int16 stored voxels, spatial grid no larger than `120 × 120 × 75` (1,080,000 voxels), at most 101 frames and 90 DWI frames, at most 161,668 effective GP mask voxels, and at most 436,320,000 decoded Float32 image bytes. The measured stored payload is 218,160,000 bytes; compressed size alone must not determine eligibility. The separately measured slab has 137 frames and 124 DWI frames at much smaller spatial size; it remains separately eligible as a tested example, rather than evidence that the full geometry supports those larger frame counts. Smaller inputs within this proposed qualification envelope still require boundary testing before a hard guard is justified. Broader masks, Float64 storage, other dimension/frame tradeoffs and multiple retained results remain unqualified.

This is a conservative proposal for review, not a proven safe capacity limit or a new enforced guard. A 16 GB target requires a separate constrained-memory run, including automatic masking, viewer and retained/replaced outputs; a sampled 6.10 GiB peak on a nominal 32 GB machine does not validate that target. Platform/browser differences and allocator transients also remain unmeasured. No new input guard or UI limit is implemented here.

### Reproduction and source qualification

`packages/hmc/validation/benchmark-matrix.mjs CACHE OUTDIR` runs the matrix; `--resume` validates and reuses complete receipts without rerunning them when source, input pins, machine and runtime identities match. `benchmark-receipts.mjs` rejects failed/incomplete trials. Keep a checkout of the measured revision for resume validation, since later source changes intentionally fail identity checks. The matrix runner verifies cross-host/worker artifact equality and computes the medians/ranges above. Review of all 120 saved receipts repeated those validations and recomputed all 24 summary rows exactly.

Local evidence is preserved under `$TMPDIR/hmc-matrix-final-20261024.mJruFz/` (120 receipts and `matrix.json`), `$TMPDIR/hmc-full-gp-cpu-profile-final/` (receipt and five CPU profiles), and `$TMPDIR/hmc-reviewed-memory-w{1,2,4}/` (whole-app receipts). These are local evidence paths, not public dataset URLs. Source-only summaries belong here; large raw evidence stays outside the repository.

At the post-measurement main merge `8b9f79a71`, comparison with the measured 72-file identity map found two changed files: `packages/components/src/file-io/bids-derivatives.js` and `pnpm-lock.yaml`. The former adds only two missing/empty-description guards; HMC passes fixed nonempty descriptions. Six direct old/new helper comparisons verified identical valid HMC names and serialized sidecars. The lock delta replaces DWI2TRX's GPU-streamlines registry package with its vendored package; it does not change HMC's runtime dependency. Both HMC kernels and all other files in the measured map remained identical at that merge. The subsequent user-facing default change also modifies the measured `packages/hmc/src/node-files.js` default argument, alongside the app/automation/CLI defaults. It does not alter the explicitly configured worker counts used by this matrix. Later release manifest/version and lock metadata can also differ. These qualifications preserve the measurements' original source identity; they do not claim every current source hash is unchanged. Performance results do not establish scientific accuracy.

The subsequent SDC entry-point addition in `3226bb75b` changes the registration WASM to `53779fcd0064a8394aa42ca2e82c5f8b33cf4aebbe98e3a43af6212e558ccf86` (15,382,571 bytes). It adds Laplacian and the native `antsApplyTransforms` CLI; the existing HMC registration and legacy apply paths pass their native-output regressions unchanged. The 120 timing trials and whole-app memory observations above were not rerun against this expanded binary. They remain measurements of the explicitly identified older kernel, not new performance or memory bounds for the expanded one.

## 7. Milestones

1. M0: reference runs, kept intermediates and masks, pinned on Hugging Face. Status: NiFreeze runs done; QSIPrep r1 and the repeats e1-e3 done; `hmc/reference/` is uploaded at dataset revision `a4ba04733c316430add7e9f8467887a1a47b6e65` and pinned by `exes/dwi/hmc/validation/reference.manifest.json` ([#409](https://github.com/neurodesk/webapps/issues/409), [#438](https://github.com/neurodesk/webapps/issues/438); section 9).
2. M1: `hmc` motion decomposition, bvec rotation and TSV, tested with the reference `.mat` files.
3. M2: `hmc-registration` with generic argv, `--float 1` only (no 3DDouble, Q53). Replay the reference inputs and apply the native-float, world-centre gate in section 5. Retain the historical double and QSIPrep-pivot comparisons. The shell-maximum alternatives and the SHORELine gate in section 5 await an issue-owner decision. Status ([#446](https://github.com/neurodesk/webapps/issues/446)): the replay equals native float on 98 of 101 runs. Against the historical native-double target, Q53's per-cell rule rejects 40 of 90 GP volumes (58 cells) about the world centre and 48 (77 cells) by QSIPrep's formula, and 10 and 7 of the 11 b0 pairs; under the shell-maximum alternative every volume passes (`exes/dwi/hmc/validation/q53-replay.json`).
4. M3: NiFreeze `trivial` end to end, Node CLI, benchmark.
5. M4: `shore`, b0 template and SHORELine iterations.
6. M5: `gp`.
7. M6: SHORELine tensor option, then the app UI, example and e2e tests.

## 8. Questions and decisions

1. Which NiFreeze model is the app default: `trivial` (the CLI default) or GP (main only, not released)?
   **Decided (Q50):** GP is the app default. `trivial` is an option. M0 supports this: on ds005577 the trivial model fails on b3000 (section 9).
2. Do we pin NiFreeze main 3bcfb00, or wait for a release with GP?
   **Decided (Q50):** pin NiFreeze `main` 3bcfb00.
3. Do we keep the b0 volumes in the output? NiFreeze drops them.
   **Decided (Q51):** keep the b0 volumes in the outputs.
4. What is the browser mask source? SynthStrip is not ported.
   **Decided (Q52):** MindGrab (model `mindgrab`) of the mean b0 by default; the user can upload a mask. The reference runs use a MindGrab mask made with `@neurodesk/node-drivers/mindgrab`, so the port can use the same mask. QSIPrep cannot take it; it uses its own SynthStrip mask.
5. Can NiFreeze use `--float 1` if a measurement shows it within the gate? Then 3DDouble is not necessary.
   **First step (Q53):** measure `--float 1` against double before anyone builds 3DDouble. Measured (section 9): within the fixed gate on b0→b0, not within it for GP (7/90 volumes), but smaller than NiFreeze's own seed noise.
   **Updated decision (Q53, 2026-10-24, #451):** compare WASM `--float 1` with native `--float 1`, using the existing per-volume, per-axis native-double seed spread and the world-centre convention in section 5. The double comparison remains in the report to quantify the cost of float precision, alongside image-quality QC for both native precisions. Do not substitute shell maxima or build 3DDouble. Deterministic motion decomposition, bvec rotation, SHORE and GP prediction tolerances stay unchanged.
6. Is a QSIPrep run on the slab acceptable, and which flag skips the anatomical input?
   **Decided (Q54):** QSIPrep 26.1.1 SHORELine on ds005577 (whole brain, not the slab), three repeats. The flag is `--anat-modality none` (section 5).
   **Decision pending:** the spread of the three repeats is above the fixed gate for b3000 (1/101 volumes at the world centre with the `decompose44` rotation, 32/101 by QSIPrep's formula; section 9). Section 5 proposes a shell-maximum rule from e1-e3 with QSIPrep's `decompose44` rotation and the world-centre translation. The spread includes the per-run seed and the per-run SynthStrip mask. The proposal needs the maintainer confirmation required by #408. The deterministic parts keep their fixed tolerances.
7. Must the port copy the in-place clip quirk on float data, or only run the integer path?
   **Decided (Q55):** copy the quirk, and record whether the input is float or integer. ds005577 is int16 (no scaling), so the DWI data is not clipped in place. But the trivial model's target (`bzero`) is float64, so the quirk is active there (section 3).

## 9. M0 results

Measured 18-19 October 2026. Data: Hugging Face dataset `neurodeskorg/webapps`, path `hmc/reference/`, revision `a4ba04733c316430add7e9f8467887a1a47b6e65` (uploaded 21 October 2026, [#409](https://github.com/neurodesk/webapps/issues/409); 3513 files with NiFreeze, QSIPrep r1 and e1-e3; a fresh download passes `sha256sum -c SHA256SUMS`). Tests fetch subsets of it with `exes/dwi/hmc/validation/fetch_reference.py`. Its README gives the commands, versions, patches and the purpose of each file. Add the files that M1-M5 tests read to a subset of that manifest.

### Input and environment

- OpenNeuro ds005577 v1.0.0 sub-107 AP DWI, CC0 (read from `dataset_description.json`). The NIfTI, bval and bvec are copied unchanged; NIfTI SHA-256 `06d5a733005a9e463f1ca6b581d0a8725378b60967c23dd63d49cc04362e83b9`. The JSON sidecar copy omits six site and time fields (AcquisitionTime, DeviceSerialNumber, InstitutionAddress, InstitutionName, InstitutionalDepartmentName, StationName), as `noddi/examples/` does. QSIPrep copies these fields into its output sidecar (`qsiprep-*/out/*_desc-preproc_dwi.json`, at the top level and in `SourceMetadata`); the four packed copies omit them too. All other bytes are unchanged; the README and `index.json` give the original SHA-256 of each edited sidecar. The runs read the original sidecar; none of the six fields affects HMC. The NIfTI header `descrip` of the input (and of the mean b0, which copies its header) keeps the acquisition time (`Time=` item): the input is the public CC0 original, copied unchanged.
- Licences of the folder (the README puts each file in exactly one row): input data CC0; MindGrab mask MIT (the licence of MindGrab); QSIPrep outputs BSD-3-Clause; NiFreeze and ANTs outputs Apache-2.0; NiFreeze patch Apache-2.0; scikit-learn patch BSD-3-Clause; the scripts and the files that they wrote (analysis tables, facts files, mean b0, motion TSVs, README) Apache-2.0, as `exes/dwi` (the repository has no single licence, `LICENSES.md`).
- 120 × 120 × 75 × 101, 2 mm, int16. `scl_slope` and `scl_inter` are NaN, so there is no scaling.
- 11 b0 volumes (0, 10, …, 100) under both b0 rules, 30 × b1000 and 60 × b3000. The shells alternate in time, one volume every 3.2 s.
- NiFreeze 3bcfb00, Python 3.12.13, nipype 1.12.0, nitransforms 25.1.0, numpy 2.3.5, scipy 1.18.1, scikit-learn 1.9.1.
- Native ANTs 2.6.2 at 52bc0ab (the commit of the WASM build): CMake `-G Ninja`, Release, static.
- QSIPrep 26.1.1 container, digest `sha256:b7d91d9755fd97647632a1f900238425239cd834c97e9866b20af39e224d383a`. Apptainer SIF SHA-256: local host (r1) `b9064a6d727aff499ce1c2c1b5a309c0d0074be29921732332cd6d0b0d125506`, host epic (e1-e3) `c26848b25c3d8223dfbf68ed305f20becec12180435cefbdb257cad1c18fd1bd`. Both report QSIPrep 26.1.1 and ANTs 2.6.0.dev1-gb775a15.
- Hosts: NiFreeze and QSIPrep r1 on the local Linux x86-64 host; QSIPrep e1, e2 and e3 on the Linux host epic, at the same time.
- One thread for each computation. QSIPrep r1 used `--nthreads 1`; e1-e3 used `--nthreads 10` (parallel nipype nodes, each on one thread).
- Two patches:
  - NiFreeze: keep the work directory, and an optional `--float 1` switch. It does not change results.
  - scikit-learn GP gradient: it sums over the targets first. Gradient change at most 3.3e-15 relative. Without it the GP needs about 11.5 GB.

### Mask

- MindGrab `mindgrab` model, of the mean of the 11 raw b0 volumes, with `@brainchop/mindgrab` 0.1.20260925 through `loadMindgrabCpu`.
- 161679 voxels (1293 mL), bounding box 126 × 168 × 136 mm. It does not touch the grid edge, and it has the DWI grid and affine.
- The GP runs used 161668 voxels: NiFreeze removes the voxels where the b0 median is 0 (section 3).
- QSIPrep's own SynthStrip mask (r1): Dice 0.947 against the MindGrab mask. Each QSIPrep run makes its own mask: e1, e2 and e3 differ from r1 in 30, 30 and 25 voxels (Dice 0.9999).

### Determinism

- NiFreeze trivial run twice with `--seed 1234`: transforms, visit order and motion are equal bit for bit.
- 4 kept `cmd-*.sh` files, run again with `ANTS_RANDOM_SEED=1234`, gave the same `.mat` byte for byte.
- GP fit and prediction are deterministic and do not depend on the visit order: the 90 `predicted_*` files are byte-identical in gp, gp-float and gp-seed1235 (two seeds, so two visit orders, and two precisions).
- Only a same-seed repeat of the GP registrations is not tested.
- In all six NiFreeze runs, the samples (moving images) are byte-identical and equal to the raw volumes.
- The trivial prediction is the same file for all 90 volumes. The in-place clip of `bzero` happens, but the second clip changes nothing on this input (35th percentile 0, 99.98th 255).

### Registration quality (median correlation with the mean of the raw shell, before → after)

| Model | b1000 r | b3000 r | Median mask displacement | Comment |
| --- | --- | --- | --- | --- |
| trivial | 0.895 → 0.807 | 0.627 → 0.363 | 1.5 mm (b1000), 7.4 mm (b3000), maximum 42 mm | fails: every volume gets worse |
| GP | 0.895 → 0.910 | 0.627 → 0.674 | 0.34 mm (b1000), 0.42 mm (b3000) | no volume gets worse; maximum 1.84 mm, 0.71° |

- The trivial target is the b0 map, and a b3000 volume does not correlate with it (r ≈ 0.00).
- The "motion" of the trivial run follows the b-value, not the time, so it is not subject motion.
- The b0→b0 registrations move only 0.0-0.3 mm and up to 0.35°.
- GP: in all 90 fits `beta_a` stopped at its lower bound 0.1 and `beta_l` at 0.001. The evidence: the GP log has 180 scikit-learn `ConvergenceWarning`s "close to the specified lower bound" (one for each parameter and fit), and the dry-run fit gives exactly a = 0.1 and λ = 0.001 (to float rounding). The kernel is `SphericalKriging(a=0.1, λ=0.001) + WhiteKernel(0.999)`. The prediction is almost the voxel mean of the other 89 volumes of both shells (r = 0.993). M5 must copy the bounds, L-BFGS-B and `normalize_y` to match it.

### Q53: `--float 1` against double (fixed gate 0.2 mm / 0.2° per axis)

| Comparison | Over gate, world centre | Over gate, QSIPrep formula | Max \|Δt\| | Max \|Δrot\| |
| --- | --- | --- | --- | --- |
| trivial, float vs double | 55/90 | 66/90 | 42 mm | 6.1° |
| b0→b0, 11 pairs, float vs double | 0/11 | 0/11 | 0.018 mm (QSIPrep 0.178) | 0.052° |
| b0→b0, double, seed 1234 vs 1235 | 0/11 | 4/11 | 0.109 mm (QSIPrep 0.337) | 0.127° |
| GP, float vs double | 7/90 | 30/90 | 0.29 mm (QSIPrep 1.08) | 0.35° |
| GP, double, seed 1234 vs 1235 | 68/90 | 85/90 | 0.71 mm (mask displacement up to 1.7 mm) | 0.79° |

- **Trivial:** double itself fails here, so this row does not measure precision.
- **b0→b0:** on a well-posed registration, float is within the gate, and its error is smaller than the error of a different seed.
- **GP (the app default):** float is not within the gate.
- **Seed noise:** a change of seed in double moves the GP result more than float does, by more than the gate and by about as much as the GP motion itself (0.3-0.7 mm median). The cause is NiFreeze's Random sampling and the fixed iteration limits, which make the result depend on the path.
- **Decision (2026-10-19):** no 3DDouble. The WASM registration is held to the seed spread of native double, not to the fixed gate (section 5 states the rule; section 8, question 5).

Proposed shell-maximum limits `L[s, k]` (largest |gp(1234) - gp(1235)| in the shell) and the largest |gp-float - gp| (`compare/q53-seed-rule.json`):

| Shell | trans x / y / z (mm), world centre | rot x / y / z (°) | trans x / y / z (mm), QSIPrep formula |
| --- | --- | --- | --- |
| b1000 limit | 0.117 / 0.248 / 0.219 | 0.291 / 0.228 / 0.195 | 0.254 / 0.459 / 0.670 |
| b3000 limit | 0.426 / 0.709 / 0.402 | 0.550 / 0.591 / 0.788 | 2.596 / 1.747 / 1.718 |
| float, all 90 volumes, largest | 0.151 / 0.289 / 0.175 | 0.347 / 0.312 / 0.162 | 0.648 / 0.763 / 1.079 |

- Native `--float 1` passes the proposed shell-maximum alternative on 90/90 volumes in both conventions. Its largest ratio to the proposed limit is 0.72. This does not satisfy Q53's required per-volume, per-axis rule.
- Median |Δ|: float 0.01-0.03 mm and 0.02-0.03°; seed 0.08-0.13 mm and 0.12-0.15° (world centre).
- Q53's required per-volume, per-axis rule fails float on 40/90 volumes (58/540 cells). Section 5 records the shell-maximum alternative as an unaccepted proposal. This is the historical double-comparison result; the accepted 2026-10-24 native-float gate is specified in section 5.

### QSIPrep SHORELine

| Run | Host | `--nthreads` | Seeds (master / ants / numpy) | Wall time | cgroup peak |
| --- | --- | --- | --- | --- | --- |
| r1 | local | 1 | 53847 / 57526 / 18755 | 17954 s | 7.54 GB |
| e1 | epic | 10 | 124 / 36413 / 752 | 3551 s | 18.11 GB |
| e2 | epic | 10 | 21516 / 20495 / 16163 | 3761 s | 18.03 GB |
| e3 | epic | 10 | 23156 / 45524 / 14593 | 3785 s | 18.08 GB |

- QSIPrep has no seed option. The ants seed reaches antsRegistration through `ANTS_RANDOM_SEED` (nipype `report.rst` of e1: 36413). Thus the repeats differ by seed, and no same-seed repeat exists.
- In every run the final `.mat` files decompose to QSIPrep's `motion_params_*.csv` with a largest difference of 1.5e-14 mm and 1e-16 rad.
- DWI motion (world centre): maximum |t| 0.55-0.60 mm, median |t| about 0.12 / 0.25 / 0.09 mm (x / y / z), maximum rotation 0.86-0.90°, |scale − 1| ≤ 0.026, |shear| ≤ 0.013.
- The conformed volumes (`split_dwis`) of the four runs have equal voxel data and equal NIfTI header blocks. In the AFNI extension only the random `IDCODE_STRING` and its `IDCODE_DATE` differ, so the files are not byte-identical.
- The folder names `NNN` under `collected/` are not volume numbers. In `b0/iterative_alignment_001/` they are `010`-`019` and `110`, from the nipype names `_reg_0010` … `_reg_00110`, not the b0 index. Take the volume from the moving image in `command.txt` (the README gives the map).

**Repeat spread, e1-e3** (for each volume, the largest difference over the 3 pairs, for each axis):

| Group | Max \|Δt\|, world centre (mm, x / y / z) | Max \|Δt\|, QSIPrep formula (mm) | Max \|Δrot\|, `decompose44` (°) | Max mask displacement, MindGrab mask (mm) | Over fixed gate, world centre | Over fixed gate, QSIPrep formula |
| --- | --- | --- | --- | --- | --- | --- |
| b0 (11) | 0.007 / 0.018 / 0.022 | 0.037 / 0.040 / 0.089 | 0.037 / 0.030 / 0.015 | 0.075 | 0 | 0 |
| b1000 (30) | 0.026 / 0.031 / 0.029 | 0.170 / 0.152 / 0.188 | 0.051 / 0.043 / 0.061 | 0.128 | 0 | 0 |
| b3000 (60) | 0.046 / 0.055 / 0.141 | 0.350 / 0.637 / 0.461 | 0.208 / 0.096 / 0.183 | 0.484 | 1 | 32 |

- The spread is above the fixed gate for b3000: volume 53 at the world centre (Δrot x 0.208°), and 32 volumes by QSIPrep's formula, because of the 184-188 mm lever arm (section 4). b0 and b1000 are within the gate in both conventions. M0 reports it. The shell-maximum alternative awaits a maintainer decision (section 5; section 8, question 6).
- The rotation columns use `decompose44`. The affine's polar factor gives 0/101 volumes over 0.2° (b3000 maximum 0.073 / 0.081 / 0.094°). The convention-free mask displacement is 0.48-0.50 mm for b3000 (e1 SynthStrip mask: 0.497 mm, 0.500 mm with r1), above 0.2 mm in every convention (section 5).
- The spread includes the seed, and also the per-run b0 template and SynthStrip mask.
- With r1 added (a different host, `--nthreads 1`): 1/101 over the gate at the world centre and 39/101 by QSIPrep's formula. The maximum values change very little (world-centre b3000 x 0.046 → 0.083 mm, mask displacement 0.484 → 0.488 mm). But for each volume and axis, r1 is not always within the e1-e3 limits: against e1, e2 and e3, 4, 10 and 9 of 101 volumes are over a limit at the world centre (largest ratio 1.38, 1.48 and 1.80); 4, 8 and 3 by QSIPrep's formula (1.39, 1.58 and 1.54).
- GP against QSIPrep (e1-e3 and r1 give almost the same numbers), median offset removed: correlation 0.46-0.67 (translation) and 0.29-0.70 (rotation), median |Δt| 0.03-0.09 mm (b1000) and 0.09-0.15 mm (b3000), maximum 0.66 mm. This is for information only: the methods differ (Rigid against Affine). Trivial against QSIPrep: correlation ≤ 0.35, b3000 residual up to 43 mm.
- QSIPrep cannot use the MindGrab mask (Q52); it gives the registrations float32 volumes, where NiFreeze gives int16 (Q55).
