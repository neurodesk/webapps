# glm

Rust port of glm.py: block-design first-level GLM t maps for a fastprep or fMRIPrep `desc-preproc_bold`.

```bash
make build
target/release/glm bold.nii.gz confounds.tsv events.tsv condition out.nii.gz [--fwhm 0] [--ols]
target/release/glm --task-analysis bold.nii.gz confounds.tsv events.tsv lgr.nii.gz rgl.nii.gz l.nii.gz r.nii.gz \
  --summary summary.json [--fwhm 5]
target/release/glm --meica-qc desc-ICA_mixing.tsv desc-tedana_metrics.tsv confounds.tsv events.tsv|'' bold.json qc.json
```

Model: condition boxcars convolved with a double-gamma HRF, intercept, DCT drift (128 s) and 6 motion parameters;
non-steady-state volumes dropped. Noise: AR(1) prewhitening (lag-1 residual autocorrelation smoothed 5 mm,
quantised to 0.01 and capped at 0.9, then a Prais-Winsten refit). Float32 steps of the NumPy reference stay float32,
so voxels get the same AR(1) groups.

Differences from glm.py: rank-deficient designs, empty masks and mismatched confounds fail with a message;
a zero-variance voxel gets t 0 (NumPy gives inf/nan); `t_display` agrees with SciPy to about 1e-14.
Confound cells must be finite numbers. NaN, infinity and numeric overflow fail with the TSV row and column
name instead of producing zero maps. The documented `n/a` and empty cells still read as zero. `--meica-qc` (glm.py
`meica_qc`, fastprep's ME-ICA report) writes NaN correlations as `null`, where Python writes `NaN`; values agree
to 1e-15 on motor3T.
Fixed here, still open in glm.py: short `events.tsv` rows read as empty cells; a NaN `vox_offset` is
rejected; the sidecar is found for `.nii` as well as `.nii.gz`; an output named `.nii` is written uncompressed.
