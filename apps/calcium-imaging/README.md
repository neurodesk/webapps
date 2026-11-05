# Calcium imaging

Two-photon calcium imaging preprocessing in the browser, on the CPU in module workers:

1. **Input**: one single-channel, single-plane TIFF movie, one frame per page (baseline,
   ImageJ or OME-TIFF), read with `@neurodesk/webapp-components/file-io/tiff`. The frame rate
   comes from OME `TimeIncrement` or ImageJ `finterval`/`fps`, or the user enters it.
2. **Motion correction**: rigid, piecewise rigid or none (`src/core/registration.js`).
3. **Summary images**: mean, maximum and local correlation (`src/core/images.js`).
4. **ROIs**: detected from the correlation image, then edited at the cursor (`src/core/rois.js`).
5. **Traces**: ROI and neuropil fluorescence, neuropil subtraction and ΔF/F (`src/core/traces.js`).
6. **Deconvolution**: OASIS for an AR(1) model (`src/core/oasis.js`).

Outputs: the registered movie (TIFF in the input's sample type), the shifts (CSV), the mean,
max and correlation images (float32 TIFF), the ROI labels (uint16 TIFF), the traces and ROI
tables (CSV), the trace plot (SVG) and a provenance record (JSON).

## Methods

All numerics are written from the papers; no code comes from CaImAn (GPL-2.0), Suite2p
(GPL-3.0) or OASIS (GPL-3.0), which serve only as external validation references.

- **Translation estimate.** Guizar-Sicairos, Thurman & Fienup 2008: the integer peak of the
  Fourier cross-correlation of template and frame, limited to `maxShift`, refined to
  1/`upsample` pixel by a matrix-multiply DFT of the cross-power spectrum over a
  ⌈1.5 · upsample⌉-point neighbourhood. The default estimator is the plain cross-correlation,
  as NoRMCorre and CaImAn compute it; *Phase correlation* whitens the cross-power spectrum
  first. Any frame size works: the FFT is radix-2 with Bluestein's algorithm for other lengths.
- **Templates.** The first template is the median over time of the means of consecutive
  10-frame bins. With `templatePasses` > 1, each further pass registers the original frames to
  the mean of the previous pass's registered frames; passes before the last are rigid.
- **Piecewise rigid** (Pnevmatikakis & Giovannucci 2017). After the rigid shift, overlapping
  patches (`patchSize`, `patchOverlap`; the last patch is flush with the edge) are registered to
  the template's patches with their shift limited to `maxDeviation` pixels. Patch-centre shifts
  are interpolated bilinearly to every pixel (constant beyond the outer centres) and the frame is
  resampled through that field.
- **Resampling.** Bilinear, with replicated borders.
- **Local correlation image** (Smith & Häusser 2010): the mean over its eight neighbours (fewer
  at the border) of each pixel's Pearson correlation in time; constant pixels give 0.
- **ROI detection.** A simple, documented method that is **not** Suite2p's or CNMF's. With the
  robust level t = median + z · 1.4826 · MAD of the correlation image, seeds are local maxima at or
  above t at least a cell radius apart; each seed grows by marker-controlled watershed (Meyer
  flooding of −correlation, 4-connected) over pixels at or above median + (z/2) · 1.4826 · MAD and
  within one cell diameter of the seed; regions outside π(d/4)² to π d² pixels are dropped. A
  border band of ⌈largest |shift|⌉ + 1 pixels is left out, because resampling fills it with
  copies of the edge, whose neighbours correlate perfectly. It finds cells that are active during
  the recording: add silent cells with **Add ROI at cursor** (a disc of one cell diameter that
  leaves existing ROIs alone).
- **Neuropil and ΔF/F.** F is the mean of an ROI's pixels. Its neuropil is the ring of pixels more than
  2 px from every ROI and within R of this one, with R the smallest whole radius from 3 px that
  gives at least 200 pixels (at most 5 cell diameters). Fc = F − r · Fneu with r = 0.7
  (Chen et al. 2013, as Suite2p uses). F0 is the running 8th percentile of Fc over a centred 60 s
  window, truncated at the ends, and ΔF/F = (Fc − F0)/F0. Where F0 ≤ 0, ΔF/F is undefined: those
  samples are NaN, the ROI table counts them, and that ROI is not deconvolved.
- **Deconvolution** (Friedrich, Zhou & Paninski 2017). y_t = b + c_t + noise with
  c_t = g c_{t−1} + s_t, s_t ≥ 0, solved for the L1 penalty λ by the pool-adjacent-violators
  scheme of the paper's Algorithm 1. σ is the high-frequency PSD estimate of Pnevmatikakis et al.
  2016 (Welch, Hann, 256-sample segments, mean of log P(f)/2 over 0.25 < f < 0.5); g is the
  least-squares AR(1) fit to the autocovariance at lags 1–6 with σ² removed from lag 0. λ is the
  smallest value whose residual is σ²T, found by bisection; b alternates with the fit
  (b = mean(y − c)) from the 15th percentile of y. It runs on each ROI's ΔF/F.

## Validation

`validation/` holds the scripts, run once against the external tools (Python 3.11.16,
CaImAn 1.13.2 at flatironinstitute/CaImAn@240e1f2, OASIS at
j-friedrich/OASIS@6296247, scikit-image 0.25.2, NumPy 2.4.6, SciPy 1.17.1, tifffile 2026.3.3).
Their outputs, not their code, are committed.

| Check | Reference | Result |
| --- | --- | --- |
| Rigid shifts on the example, 400 frames, same initial template, upsample 10 | CaImAn `register_translation` (`validation/caiman_reference.py`) | identical on every frame (max \|Δ\| 0.0 px); `e2e/smoke.spec.js` checks the browser |
| Phase-correlation shifts on the example | scikit-image `phase_cross_correlation(normalization="phase")` | identical on every frame |
| Cross-correlation and phase shifts, five noisy 45 × 52 frames, upsample 20 (Bluestein FFT path) | CaImAn and scikit-image (`validation/unit_reference.py`) | identical |
| Local correlation image, 17 × 20 × 30 movie | CaImAn `local_correlations` (4 neighbours); per-pixel `numpy.corrcoef` (8) | ≤ 3.4 × 10⁻⁸ |
| `oasisAR1`, λ = 0 and 1, three simulated traces | OASIS `oasisAR1` (`validation/oasis_reference.py`) | c and s within 1.4 × 10⁻¹⁵ |
| Noise-constrained fit | OASIS `constrained_oasisAR1(optimize_b=False)` | residual equals σ²T to 10⁻⁸ (OASIS: within 10⁻⁴); c within 7.7 × 10⁻⁵, λ within 0.05 % |
| σ and g estimates | OASIS `GetSn(method="logmexp")`, `estimate_time_constant(p=1, lags=5)` | within 10⁻¹² |
| Piecewise rigid on a known linear shear (±1.5 px) | analytic ground truth (`test/registration.test.js`) | patch shifts within 0.3 px, mean error < 0.15 px; residual less than half the rigid one |
| Whole pipeline on a synthetic shifted movie with four cells | ground truth (`test/analysis.test.js`) | shifts within 0.35 px, four ROIs found and deconvolved |
| Browser against the same pipeline in Node, on the example | `e2e/smoke.spec.js` | shifts CSV, registered movie, labels and correlation image identical; traces and ROI tables within 10⁻⁵ relative |
| TIFF writer | tifffile 2026.3.3 | read back as an ImageJ time series with the written values, interval and resolution |

On the example (Chromium, 15 workers) rigid correction with two template passes and the
analysis take about 10 s.

## Deliberate divergences

- CaImAn's eight-neighbour correlation image adds its diagonal terms to the wrong pixels;
  this app uses the definition (the mean correlation with each actual neighbour). CaImAn's
  four-neighbour image is reproduced exactly.
- Resampling is bilinear with replicated borders; CaImAn uses OpenCV bicubic warps. This does not
  change the shifts, only the registered pixel values.
- Patch correlations are not windowed, as in NoRMCorre; on the shear test this biases patch
  shifts slightly toward zero (by up to 0.25 px for a 1.1 px shift in a 32 px patch).
- The constrained OASIS λ is found by bisection on the noise constraint rather than the paper's
  λ update; the solution is the same up to the stopping tolerance, and this one meets the
  constraint more tightly.
- ROI detection is the app's own simple method (above), not Suite2p's or CNMF's, and finds active
  cells only.

## Example

`froemke-nv60-a1-gcamp-400frames.ome.tif` (41.8 MB, sha256 `574bb8e1…a1c6e`): frames 400–799
(0-based) of the raw, unaligned TwoPhotonSeries of
`sub-NV60/sub-NV60_ses-20180307T125239_ophys.nwb` in DANDI 000249 version 0.230423.1416
(Schiavo, Valtcheva, Bair-Marshall, Song, Martin & Froemke; mouse auditory cortex, layer 2/3
excitatory neurons, 256 × 256 pixels at 3.90625 Hz), licensed CC-BY-4.0. It is written as a
zlib-compressed OME-TIFF with `TimeIncrement` 0.256 s and pinned in the `neurodeskorg/webapps`
dataset at commit `dfeaa34`. The pixel size is not recorded in the source, so the app shows the
image in pixels. Cite Schiavo et al. 2020 (Nature 587:426) and the DANDI dataset when using it.

## Development

```sh
pnpm --filter calcium-imaging test        # unit tests against the committed references
pnpm --filter calcium-imaging build
pnpm --filter calcium-imaging test:e2e    # Playwright against vite preview (downloads the example)
```
