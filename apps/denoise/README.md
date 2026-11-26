# Denoise

Purely in-browser self-supervised denoising of 2D microscopy images, 3D Z-stacks, and 2D+T time-series in TIFF, OME-TIFF, ImageJ TIFF, and NIfTI formats.

## Methods

- **Aydin FGR (`fgr-gbdt`, `fgr-ridge`)**: Noise2Self J-invariant multiscale features (directional pairs, 8-neighbour statistics, hollow donut rings, and off-plane 3D/2D+T neighbours) paired with histogram gradient-boosted trees or holdout-regularized Ridge regression.
- **Zero-Shot Noise2Noise (`zs-n2n`)**: Browser adaptation of Mansour & Heckel (CVPR 2023) using a 2-layer residual CNN trained on diagonal 2×2 sub-image pairs with symmetric residual and consistency loss, accelerated automatically on hardware WebGPU when available with seamless CPU fallback, followed by halo-tiled inference.
- **Anscombe VST + Non-Local Means (`vst-nlm`)**: Smooth-region Poisson–Gaussian gain/readout estimation, Generalized Anscombe Transform with continuous monotone closed-form inverse (Makitalo & Foi Eq. 21 with continuous low-count quadratic ramp), and $O(N)$ integral-image Non-Local Means.

## Shared core & command line

The scientific core and portable Node command line live in [`packages/denoise`](../../packages/denoise) (`@neurodesk/denoise`), packaged for Linux, Windows, and macOS through `exes/node-cli`.

## Development

```bash
pnpm --filter @neurodesk/denoise test
pnpm --filter denoise dev
pnpm --filter denoise build
pnpm --filter denoise test
pnpm --filter denoise test:e2e
```
