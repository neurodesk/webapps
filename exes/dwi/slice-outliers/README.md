# dwi-slice-outliers

Slice outlier detection and replacement for SHORELine (prototype, #480).

Head motion during the diffusion encoding can drop the signal of a whole slice.
FSL eddy finds such slices by comparing them with its model prediction and replaces them with the prediction (`--repol`; Andersson et al. 2016, NeuroImage 141:556-572).
SHORELine does not do this.
This crate is a clean-room implementation of the method from the paper; no FSL code was read.
SHORELine's 3dSHORE leave-out prediction (`dwi-shore`) is the model. It does not use the volume that it predicts, so a dropout cannot hide in its own prediction.

The crate is a prototype: the `hmc` app and command line do not use it until it passes a gate that the maintainer accepts (#480).

## Method

- `slice_statistics`: for each slice of one volume, the mean of observed - predicted over the slice's brain voxels, the mean squared difference, and the number of brain voxels.
- `detect`: within one shell, the statistics of each slice position are standardised robustly, with their median and 1.4826 · median absolute deviation over the shell's volumes. A position with fewer than `min_volumes_per_slice` (10) usable volumes keeps its own median (from 3 volumes) and takes the spread pooled over the shell's positions: the prediction error of an inferior slice position can be the same in every volume of a small shell (ADNI's 6-volume b = 500 shell flagged one slice in all six volumes with whole-shell statistics). `per_slice_position: false` uses the whole shell for every position. A slice is an outlier when its standardised mean difference is below -`n_std`. With `positive`, a slice above +`n_std` is one too; with `squared`, a slice whose standardised mean squared difference is above `n_std`.
- `Params::default()` is eddy's default: `--ol_nstd=4`, `--ol_nvox=250` (slices with fewer brain voxels are not used and not flagged), negative deviations only.
- `replace`: the brain voxels of the flagged slices take the prediction. Voxels outside the mask keep their values, because SHORELine predicts 0 there.
- `OutlierMap` has eddy's three maps (outlier, `n_stdev`, `n_sqr_stdev`) and `report()` writes eddy's report lines.

Iterate as eddy does: predict, detect on the original data, replace, predict from the replaced data, and detect again on the original data.
The second pass matters when two volumes lose the same slice: 3dSHORE predicts voxel by voxel, so a dropout biases the other volumes' predictions in its own slice.

The observed and predicted volumes must be on the acquisition grid.
A dropout belongs to an acquired slice, so the caller warps each prediction back into its volume's own space, as QSIPrep does for its noise-free images.
Volumes are flat arrays in NIfTI voxel order (x fastest).

## Differences from eddy

- eddy predicts with a Gaussian process per shell; this crate uses the 3dSHORE leave-out prediction.
- The paper standardises the slice statistics within a shell; how eddy computes the spread is not documented. A mean and standard deviation over the shell fail on sessions with much motion: the outliers inflate the standard deviation and hide themselves. On one ADNI3 session with 222 eddy outlier slices, they gave Dice 0.40 against `eddy_outlier_map` (sensitivity 0.27); the median and MAD per shell gave 0.78, and per slice position 0.82 (sensitivity 0.84, precision 0.81), both computed from the same run's statistics.
- Multiband groups (eddy `--ol_type=gw` or `both`, `--slspec`) are not handled: each slice is tested alone.
- b0 volumes are not tested: SHORELine aligns them in a separate stage and makes no prediction for them.

## Tests

`tests/synthetic.rs` uses a 24 x 24 x 20 crossing-fibre phantom with two shells (b = 1000 x 30, 2000 x 40), noise σ = 20, and dropouts put in at known volumes and slices (signal x 0.3 to 0.7, two of them in the same slice).

| Check | Result |
| --- | --- |
| Clean data, true signal as the prediction | no outliers |
| Dropouts, true signal as the prediction | exactly the dropouts (z -61 to -280) |
| A slice with fewer than 250 brain voxels | not used and not flagged |
| A bright slice (x 1.6) | flagged only with `positive` |
| Dropouts, 3dSHORE predictions from the corrupted data | exactly the dropouts (z -5.9 to -34) |
| 60 dropouts in one session (true signal as the prediction) | all 60, no others; a mean and standard deviation miss many |
| Prediction bias in the shared slice, before and after replacement | 3.8 -> 1.3 and 15.2 -> 5.5 |
| RMS error of the dropout slices against the truth: data, after one pass, after two | 63-282, 12-20, 12-16 |

## Comparison with eddy (planned)

A native harness runs SHORELine with this crate on two local ADNI3 sets that were also run through FSL eddy 6.0.7.7 with `--repol` (reverse-PE topup and Synb0-DisCo topup; 20 sessions each).
It reports slice-level sensitivity, precision and Dice against `eddy_outlier_map`, per set.
ADNI data cannot be shared; only aggregate numbers will go here and into #480.
Proposed promotion gate: Dice >= 0.7 in each set.
