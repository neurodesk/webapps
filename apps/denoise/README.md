# Denoise

Purely in-browser self-supervised denoising for 2D microscopy images, 3D Z-stacks and 2D+T time-series (TIFF, OME-TIFF, ImageJ TIFF and NIfTI).

## Methods

- **Aydin FGR (Boosted Trees / Fast Ridge)**: Implements Noise2Self (Batson & Royer, ICML 2019) using strictly blind-spot multiscale features (directional pairs, 8-neighbour statistics, cancellation-free hollow donut rings, and off-plane 3D/2D+T neighbours) paired with histogram gradient-boosted regression trees (with in-image holdout early stopping) or cross-validated Ridge regression. For fixed normalization and a fixed fitted model, predictions never read the target voxel.
- **Zero-Shot Noise2Noise (ZS-N2N)**: Browser adaptation of Mansour & Heckel (CVPR 2023) using the paper's 2-layer residual CNN and symmetric residual + consistency loss on diagonal 2×2 downsampled sub-image pairs with Adam (defaulting to 16 channels, 48×48 random crops and 200 steps for interactive CPU speed; up to 48 channels and 1500 steps configurable), followed by seamless tiled inference.
- **Anscombe VST + Non-Local Means**: Classical Poisson-Gaussian baseline combining smooth-region wavelet shot/readout noise estimation (Foi et al. 2008), the Generalized Anscombe Transform with a continuous monotone approximation to the unbiased inverse (Makitalo & Foi 2013, Eq. 21 with a continuous low-count quadratic ramp), and fast integral-image Non-Local Means with mirror-padded patches (Buades et al. 2005; Darbon et al. 2008).

## Outputs & Diagnostics

Every run outputs the denoised image (Float32 TIFF and NIfTI `.nii.gz`) plus the noise residual map (`input - denoised`) and reports estimated Haar noise-floor reduction and per-axis residual lag-1 autocorrelation in the Analysis console to help screen for over-smoothing.
