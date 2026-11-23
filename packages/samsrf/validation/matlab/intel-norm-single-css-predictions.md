# Pre-registration: Intel AVX512_E1 `dnrm2`/`dznrm2`, single-precision BLAS/QR, and nonnegative CSS (#730, #731, #897)

Frozen on 2026-11-23 before dispatching `samsrf-native.yml` with `record_matlab=true` and `probes=intel-norm-single-css`.
Authorized by maintainer (`stebo85`) to record pre-registered blind black-box probes for the remaining open `#730`/`#731`/`#897` numerical items.

## Frozen artifacts

| File | SHA-256 |
| --- | --- |
| `intel-dnrm2-probes.json` | `78e020877fd8af7686732e1597a62ef70db91c1c3506fab4a21f6125a61ca77b` |
| `record_intel_norm_single_css.m` | `4ae2de9e6bc0e4a602c440c35eac9a6a4c92f94cf43d687ee70e781403f689f5` |

## 1. Intel AVX512_E1 `dnrm2` / `dznrm2` x87 80-bit identification (#730)

### Motivation
On previously recorded Intel Xeon `AVX512_E1` hosts (`numerics`, `numerics2`, `arithmetic-order`), the correctly rounded Euclidean norm (`BigUint`) matches all 24 real/complex BLAS vectors, all 95 R(1,1) chains, and 1,198 of 1,200 `corr` values, missing only two near-midpoint vectors (`n = 36` pair 6 at `+6.45e-5` ULP above midpoint, and `n = 75` pair 16 at `+2.64e-4` ULP above midpoint) where MATLAB returns 1 ULP lower.

On replay across all 2,400 centered `corr` vectors in `arithmetic-order` and all 24 BLAS vectors in `numerics`, hardware x87 80-bit extended-precision (`64`-bit significand, `15`-bit exponent) 4-accumulator sum-of-squares + `fsqrt` reproduces all 24/24 BLAS vectors AND hits **both** near-midpoint misses with **zero** other differences across all 2,400 vectors (specifically `x87-4lane-seq`, `x87-4unroll-tail-a0-pair`, and `x87-4unroll-tail-tot-stride`).

### Blind test design (`intel-dnrm2-probes.json`)
- **Real `dnrm2` (`168` vectors):** 14 vectors per length across `n in {5, 7, 13, 17, 18, 19, 20, 33, 36, 37, 64, 75}`, each constructed so its exact Euclidean norm lies within `4e-4` ULP of a `float64` rounding midpoint (seed `73020261123`).
- **Complex `dznrm2` (`48` vectors):** 8 vectors per length across `n in {5, 13, 17, 36, 50, 75}` (2n real components interleaved), within `4e-4` ULP of a `float64` midpoint.
- **Extreme-scale `dnrm2` (`8` vectors):** `n = 17` and `n = 36` near-midpoint vectors scaled by `2^600`, `2^-600`, `2^1000`, `2^-1000` (where `x^2` overflows/underflows IEEE `float64` but stays inside x87's 15-bit exponent `[-16382, +16383]`, distinguishing unscaled x87 accumulation from explicit scaling).

### Frozen candidate SHA-256 predictions (little-endian `.f64` arrays)

| Candidate | Real 168 SHA-256 (`dnrm2_real_norms.f64`) | Complex 48 SHA-256 (`dnrm2_complex_norms.f64`) | Extreme 8 SHA-256 (`dnrm2_extreme_norms.f64`) |
| --- | --- | --- | --- |
| `x87-1lane-seq` | `e8109ce68e6d3085aa6e97f28daa35a3335197c234c00839d23d963a52b3c7ff` | `a24803eb36253d8e8168ff3fa800ad027b9b4ef40c86b453efe2446ed4a818f8` | `20add51c7c785ccd30cd34dd3669dc856ba18a9dde288952afdc53609a5c01dc` |
| `x87-2lane-seq` | `9cd6e3641518486cdc364ba502a065470ff5f903c13a0e4b17dc4f72753e5dcc` | `7f56cac3010a453c8dba6e24810b0b8d59288886844bdfe92e540806ce5b16fa` | `d15f8fadd8c2e05b328eac0aedf61c825ebaa59a5c886e612e7ce4d9b3079d4e` |
| `x87-4lane-seq` | `06e0bb40a35b619c6c1650eaed05a2066aed29752e184197ae8aabda4a9a64d6` | `42b2ead6254efd593cca1b0c8d12f468c7729fa9879d5242c67fb3c3049fde5d` | `20add51c7c785ccd30cd34dd3669dc856ba18a9dde288952afdc53609a5c01dc` |
| `x87-4lane-pair` | `eea8c232ec60a2ec6f39d21c494e13d72148cadae0ba960a14c097fea1f66f33` | `421d5a2ae38b7847670fa1f3bd29dc41af2a3a5261fdea0f2d3c60fa5b3ce535` | `20add51c7c785ccd30cd34dd3669dc856ba18a9dde288952afdc53609a5c01dc` |
| `x87-4lane-stride` | `9ee73f659866302761505cc665763581006203f5f20190ef437a67a3ae3e12d9` | `5db3763f4a43d39ee4c343a1754fafbaf36dee8580ccdfb6b0fbeb9bd283e85d` | `20add51c7c785ccd30cd34dd3669dc856ba18a9dde288952afdc53609a5c01dc` |
| `x87-4unroll-tail-a0-pair` | `7b540fc6347b2b0421b71392629c19e8718d3fda134f6fc6fcec978ce16664d1` | `421d5a2ae38b7847670fa1f3bd29dc41af2a3a5261fdea0f2d3c60fa5b3ce535` | `20add51c7c785ccd30cd34dd3669dc856ba18a9dde288952afdc53609a5c01dc` |
| `x87-4unroll-tail-tot-stride` | `a492b1eabd2f29b78dbdca604d9225fa338c72ba9cdf5789b10dd674e428ff7b` | `5db3763f4a43d39ee4c343a1754fafbaf36dee8580ccdfb6b0fbeb9bd283e85d` | `20add51c7c785ccd30cd34dd3669dc856ba18a9dde288952afdc53609a5c01dc` |
| `x87-8lane-pair` | `404b20987fd43cfacd04b8eb2c65286b51e12b9a42c7aaf021ea280a52fef862` | `12fa26a19fe3aea3015a3efbe3adec0fb4bf1de95764b829dd376e1dffa2126d` | `d15f8fadd8c2e05b328eac0aedf61c825ebaa59a5c886e612e7ce4d9b3079d4e` |
| `correctly-rounded` (control) | `e931a197d08cea17cd9e2179604be7e4e4fa6b8ffb3ede0818c03e75ea6506a5` | `122c2f641739cbdf780e5ab2094871afa58de6022fd00e7c2d1975ad5c4f7c1e` | (unscaled) |

### Decision rule
- **Confirmed:** A candidate matching **168/168** real norms (exact SHA-256 match) on an Intel `AVX512_E1` host AND matching all 24 BLAS vectors, 95 R(1,1) chains, and 1,200/1,200 `corr` values on existing Intel recordings is confirmed for real `dnrm2` (and likewise 48/48 for `dznrm2`, 8/8 for extreme scale).
- **Refuted / further discovery:** If no listed candidate matches 168/168, inspect the exact mismatch pattern (e.g., fold order, unroll boundary, or scaling threshold) and do not adopt an approximate or fitted band.

## 2. Intel AVX512_E1 single-precision BLAS and blind two-column QR (#731)

Records on both AMD (`CNR auto`) and Intel (`AVX512_E1`) hosts (`single-blas-qr.json`):
- **Single `sdot` (`x' * y`):** FPRev pair fingerprints (`big = single(2^40)`) for `n = 2..80` (all pairs) and `96, 100, 127, 128, 129, 200, 250, 256, 1000` (300 sampled pairs), plus 50 random `single` draws per length (discovery on draws `1..25`, held-out check on draws `26..50`).
- **Single `sgemv` (`y' * A`, transposed):** FPRev pair fingerprints (`big = single(2^40)`) for `[250 9; 250 8; 250 7; 250 5; 61 9; 128 9; 97 5; 17 3]`, plus 100 random `single` draws per shape (discovery `1..50`, held-out `51..100`).
- **Single `corr(x, y)` held-out:** 20 random `single` pairs at `n in {16, 25, 36, 50, 64, 100, 250}`.
- **Blind held-out single two-column QR (`[x ones] \ Y` and `[ones x] \ Y`):** 20 random `single` real and 20 random `single` complex designs at `m in {16, 37, 65, 250}`, both 1-RHS and 8-RHS. Models fitted from the existing `qr-kernels` Xeon 8370C fingerprints (`sgeqp3`/`sormqr`/`strsv`, `cgeqp3`/`cunmqr`/`ctrsv`) will be tested blind against these draws.

## 3. Intel double nonnegative-clipped CSS on original signed apertures (#730, #897)

Records (`nonnegative-css.json`) on `x001_lh` original signed apertures (`inputs.json`, double precision):
- 48 pointwise evaluations (`12` ROI vertices × `4` exponents `[0.3, 0.5, 0.7, 0.85]`) where `rawYp = prf_predict_timecourse(...)` contains negative values, computing `max(rawYp, 0).^Exponent` through MATLAB's `prf_convolve_hrf`, `corr`, and `[ones pred] \ y`.
- 12 full Nelder-Mead (`fminsearch`) fine fits under the same nonnegative-clipped CSS objective on the original signed apertures.
- **Decision rule:** Enabling `Css_Convention: "nonnegative"` under `matlab-intel` requires matching every recorded Intel evaluation (`rawYp`, `predicted`, `r`, `objective`, `beta`) and fitted parameter/score (`fitted`, `fval`, `r`, `r2`, `beta`) bit for bit on the Intel `AVX512_E1` host, while keeping AMD control equality intact.

## Repeatability and host provenance
Every runner executes `record_intel_norm_single_css` twice in independent MATLAB R2023b Update 11 processes (`maxNumCompThreads(1)`), requiring byte-for-byte identity of all JSON cases (excluding process-specific metadata if any) and all `.f64` arrays. Running 3 replicas per Ubuntu label (`ubuntu-22.04`, `ubuntu-24.04`) ensures both AMD EPYC (`CNR auto`) and Intel Xeon (`AVX512_E1`) hosts are captured by receipt `blas`/`cpu` fields.
