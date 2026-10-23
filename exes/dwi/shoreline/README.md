# dwi-shoreline

Head motion, eddy-current, susceptibility and slice outlier correction of a diffusion series, in one estimation and one resampling.
It does what FSL eddy does with `--flm=quadratic --slm=linear --repol --resamp=jac` and a topup field.
It predicts the diffusion-weighted volumes with SHORELine's 3dSHORE model when there are enough of them (72 or more), and otherwise with a Gaussian process, as eddy does.

The method follows Andersson and Sotiropoulos 2016 (NeuroImage 125:1063-1078), Andersson et al. 2016 (NeuroImage 141:556-572) and, for the Gaussian process, Andersson and Sotiropoulos 2015 (NeuroImage 122:166-176).
It is a clean-room implementation from those papers and from eddy's documented options and outputs; no FSL code was read, and nothing from FSL is linked or shipped.
FSL is used only as a reference tool in `tools/eddy_benchmark.py`.
The 3dSHORE prediction is QSIPrep 26.1.1's (`dwi-shore`), the topup coefficient reader is `dwi-pe-field`, and the slice statistics are `dwi-slice-outliers`.

## Command line

```bash
shoreline --imain=dwi.nii.gz --mask=brain_mask.nii.gz --acqp=acqparams.txt --index=index.txt \
  --bvecs=dwi.bvec --bvals=dwi.bval --topup=topup_base --out=corrected \
  --niter=5 --fwhm=2 --flm=quadratic --slm=linear --repol --nthr=8
```

The options mean what eddy's options of the same name mean: `--topup` reads `<base>_fieldcoef.nii.gz`, `--field` takes a field map in Hz instead, on the series' grid or on its own grid placed by `--field_mat` (eddy's: a FLIRT matrix from the field's FSL coordinates to the series'; without it the two share them), as a dual-echo field map from the scanner would be, and `--acqp`/`--index` give each volume's phase encoding and total readout time.
The reference (model space) is the first b0 volume: volume 0, as eddy's default `--ref_scan_no=0`, when the series starts with a b0 volume.

Other options (an option this tool does not know is refused, so that an eddy command line never runs with one silently dropped; eddy's options that change nothing here, such as `--data_is_shelled`, `--verbose` or extra outputs, are logged and ignored; `--b0_only`, `--fep`, `--rep_noise` and a `--ref_scan_no` other than 0 are refused):

- eddy's: `--flm=linear|movement`, `--slm=quadratic|none`, `--ol_nstd`, `--ol_nvox`, `--ol_pos`, `--ol_sqr`, `--ol_type=sw|gw|both` with the multiband groups from `--mb`, `--slspec` or `--json`, `--dont_mask_output`, `--dont_sep_offs_move`, `--dont_peas`, `--interp=trilinear` (estimation), `--ff` (Gaussian process; default below), `--resamp=jac|lsr` and `--lsr_lambda` (0.01), `--mporder` with `--slspec` or `--json` (`SliceTiming`), `--s2v_niter` (5), `--s2v_lambda` (1), `--s2v_fwhm` (0), `--estimate_move_by_susceptibility` with `--mbs_niter` (10), `--mbs_lambda` (100 here; the scale differs from eddy's) and `--mbs_ksp` (10 mm).
- `--robust` (Huber weighting), `--dont_initial_repol`, `--dont_coarse_repol`.
- `--model=auto|shore|gp`: the prediction (`auto`: 3dSHORE with 72 or more diffusion-weighted volumes, else the Gaussian process).
- `--coarse_fwhm=8,4|none`: smoothing of the coarse iterations before `--niter` (below).
- `--linear_iterations=1`, `--gn_steps=2`, `--gn_tol=0.05`, `--slm_power=1` (the second-level model is linear in g · (b/b_max)^power: 1 as eddy's; eddy currents scale with the gradient's amplitude, which is √b when the timing is fixed, so 0.5 may suit designs that reach b by amplitude over a wide range, such as DSI), `--ol_standardise=shell`, `--dont_anchor_shells`, `--dont_detrend_offset`, `--global_b0`, `--rotate_gradients`, `--first_ec_only`, `--self_weight` and `--self_weight_from=2` (see below).

Outputs: `<out>.nii.gz` (float32, on the input grid), `<out>.rotated_bvecs`, `<out>.parameters` (per volume: translations in mm and rotations in radians about the grid centre along the voxel axes, then the eddy-current coefficients in Hz), `<out>.movement_rms` (RMS displacement over the mask relative to the reference and to the previous volume, as eddy's), `<out>.outlier_map`, `<out>.outlier_n_stdev_map`, `<out>.outlier_n_sqr_stdev_map`, `<out>.outlier_report` (the files laid out as eddy's, header lines included, so that tools reading eddy's files read them) and `<out>.log`.

## Acquisitions

What eddy corrects, this does too:

- any number of diffusion-weighted volumes, on one shell or several (3dSHORE from 72, the Gaussian process below), or without shells: diffusion spectrum imaging grids and b-values spread over a range;
- gradients over the whole sphere or a half sphere;
- phase encoding along any voxel axis, with either polarity, or both in one series (per-volume `--index`);
- one b0 volume or many, interleaved or not; a series that starts with a diffusion-weighted volume;
- with a topup field, a field in Hz, or none (readout time 0 for a volume without distortion);
- pairs acquired with opposite polarities, restored together (`--resamp=lsr`; one output volume per pair, with `<out>.bvals`);
- movement within volumes (slice-to-volume, `--mporder`), with any slice order and multiband grouping given as `--slspec` or `SliceTiming`;
- a susceptibility field that changes with pitch and roll (`--estimate_move_by_susceptibility`);
- NIfTI-1 and NIfTI-2 (written back as NIfTI-1), gzipped or not, little or big endian, any voxel type; anisotropic voxels;
- large series: an HCP-sized one (186 × 186 × 131 voxels of 1.25 mm, 254 volumes) takes 4 minutes with 8 threads (25 with 1) and 11.7 GB of memory.

As in eddy, slice-to-volume correction, least-squares resampling and movement-by-susceptibility are off unless asked for.

## Method

The forward model of volume i: a point m of the reference space came from the point q = M_i⁻¹(m) of the volume's own frame (M_i rigid), and was acquired at x = q + d_i(q) along the phase-encoding axis, with d_i = sign · readout time · (field(m) + ec_i(q)) voxels.
The susceptibility field moves with the head; the eddy-current field ec_i is a polynomial (linear or quadratic) in the scanner frame.
The corrected image is C_i(m) = J_i(q) · y_i(x), with J_i = 1 + ∂d_i/∂PE.

1. Start: each b0 volume is registered to the first, coarse to fine (smoothing FWHM 8, 4 and 2 mm); each diffusion-weighted volume starts between the b0 volumes around it (interpolated in acquisition order).
2. Two coarse iterations (FWHM 8 and 4 mm, linear eddy-current model, trilinear interpolation), then the `--niter` iterations with the requested settings. Each iteration:
   - Correct every volume, after smoothing.
   - Predict every volume from the others: the mean of the other b0 volumes; the 3dSHORE leave-out prediction from the diffusion-weighted volumes and the b0 volumes around it; or the Gaussian process (below).
   - Take Gauss-Newton (Levenberg-Marquardt) steps on the squared difference between the corrected volume and its prediction over the mask, for the 6 rigid parameters and the eddy-current coefficients together, with analytic derivatives: up to `--gn_steps`, stopping once a step moves the volume less than `--gn_tol` mm (translation, plus rotation at a radius of 50 mm, plus the eddy-current displacement). The estimation interpolates with a cubic B-spline, as eddy's; the coarse iterations' smoothing makes trilinear interpolation equivalent there, and cheaper.
   - Replace the eddy-current coefficients by the second-level model, separate the field offset from movement, and hold each shell to the b0 trajectory (below).
   - Refer every volume to the reference.
   - With `--repol`, find and replace the outlier slices, from leave-out predictions taken into each volume's own space: along each phase-encoding line the displacement is evaluated at every voxel and inverted between voxels, where it is linear.
3. Align each shell's mean to the b0 mean by Mattes mutual information (eddy's post-eddy alignment of shells; `--dont_peas` skips it).
4. Resample every volume once from the data with the outlier slices replaced: cubic B-spline, Jacobian modulation (eddy's `--resamp=jac`). Voxels that some volume does not cover are set to 0, as eddy's default; the field of view extends half a voxel past the edge voxels.

### Details

- **Coarse iterations.** On one scanner (Siemens Cima.X) the field offsets reach 50 Hz, a shift of 3 voxels; from a start at 2 mm smoothing, Gauss-Newton traded the offset against the translation and the y² term and lost several volumes (correlation with eddy 0.925). With the coarse iterations: 0.988. eddy's documentation suggests a decreasing `--fwhm` for the same reason.
- **Second-level model.** eddy's eddy-current parameters are exactly linear in the gradient vector scaled by the b-value, g · b (all 10 quadratic-model columns of `eddy_parameters` have R² = 1.000 against g · b, and 0.976 against g · √b). The second-level model uses g · b / b_max, without a constant term.
- **Field offset and movement (`--sep_offs_move`).** Within one volume, a constant field offset and a translation along the phase-encoding axis are nearly interchangeable. The offset's second-level model is fitted to their sum, the total PE shift, which the data determine, after the head's own PE position (interpolated from the b0 volumes) is taken out; what the model does not explain is movement. On the phantom, taking the head position out halves the eddy-current error (0.15 to 0.06 voxel).
- **Shells.** The diffusion-weighted volumes are registered to predictions made from each other, so a movement they share moves the predictions with them. After each iteration each shell's mean deviation from the b0 trajectory is removed, and at the end the shell means are aligned to the b0 mean. Shells with fewer than 20 volumes are treated as one group for both: holding a few volumes to the trajectory removes their own movement, and the mean of a few volumes aligns poorly (b-values spread over a range: 0.036 to 0.030 on the phantom). With the b-values 100 apart (eddy's shell rule), ADNI's protocols have one small shell, which stays a group of its own.
- **Data without shells.** With more than 6 distinct b-values (DSI, spread b-values; eddy's `--data_is_shelled` distinction), 3dSHORE's leave-out predictions extrapolate across b with large, cancelling weights (their absolute sum reaches 5.5 at low b on a DSI grid) and the registration follows their error: the low b-values of the DSI phantom were 5 times further from the truth than eddy's. From the third iteration, each volume's prediction then includes 30 % of its own image (`--self_weight`, `--self_weight_from`), which damps the registration: 0.083 to 0.035. On shelled data the same damping held back large movements (the ADNI session with 9 mm of movement lost consistency), so it is off there.
- **Gaussian process.** Each voxel's signal minus its shell mean is a Gaussian process over the gradients, with a spherical covariance in the angle between directions (antipodally symmetric) times a squared exponential in ln b, plus noise. The hyperparameters are chosen every iteration by leave-one-out cross-validation on 1500 mask voxels (eddy's default `--hpcf=CV`), and the noise is then multiplied by `--ff`. The registration's prediction includes the volume itself (the posterior mean at a noisy sample, eddy's design as its documentation describes `--ff`): that damps the registration, which otherwise follows the prediction's error with few directions (rotation errors of 2-3 degrees on a 15-direction phantom without any motion). The first iteration leaves the volume out and fits only the eddy currents of the diffusion-weighted volumes, so that large field offsets are corrected while their motion stays between the b0 volumes. Outlier slices are always found and replaced with leave-out predictions. `--ff=3` (eddy's default is 10) was chosen on the phantoms below.
- **Outliers.** eddy's slice statistic (mean of observed minus predicted, in the volume's own space, negative deviations beyond `--ol_nstd` standard deviations, slices with at least `--ol_nvox` mask voxels). It is standardised per shell and slice position with the median and 1.4826 · MAD (`dwi-slice-outliers`); a shell with fewer than 10 volumes keeps the median per position and pools the spread. A mean and standard deviation would let the outliers of a session with much motion hide each other.
- **Least-squares restoration (`--resamp=lsr`).** For each pair with the same diffusion encoding and opposite polarities, each volume is resampled for motion only, and each line along the phase-encoding axis is restored as a cubic B-spline: acquired sample i of a volume came from the position p with p + d(p) = i and holds f(p)/J(p); both volumes' samples determine the coefficients by least squares with a first-difference penalty (Andersson, Skare and Ashburner 2003). A linear "push" discretisation was tried first and amplified noise.
- **Slice-to-volume (`--mporder`).** Each volume's 6 rigid parameters vary with the slice's acquisition time τ as cos(π k τ), k = 1..mporder, estimated in `--s2v_niter` further iterations with the cosine coefficients' Gauss-Newton rows (the rigid rows times cos(π k τ) of each voxel's slice) and a k²-weighted penalty (`--s2v_lambda`). A voxel takes the transform of the slice it was acquired in (found by two fixed-point steps). Resampling slice by slice (each slice's own transform, interpolated across slices) was tried and was worse than resampling with each voxel's slice transform.
- **Movement-by-susceptibility.** Two cubic B-spline fields (knots every `--mbs_ksp` mm) give the field's change per radian about x and y; after the motion iterations, with the motion fixed, Gauss-Newton updates from the residuals (linearised around each prediction group's mean rotation, as the predictions carry the same change), solved by matrix-free conjugate gradients with a Laplacian penalty, each shortened until the total residual decreases. Estimating it during the motion iterations, or alternating with more motion iterations, made the result worse: the rotations chase the field, and extra motion iterations follow the prediction's error.
- **Outliers from the start.** Outlier slices are found and replaced once before the first iteration and in the coarse iterations too (`--dont_initial_repol`, `--dont_coarse_repol`): with few volumes, every prediction is made from volumes with dropped slices, and a dark slice in the predictions misleads the first registrations (6 directions: 0.168 without, 0.082 with). Robust (Huber) weighting of the registration's residuals (`--robust`) was tried for the same reason and was worse with movement within volumes; it stays an option.
- **Where the defaults come from.** Chosen on the ground-truth phantoms: two Gauss-Newton steps per iteration (12 directions: 0.065 against 0.081 with three; equal on the others; on ADNI equal consistency, and faster), the coarse iterations' smoothing, `--ff` (30: best or near best on all six schemes with 6 to 30 directions), the outlier passes before and during the coarse iterations, `--lsr_lambda`, `--s2v_lambda`, `--mbs_lambda`, the Gaussian process's first iteration and the choice of 3dSHORE from 72 volumes. Chosen on ADNI (one site's protocol family, so not general evidence): the outlier statistic's standardisation per slice position, and keeping eddy's post-eddy shell alignment on. The coarse iterations were prompted by ADNI sessions with large field offsets.
- **Options tried and left off by default.** Rotating the gradients by the estimated head rotation for the predictions (eddy's `--rbvde`, `--rotate_gradients`): no effect on ADNI, slightly worse on the phantoms. Damping 3dSHORE with the volume's own image on shelled data (`--self_weight`): better on the phantoms, worse on ADNI sessions with much motion, also when it starts only at the third iteration. Fitting only eddy currents in the first iteration with 3dSHORE (`--first_ec_only`): mixed. The b0 mean of the session instead of the b0 volumes around each volume (`--global_b0`): no measurable difference.

## Accuracy against ground truth, and against FSL eddy

`tools/eddy_benchmark.py` runs this tool and FSL eddy 6.0.7.7 (with the same settings) on the phantoms of `tests/synthetic.rs`, where the true images are known: a diffusion phantom (FA about 0.45, orientation turning in space) moved by a drift and jitter (up to 2 mm and 2.5 degrees), distorted by a susceptibility field (up to 40 Hz, readout 50 ms) and eddy currents (offsets of a few Hz, as ADNI's), with four dropped slices, each acquired voxel computed exactly from the forward model.
Relative RMS difference from the truth over the brain, diffusion-weighted volumes (lower is better):

| Phantom | Uncorrected | FSL eddy | dwi-shoreline |
| --- | --- | --- | --- |
| 96 directions, 2 shells | 0.141 | 0.043 | **0.029** |
| the same, three times the motion | 0.253 | 0.107 | **0.050** |
| the same, with movement within volumes (both tools `--mporder=4`, interleaved `--slspec`) | 0.154 | 0.097 | **0.058** |
| the same, multiband 3, each dropout taking out its whole group (both tools also `--ol_type=gw`) | 0.157 | 0.090 | **0.053** |
| phase encoding along x, alternating polarity | 0.151 | 0.073 | **0.042** |
| 96 directions on a half sphere | 0.139 | 0.045 | **0.042** |
| 30 directions, 1 shell | 0.146 | 0.039 | **0.024** |
| 20 directions, 1 shell | 0.157 | 0.048 | **0.029** |
| 15 directions, starting with a diffusion-weighted volume | 0.162 | 0.032 | **0.028** |
| 12 directions, b = 2000 | 0.169 | 0.100 | **0.065** |
| 10 directions | 0.179 | 0.041 | **0.039** |
| 6 directions | 0.198 | 0.146 | **0.079** |
| DSI grid (q-space radius 3, 122 encodings on 9 b-values to 3000) | 0.133 | 0.045 | **0.035** |
| 100 volumes, each with its own b-value (300-3000) | 0.135 | 0.128 | **0.029** |

The phantoms with fewer than 72 diffusion-weighted volumes use the Gaussian process. eddy's error varies a little between runs of the same input (6 directions: 0.133 and 0.146). The benchmark passes `--data_is_shelled` to eddy for every phantom, the two without shells included. Every phantom has four dropped slices; with few volumes they are in most of them.
Each volume's gradient is turned with the head (a rotated head sees a rotated gradient), and the truth shows that direction.
Both tools find the four dropped slices in every phantom (in the multiband one, the four dropped groups of 3 slices, and nothing else); eddy adds one false one in the two small ones, this tool two in the standard one.

## Agreement with FSL eddy on ADNI (local data, aggregate only)

Two local ADNI3/4 sets processed with FSL eddy 6.0.7.7 (`--flm=quadratic --slm=linear --repol --niter=5 --fwhm=2 --ff=5 --resamp=jac --sep_offs_move`): one with reverse-PE topup, one with Synb0-DisCo. The comparison runs on the same input (`*_pad`), the same mask and the same topup coefficients, and is voxel by voxel on the input grid. Nothing from ADNI is in this repository.

30 sessions: the 8 per set used during development (the one with the most eddy outliers and random ones), and the 14 sessions with fewer than 72 diffusion-weighted volumes (6 to 66; predicted by the Gaussian process). Medians over sessions (range); for scale, the uncorrected series correlate about 0.76 with eddy's output. "Consistency" is reference-free (each diffusion-weighted volume's correlation with its shell's mean, each b0 volume's with the b0 median, over the mask; higher is better aligned), computed the same way for both outputs.

| | 127 volumes (3dSHORE), 16 sessions | 6-66 diffusion-weighted volumes (Gaussian process), 14 sessions |
| --- | --- | --- |
| Correlation with eddy's corrected volume (median over volumes) | 0.994 (0.954-0.998) | 0.980 (0.965-0.997) |
| White-matter FA, median absolute difference from eddy | 0.009 (0.005-0.058) | 0.038 (0.004-0.062) |
| Consistency of the diffusion-weighted volumes, ours minus eddy's | -0.0006 (-0.019 to +0.002) | -0.0003 (-0.003 to +0.018) |
| Consistency of the b0 volumes, ours minus eddy's | +0.0001 (-0.0003 to +0.0021) | 0.0000 |

The full run over all 903 eligible sessions (before the coarse iterations and the Gaussian process) gave a median correlation with eddy of 0.996 in both sets, white-matter FA differences of 0.007-0.008, and motion RMS correlations of 0.92; the sessions furthest from eddy were the Cima.X sessions that the coarse iterations fixed, and sessions where eddy's own b0 volumes are misaligned.

Where they differ, a reference-free check (each volume's correlation with its shell's mean, and each b0 volume's with the b0 median; higher is better aligned) shows which output is more consistent:

- Sessions where eddy is less consistent: its early or late b0 volumes are misaligned (correlation with its own b0 median 0.77-0.89 where ours is 0.94-0.98), in sessions with much movement.
- Sessions where this tool is less consistent: high-FA sessions (by 0.002-0.005), the floor of the 3dSHORE prediction (for a single tensor of FA 0.75 its leave-out error is about 3 %, and the registration partly follows its spatial pattern); and the session with 9 mm of movement (0.896 against 0.911), where `--model=gp` matches eddy's consistency but leaves the FA at the brain's edge 0.16 below eddy's.
- Outlier slices agree well when there are many (Dice about 0.8). The two standardise differently per shell: eddy flags more slices at b = 500, this tool more at b = 2000, and a slice that only one of them flags is near the threshold in the other (z about -2.6).

## Speed

One ADNI session (127 volumes, 116 × 116 × 82 voxels of 2 mm) on a cluster login node, including reading and writing the gzipped files: about 3 minutes with 1 thread (186 s), 30 s with 8; sessions with 7 to 66 volumes take 3-35 s with 8 threads and 13-80 s with 1. The output does not depend on the number of threads. Peak memory is about 1.5 GB for an ADNI session. The ANTs-based SHORELine harness took 2345 s with 8 threads on the same session.

## Tests

`tests/synthetic.rs` builds the phantoms above and checks that the correction recovers the motion, the eddy-current displacement and the image (relative error below 0.04, and well below the uncorrected one), for the standard scheme, phase encoding along x with both polarities, 15 directions starting with a diffusion-weighted volume, a half sphere, a single b0 volume, a DSI grid and b-values spread over a range; that dropped slices are found and replaced; that least-squares restoration of pairs beats Jacobian resampling (with a field twice as strong: 0.018 against 0.021), that slice-to-volume correction beats volume-to-volume with movement within volumes (0.050 against 0.057), and that estimating a field that changes with rotation helps when it does (600 Hz per radian: 0.053 against 0.058) and costs nothing when it does not. `cargo test` runs them in about 25 s; the export for the eddy comparison is an ignored test.
