# @neurodesk/denoise

Self-supervised denoising core and portable command line for 2D images, 3D Z-stacks, and 2D+T microscopy time-series.

## Methods

- **Aydin FGR (`fgr-gbdt`, `fgr-ridge`)**: Noise2Self J-invariant multiscale feature generation with histogram gradient-boosted trees or holdout-regularized Ridge regression.
- **Zero-Shot Noise2Noise (`zs-n2n`)**: Diagonal 2×2 pair-downsampled 2-layer residual CNN with optional WebGPU compute-shader acceleration (`denoiseVolumeAsync` / `denoiseZsN2nWebGpu`) and automatic CPU fallback.
- **Anscombe VST + Non-Local Means (`vst-nlm`)**: Smooth-region Poisson–Gaussian noise estimation, Generalized Anscombe Transform with continuous closed-form inverse, and $O(N)$ integral-image Non-Local Means.

## Command line

```bash
denoise input.tif output_dir --method fgr-gbdt --residual
denoise stack.nii.gz output_dir --method vst-nlm --noise-model poisson-gaussian
denoise self-check
```

Outputs calibrated float32 TIFF and/or gzipped NIfTI (`--format auto|tiff|nifti|both`) plus `<stem>_provenance.json`.
