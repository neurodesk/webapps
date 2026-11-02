# SamSrf Octave reference harness

Runs SamSrf's own MATLAB sources (commit `41ed1e96`) in GNU Octave 9.2 with a few
shims and writes the reference outputs that the Rust port's parity script compares
against. Everything is computed in double precision. The outputs are scratch data:
they live under `SAMSRF_REFERENCE_DIR` and are never committed.

## Run

```sh
packages/samsrf/validation/octave/run.sh
```

Environment variables, with their defaults:

| Variable | Default | Content |
| --- | --- | --- |
| `SAMSRF_EXAMPLE_DIR` | `/storage/scratch/samsrf-work/dl/X001` | The OSF `h92mr` example (`func/lh_uBars1-6.gii`, `prf/aps_Bars.mat`, `prf/hrf_fit.mat`, `prf/V123.label`) |
| `SAMSRF_REFERENCE_DIR` | `/storage/scratch/samsrf-work/reference` | Output directory, created if missing |
| `SAMSRF_SOURCE_DIR` | `/storage/scratch/samsrf-work/src/samsrf` | The SamSrf checkout, mounted read-only |
| `SAMSRF_OCTAVE_IMAGE` | `gnuoctave/octave:9.2.0` | The Docker image |

The script needs Docker and a host `python3` with numpy (it runs the Python with `-I`).
It runs `dump_gifti.py` and `select_vertices.py` on the host, copies `aps_Bars.mat`
into the output directory, then starts Octave in the container with the SamSrf folders
(`Fitting`, `pRF`, `Hrf`, `Surfs`, `Utils`, `Various`) on the path and `shims/` in front
of them, and calls `reference.m`. Reruns overwrite every output; two runs give
byte-identical files, except `apertures/aps_Bars_vec`, whose MAT header carries the
save time. It prints the wall time and writes it to `wall_time.txt` (205 s and 215 s
on the 16-core development host, of which Octave takes 184 s).

## Outputs

Binary files are raw little-endian IEEE doubles (`.f64`) or float32 (`.f32`) in
MATLAB column-major order: for a `rows x cols` matrix, element `(r, c)` is at index
`c * rows + r`. The shapes below are `rows x cols`. JSON vectors are written by
Octave's `jsonencode` at full double precision; non-finite scalars that matter are
written as the strings `"Inf"`, `"-Inf"` or `"NaN"`, and `jsonencode` writes any
other NaN or Inf as `null`.

### GIFTI reader check (`dump_gifti.py`)

| File | Content |
| --- | --- |
| `gifti/lh_uBars<n>.gii.f32` | 134260 vertices x 250 arrays, float32: array `t` occupies bytes `t * N * 4 ..` |
| `gifti/lh_uBars<n>.gii.json` | `{"file", "arrays", "vertices"}`, read by the `gifti` shim |
| `gifti_run.json` | Per file: `arrays`, `vertices` and 256 `{"volume", "vertex", "value"}` samples (0-based, numpy `RandomState(0)`, `value` the exact float32) |

The dumper parses the GIFTI XML with the standard library and decodes the
`GZipBase64Binary` float32 arrays itself; it refuses any other data type, encoding,
endianness or dimensionality. On the X001 runs its output is bit-identical to
nibabel's (checked by hand, nibabel is not available under `python3 -I`).

### Apertures (`VectoriseApertures`)

`VectoriseApertures` runs on `apertures/aps_Bars.mat` and saves `apertures/aps_Bars_vec`
next to it (Octave's `save` does not append `.mat`; the file is MATLAB v7 format).

| File | Shape | Content |
| --- | --- | --- |
| `apertures.json` | | `height` 100, `width` 100, `volumes` 250, `pixels` 10000, `apfrm_shape`, `apxy_shape`, `apxy_max_abs`, `scaling_factor` 9.5 |
| `apertures_apfrm.f64` | 10000 x 250 | `ApFrm`, pixels x volumes. Pixel `p` is row `mod(p, 100)`, column `floor(p / 100)` of the movie frame |
| `apertures_apxy.f64` | 10000 x 2 | `ApXY`, pixel coordinates in `[-1, 1]`, Y positive at the top |
| `apertures_apxy_scaled.f64` | 10000 x 2 | `ApXY / max(abs(ApXY(:))) * 9.5`, what `samsrf_fit_prf` passes to the pRF functions |

The X001 apertures are not binary: `ApFrm` ranges from -0.074 to 1.087 (the movie was
smoothed before saving).

### Preprocessing (`samsrf_gii2srf`, `samsrf_removenoise`)

All six runs, `hemsurf = ''`. `preprocess_vertices.json` holds the vertex subset the
per-vertex outputs are restricted to: the left-hemisphere rows of `prf/V123.label`
(the bilateral label lists the left hemisphere first; rows with index >= 134260 are
the right hemisphere and dropped) plus 512 other vertices drawn with numpy
`RandomState(0)`; `subset` and `roi` are sorted, unique and 0-based. Subset column `k`
is vertex `subset[k]`.

| File | Shape | Call |
| --- | --- | --- |
| `preprocess_vertices.json` | | `vertices` 134260, `label`, `roi` (6587), `subset` (7099) |
| `preprocess.json` | | `volumes_per_run`, `vertices`, `runs`, `subset_count`, `noise_ceiling_finite`, `errfun_vertices`, `concat_volumes` |
| `preprocess_average.f64` | 250 x 7099 | `Srf.Data(:, subset)` of `samsrf_gii2srf(runs, '', 1, true, true)` |
| `preprocess_noise_ceiling.f64` | 7099 | `Srf.Noise_Ceiling(subset)` of the same call; NaN where a vertex is all zero |
| `global_signal_average.f64` | 250 | `nanmean(Srf.Data, 2)` over all 134260 vertices |
| `preprocess_removenoise.f64` | 250 x 7099 | `cSrf.Data(:, subset)` of `samsrf_removenoise(Srf, nanmean(Srf.Data, 2), subset)` |
| `preprocess_concat.f64` | 1500 x 7099 | `Srf.Data(:, subset)` of `samsrf_gii2srf(runs, '', 1, false, true)` |
| `global_signal_concat.f64` | 1500 | `nanmean(Srf.Data, 2)` of the concatenated data |
| `preprocess_detrend_run1.f64` | 250 x 7099 | `Srf.Data(:, subset)` of `samsrf_gii2srf(runs(1), '', -1, true, true)` (detrend only) |

### HRFs (`hrf.json`)

`fP` is `[8 13 2 1]` from `prf/hrf_fit.mat` (a double array; scipy's `loadmat`
reports its storage type `uint8` unless called with `mat_dtype=True`).
`test_sequence` is `Y = mod((1:50)', 7) - 3`. `entries` has, for `tr` 1 and 2.55 and
each `kernel`:

| `kernel` | Expression |
| --- | --- |
| `doublegamma_default` | `samsrf_doublegamma(TR)` |
| `samsrf_hrf` | `samsrf_hrf(TR)` |
| `old_school` | `samsrf_doublegamma(TR, [fP(1:2) 1 1 fP(3) 0 32])' * fP(4)`, a row vector (`shape` `[1, L]`) as in `samsrf_fit_prf` |
| `doublegamma_nondefault` | `samsrf_doublegamma(TR, [5 15 1.2 0.9 5 1 30])` |

Each entry stores `shape`, `values`, and `convolve_ds1` and `convolve_ds2`,
`prf_convolve_hrf(Y, kernel, 1)` (50 values) and `(Y, kernel, 2)` (25 values).
`gampdf_at_zero` holds `gampdf(0, a, 1)` for `a` 0.5, 1 and 6 (`"Inf"`, 1, 0).
The kernels have `length(p(6):p(7)/TR)` samples over `linspace(p(6), p(7), L)`, so
the sampling is `32 / 12 = 2.667 s` at TR 2.55, not 2.55 s; the peaks fall at 5 s
(canonical, de Haas), 7 s (old school) and 4 s (non-default).

### pRF profile functions (`prf_profiles.json`, `profile_*.f64`)

Every entry names `function`, `params`, `branch`, `shape`, `file` and `nan_count`.
`xy` entries call the function with the scaled `ApXY` (`apertures_apxy_scaled.f64`,
`shape` `[10000, 1]`, or `[10000, 2]` for `prf_gaussian_rf_2sigma`); `grid` entries
pass `screen_width = 200` and store the 200 x 200 matrix column-major. The parameter
sets include negative `x0`/`y0`, a sigma below one pixel (0.05 against a 0.19 pixel),
`phi` of -30 and 400 for `prf_multivariate_rf`, negative and positive `kappa` for
`prf_sumnorm_rf` and `alpha` of both signs for `prf_skewgauss_rf`.

### Model expressions (`expr.json`)

`cases` holds every distinct `Prf_Function` and `SeedPar_Function` string found in
`Models/*.m` and `Models/Json/*.json` (10 strings, the `.m` files' line comments and
`;` stripped), evaluated through `str2func` on two inputs each: a pRF function gets
`P` (one of two 5-element rows, so every model's indices resolve) and the 6 x 2
matrix `XY`; the seed function gets a 4-element column `V`. Each case records
`source`, `kind`, `files`, `inputs`, `shape` and `values` (column-major).

### Error function (`errfun.json`)

`prf_errfun(@(P,ApWidth) prf_gaussian_rf(P(1),P(2),P(3),ApWidth), ApFrm, ApXYscaled, Hrf, P, Y, 1, CssNonlin)`
with `Y` the averaged time course (`preprocess_average.f64` column of `vertex`) of
the three ROI vertices with the highest noise ceiling (`vertex` is 0-based; 612, 408
and 407 on X001). `cases`: three parameter sets per vertex with `Hrf = samsrf_doublegamma(1)`;
one `css_nonlinearity` case with a 4-parameter `P`; one `hrf = -1` case with 8
parameters (HRF fitted inside `prf_errfun`); and one `hrf = -1` case whose HRF
parameters are out of bounds, which returns 1. `predicted_timecourse` is
`prf_predict_timecourse` for the first parameter set, before convolution.

### fminsearch (`fminsearch_rosenbrock.json`)

The shim on MATLAB's documentation example: `fminsearch(banana, [-1.2, 1])` reaches
`x = [1.0000220, 1.0000422]`, `fval = 8.1777e-10`, `exitflag = 1`, with 85 iterations
and 159 function evaluations, the counts MATLAB documents. Octave's own `fminsearch`
gives 74 and 143. `stopped_by_outputfcn` is the same search with an `OutputFcn` that
returns true at iteration 10: `exitflag = -1`, 10 iterations, 21 evaluations.

## Shims

Each file in `shims/` documents itself at the top.

| Shim | Why |
| --- | --- |
| `fminsearch.m` | MATLAB's Nelder-Mead (initial simplex, coefficients, acceptance rules, stable sort, convergence test, `OutputFcn`, `output` fields), the algorithm the Rust phase-2 port implements. Octave's own takes a different path. |
| `gampdf.m` | Statistics-package function the container lacks; MATLAB's `x = 0` cases (Inf for `a < 1`, `1 / b` for `a == 1`, 0 for `a > 1`) matter because `samsrf_doublegamma` starts at `t = 0`. |
| `nanmean.m` | Missing in Octave; `samsrf_gii2srf` averages runs with it and the global signal is `nanmean(Data, 2)`. |
| `normcdf.m` | Statistics-package function; `prf_skewgauss_rf` uses it. |
| `contains.m` | Missing in Octave 9.2; `samsrf_gii2srf` tests `contains(funimg, '*')`. |
| `samsrf_32bit_srf.m` | Identity. SamSrf's version converts every double field to single unconditionally (its `exist('SamSrfDefs.defs_64bit', 'var')` guard tests a name that never exists); the reference stays in double, and this also avoids `LoadSamSrfDefaults` and `SamSrf_defaults.json`. |
| `gifti.m` | SPM's `gifti` class is absent; returns a struct whose `cdata` (vertices x arrays, single) comes from the sidecars `dump_gifti.py` writes. |
| `spm.m` | Empty, so `exist('spm', 'file')` is true and `samsrf_gii2srf` reads GIFTI files. |

`EnsurePath` and `LoadSamSrfDefaults` exist in the SamSrf sources and need no shim;
`parfor` runs as `for` in Octave. SamSrf's `Read_FreeSurfer` is not used (see below).

## Octave versus MATLAB caveats

- `Read_FreeSurfer` reads `.label` files with `textscan(fid, repmat('%n', 1, 6), 'headerlines', 2)`,
  six fields for the five-column files SamSrf itself writes (`samsrf_srf2label`). In
  Octave 9.2 the values run on across lines into a 11459 x 6 matrix for the
  13750-row `V123.label`, so the first column is no longer the vertex index. SamSrf
  has loaded its own labels this way in MATLAB for years, so MATLAB's `textscan`
  must fill the missing field per line; that was not verified here (no MATLAB). The
  harness reads labels with numpy (`select_vertices.py`), not through SamSrf.
- `detrend`: Octave removes the least-squares line through `b = [1 t]`, MATLAB
  through `a = [t / N, 1]`. Against an independent numpy least squares with MATLAB's
  design matrix, Octave's `preprocess_detrend_run1.f64` differs by at most 7.3e-12
  (1.1e-14 of the largest value), so a parity tolerance near 1e-10 after z-scoring
  is the right order. A constant non-zero column leaves residuals of about 1e-16
  in Octave (measured on `[5 5 5]`) whose pattern MATLAB need not share, and
  `zscore` then scales that noise to order one. All-zero columns stay exactly zero.
- `zscore` maps a column with zero standard deviation to zeros, not NaN: Octave was
  measured on `[1 1 1]`, and MATLAB's `zscore.m` has the same `sigma0(sigma0 == 0) = 1`
  rule. The 86 all-zero vertices in the subset are zero in `preprocess_average.f64`
  and NaN only in the noise ceiling, where `corr` of two zero vectors is NaN.
- `corr` returns NaN when either input contains NaN or is constant, in both.
- `conv(column, row)` is a column in Octave (the orientation follows the first
  argument). `prf_convolve_hrf` is only ever called with a column `Y`, so the
  old-school row-vector HRF still gives a column prediction; the stored
  `convolve_*` vectors are flattened either way.
- `jsonencode` rejects `single` (every value is cast to double before encoding) and
  writes NaN and Inf as `null`; the harness writes the non-finite scalars it cares
  about as strings.
- `save` does not append `.mat` to an extension-less name, so `VectoriseApertures`
  writes `aps_Bars_vec` (MATLAB would write `aps_Bars_vec.mat`). `reference.m`
  accepts either name. `save_default_options('-v7')` keeps the file in MATLAB format.
- `fminsearch` in Octave is a different implementation (74 iterations and 143
  evaluations on Rosenbrock); the shim replaces it. The shim's convergence test is
  the documented one; MATLAB's current source additionally floors each tolerance
  at `10 * eps` of the best value, which only matters above about 4.5e11.
- Octave warns that `shims/fminsearch.m` shadows a core function; that warning is
  expected.

## Checks on the X001 outputs

`preprocess_average.f64` has no NaN; the noise ceiling is finite for 7013 of 7099
subset vertices, within [-0.74, 0.95], with a median of 0.77 over the ROI.
`preprocess_removenoise.f64` residuals are orthogonal to the global signal to 6e-15.
The HRF peaks are at 5 s for the canonical and de Haas kernels. `prf_errfun` on the
three chosen vertices returns errors between 0.82 and 0.95 for the fixed guesses.
