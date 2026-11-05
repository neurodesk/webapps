# @neurodesk/deconvolution

Widefield and confocal 3D deconvolution in WebAssembly, for `apps/deconvolution`:

- a theoretical **Gibson-Lanni PSF** (scalar; Gibson and Lanni 1991), integrated directly,
- **Richardson-Lucy** with FFT convolution, as scikit-image's `restoration.richardson_lucy`,
- optional **total-variation regularisation** (RL-TV; Dey et al. 2006).

The Rust source is `exes/deconvolution` (`core`: `psf.rs`, `fft3.rs`, `rl.rs`; `wasm`: the
wasm-bindgen surface). `wasm/` holds the committed module, which the app's worker
(`src/worker.js`) and Node (`src/node.js`) both load. `src/index.js` has the pure helpers: PSF
sizing, measured-PSF preparation, input checks and the memory plan.

## Building the module

After changing `exes/deconvolution`, run `pnpm --filter @neurodesk/deconvolution build:wasm`
(Rust 1.98.1, wasm-pack 0.13.1 and binaryen `version_117` wasm-opt on `PATH`) and commit
`wasm/`. The build enables WebAssembly SIMD128 for RustFFT's vectorised butterflies (1.5 times
faster on the example). `deconvolution-native.yml` runs the core tests and clippy, and fails
when `scripts/build-wasm.sh --check` finds the committed bytes differ from a rebuild.

## Method

**PSF.** The intensity at radius `r` and nominal focal depth `z` is
`|∫₀¹ J0(k NA r ρ) exp(i k OPD(ρ, z)) ρ dρ|²`, with the optical path difference of a source at
depth `zp` below the coverslip as in Aguet et al. (2009, eq. 5): sample, immersion and coverslip
layers, design and actual values, and the immersion thickness
`ti = zp − z + ni (ti0/ni0 + tg0/ng0 − tg/ng − zp/ns)` that puts the paraxial focus at `z = zp`.
Square roots are complex, so light beyond a layer's critical angle is evanescent. The integral
uses composite 16-point Gauss-Legendre quadrature split at every critical radius, with enough
segments for the phase and Bessel oscillations, and is evaluated at every voxel's own radius
(no radial interpolation). Coverslip (170 µm, index 1.515) and working distance (150 µm) keep
psfmodels' defaults; the design immersion index equals the actual one. A confocal PSF is the
product of the excitation and emission PSFs (each peak 1), which assumes a pinhole much
smaller than one Airy unit. The volume is normalised to peak 1; Richardson-Lucy receives it
normalised to sum 1.

**Richardson-Lucy.** Exactly scikit-image 0.25's iteration with `clip=False`: the estimate
starts at 0.5, `conv = convolve(u, psf, "same") + 1e-12`, `u *= convolve(image / conv,
flip(psf), "same")`, where `convolve` is a linear convolution with zero outside the image,
cropped from offset `(m − 1) // 2` per axis. Both convolutions are real-to-complex FFT products
on a grid padded to the next 2·3·5-smooth length of at least `n + m − 1` per axis, so nothing
wraps; the second uses the PSF's conjugate spectrum (a correlation) instead of a flipped copy.

**RL-TV.** Each update is divided by `1 − λ div(∇u/|∇u|)` (Dey et al. 2006, eq. 14), with
forward-difference gradients, zero across the far faces, the adjoint backward-difference
divergence, and zero direction where the gradient vanishes, on the voxel grid. The divergence
lies in [−6, 6], so the module refuses `λ ≥ 1/6`; the app allows at most 0.1.

## Validation

`validation/` holds the references and the scripts that recorded them (Python 3.11 with
`validation/requirements.txt`); `test/` checks the committed module against them.

| Check | Reference | Result |
| --- | --- | --- |
| PSF, seven cases (oil, air, water, confocal, low NA, index mismatch at 5 µm into ns 1.33 and at 10 µm into ns 1.45) | adaptive `scipy.integrate.quad` of the same integral (`psf_reference.py`) | max difference 1.5e-7 of the peak (2.9e-16 to 1.0e-13 without evanescent light) |
| PSF, central row where psfmodels integrates exactly | psfmodels 0.3.3 `scalar_psf` (`sf=1, mode=0`) | 6.7e-6 to 7.9e-5 of the peak; 3.9e-3 in the evanescent case, see below |
| Richardson-Lucy, odd sizes, Gibson-Lanni and even-sided PSFs, non-power-of-two grids | scikit-image 0.25.2 `richardson_lucy(..., clip=False)` (`rl_reference.py`) | max relative difference 1.8e-14 and 2.3e-14 |
| RL-TV on a noisy phantom | DeconvolutionLab2 RLTV (`dl2/run.sh`, `rltv-dl2.json`) | qualitative, below |

`node validation/report.mjs` prints the first three rows from the committed module.

**psfmodels and evanescent light.** psfmodels (GPL-3.0; used only as an external reference) is
Aguet's integrator. Where the sample index is below the NA (`oil-mismatch-depth`: ns 1.33,
NA 1.4) its central row differs from this module by up to 3.9e-3 of the peak, while this
module agrees with adaptive quadrature to 1.5e-7 and psfmodels differs from that quadrature by
1.6e-3 at the sampled points. The difference is psfmodels' integration of the evanescent part.

**Why not the Bessel-series PSF.** MicroscPSF-Py's fast method (Li, Xue and Blu 2017) was
ported first and matched MicroscPSF-Py to 1e-14, but its 100-term Bessel fit of the pupil phase
is 3 % of the peak off the exact integral at NA 1.4 (it is exact to 1e-5 at NA 0.95 and 1.2).
Direct quadrature costs about 0.1 s for the example's confocal PSF and has no such error.

**RL-TV against DeconvolutionLab2.** On a 36 × 56 × 56 phantom (three spheres and a bar,
widefield PSF, Poisson noise), away from the border:

| Run | Correlation with DeconvolutionLab2 | RMSE vs phantom, this module | RMSE, DeconvolutionLab2 |
| --- | --- | --- | --- |
| RL, 30 iterations | 0.966 | 4.74 | 5.70 |
| RL-TV λ 0.002, 30 | 0.968 | 4.62 | 5.59 |
| RL-TV λ 0.01, 30 | 0.962 | 4.44 | 5.50 |
| RL, 200 | 0.884 | 7.90 | 9.05 |
| RL-TV λ 0.01, 200 | 0.858 | 3.48 | 7.28 |

The noisy input's RMSE is 8.05. Both implementations reduce the error with TV at every
iteration count; their voxels differ because DeconvolutionLab2 starts from the image instead
of a constant, centres an odd PSF one voxel from scipy's `mode="same"` and pads periodically.
The comparison is qualitative by design.

## Divergences

- Zero outside the image, as scikit-image: the outermost voxels brighten as iterations
  increase. Deconvolve a crop with a margin of background around the cells.
- Point-sampled PSF: no integration over the pixel area (psfmodels' default oversamples by 3).
- One PSF for the whole stack: depth-dependent aberration is computed for one depth.
- Non-square pixels use the x size for both lateral axes.

## References

- Richardson WH (1972) J Opt Soc Am 62:55. doi:10.1364/JOSA.62.000055
- Lucy LB (1974) Astron J 79:745. doi:10.1086/111605
- Dey N et al. (2006) Microsc Res Tech 69:260. doi:10.1002/jemt.20294
- Gibson SF, Lanni F (1991) J Opt Soc Am A 8:1601. doi:10.1364/JOSAA.8.001601
- Aguet F et al. (2009) Opt Express 17:6829. doi:10.1364/OE.17.006829
- Li J, Xue F, Blu T (2017) J Opt Soc Am A 34:1029. doi:10.1364/JOSAA.34.001029 (evaluated, not used)
- van der Walt S et al. (2014) PeerJ 2:e453. doi:10.7717/peerj.453

Licence: MIT (`LICENSE`). The fdlibm notice of libm's Bessel functions is in `NOTICE`; the
licence texts of every crate the module links are in `THIRD_PARTY_NOTICES.md`, generated from
the Cargo lock by `scripts/deconvolution-third-party-notices.py` (`--check` in CI).
