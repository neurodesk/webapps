# dwi-denoise

Patch2Self denoising (Fadnavis et al. 2020), ported from DIPY 1.12.1 (`dipy/denoise/patch2self.py`, BSD-3-Clause, [LICENSE-DIPY](LICENSE-DIPY)).
The port is `patch2self(data, bvals, version=1, patch_radius=0, model="ols")` with DIPY's defaults for the other options.
No MP-PCA code and no MRtrix `dwidenoise` code is used.

## Method

Each volume is predicted by a least-squares fit, with an intercept, on the other volumes of its group.
The fit uses all voxels (no mask) and is applied to all voxels.
The b0 volumes and the diffusion-weighted volumes are two separate groups.
A group of one volume (a single b0) is copied unchanged.
Fewer than 2 diffusion-weighted volumes is an error.

DIPY's `model="ols"` is scikit-learn `Ridge(alpha=1e-10)` with its Cholesky solver.
The port does the same: the volumes are centred by their means, the weights solve `(Xc'Xc + αI) w = Xc'yc` with α = 1e-10, and the intercept is `ȳ - x̄·w`.
It makes one Gram matrix `S = Σ z zᵀ` per group, with `z` the voxel's group values and a 1.
The centred Gram is `S[:n,:n] - N m mᵀ`, and each volume has its own Cholesky solve.

## API

The work is three steps, so that a caller can split the voxels across workers and keep one copy of the data.

1. `accumulate_gram` adds a voxel range to a group's Gram matrix, in f64. The Gram matrices of separate ranges add element by element.
2. `solve` makes each volume's weights and intercept from the Gram matrix.
3. `apply` replaces a voxel range with its predictions, in place. It reads a block of 256 voxels of every group volume into a small f64 buffer before it writes the block.

Data is volume-major, as in NIfTI (first spatial index fastest, volume slowest).
A range can be part of the whole array (`stride` = voxels per volume) or an independent chunk (`stride` = its own voxel count).
Storage is f32 or f64 (`Sample`); the computation is always f64.
`denoise` does the three steps for both groups.

## Choices

- **Version 1, not version 3.** DIPY's default, version 3, fits each volume on a random sketch of the voxels. The sketch is not seeded, so two runs give different output: on the stage 1 simulation two runs differed by an NRMSE of 0.016. Version 1 is the exact regression that version 3 approximates, and it is deterministic. On the simulation of the ds005134 acquisition with a known truth (in the brain mask), the output RMSE over the raw RMSE was 0.383 (version 1) and 0.390 (version 3) with independent noise (`iid15`), and 0.391 and 0.398 with spatially correlated noise (`corr15`).
- **DIPY's `model="ols"` defect is not copied.** DIPY 1.12.1 makes `Ridge(alpha=1e-10, copy_X=False)`. scikit-learn then centres the regressors in place during `fit`, and version 1 predicts on the centred array. Each output volume then has a constant error of `x̄·w` (about 46 signal units on the slab). The port applies the fit to the original values, as `Ridge(alpha=1e-10, copy_X=True)` does. The fit itself is the same.
- **Post-processing.** DIPY's default `shift_intensity=True` adds `min - min`, which is zero, so it does nothing. `clip_negative_vals` is false by default. The port does neither, so negative predictions stay.
- **b0 rule.** The groups use the shared `dwi_gradients::B0_THRESHOLD` rule: b < 50 s/mm² is b0. DIPY takes b <= 50 as b0, so the two differ only for a volume at exactly b = 50. Such a volume changes groups, and that changes the regression of every volume in both groups, not only its own.
- **Singular regressions.** When the other volumes of a group are linearly dependent (for example, two identical volumes), a Cholesky pivot is below 1e-10 of its diagonal entry and `solve` returns an error that names the volume that is a linear combination of the others. scikit-learn then changes to its SVD solver. Measured noise never makes volumes dependent, so this applies only to synthetic or damaged data.
- **Constant volumes.** A volume with the same value in every voxel centres to zero, so scikit-learn gives it zero weight and predicts it as its mean. The Gram form computes its centred variance as `S_ii - N m²`, whose rounding can be negative, so `solve` sets a centred variance below 1e-11 of `S_ii` to zero and gets the same result.
- **Values that are not finite.** A NaN or an infinity in a group's volumes makes `solve` return an error, as scikit-learn's input check does in DIPY.

## Tests

- `tests/fixture.rs` runs `tests/data/fixture.json`: two small integer-valued series that `spec.py` (the float64 reference of stage 1) denoised. spec.py equals DIPY version 1 (with `copy_X=True`) to < 5e-15 of the signal range. With f64 storage the port equals the reference to 4.4e-16 of the range (limit 1e-9). With f32 storage each output is within one f32 ulp of the reference rounded to f32. The tests also check the group rules, the dependent-volume error, and that chunked Gram sums and chunked passes equal one pass (Gram to 1e-12 relative, output to 1e-9 of the range: partial sums round in a different order).
- `tests/oracle.rs` compares with DIPY on the ds005134 slab (67 × 92 × 10 × 137) when `DWIDENOISE_ORACLE` names the dataset's `dwidenoise/validation` directory. The input comes from `../../noddi/examples` next to it, or from `DWIDENOISE_INPUT` (a `.nii.gz` with its `.bval` beside it). The f32 output equals the oracle (float64 results stored as float32) bit for bit; the f64 output differs by at most 3.1e-5, the oracle's f32 rounding.

```sh
DWIDENOISE_ORACLE=/path/to/neurodeskorg-webapps/dwidenoise/validation cargo test --release -p dwi-denoise
```

## Reference

Fadnavis S, Batson J, Garyfallidis E (2020). Patch2Self: Denoising Diffusion MRI with Self-Supervised Learning. Advances in Neural Information Processing Systems 33.
