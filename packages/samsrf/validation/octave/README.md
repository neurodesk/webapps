# SamSrf Octave reference harness

Runs SamSrf's own MATLAB sources (commit `41ed1e96`) in GNU Octave 9.2 with a few
shims and writes the reference outputs that the Rust port's parity script compares
against. Everything is computed in double precision. The outputs are scratch data:
they live under `SAMSRF_REFERENCE_DIR` and are never committed.

## Run

```sh
packages/samsrf/validation/octave/run.sh             # reference.m, then analyses.m
packages/samsrf/validation/octave/run.sh reference   # reference.m only
packages/samsrf/validation/octave/run.sh analyses    # analyses.m only
```

The analyses step takes hours, so it can run on its own. It reads the GIFTI sidecars
the reference step writes under `gifti/` and dumps them first when they are missing.

Environment variables, with their defaults:

| Variable | Default | Content |
| --- | --- | --- |
| `SAMSRF_EXAMPLE_DIR` | `/storage/scratch/samsrf-work/dl/X001` | The OSF `h92mr` example (`func/lh_uBars1-6.gii`, `prf/aps_Bars.mat`, `prf/hrf_fit.mat`, `prf/V123.label`) |
| `SAMSRF_REFERENCE_DIR` | `/storage/scratch/samsrf-work/reference` | Output directory, created if missing |
| `SAMSRF_SOURCE_DIR` | `/storage/scratch/samsrf-work/src/samsrf` | The SamSrf checkout, mounted read-only |
| `SAMSRF_OCTAVE_IMAGE` | `gnuoctave/octave:9.2.0` | The Docker image |
| `SAMSRF_LABEL_DIR` | `/storage/scratch/samsrf-work/example` | The web app's example; `lh.V123.label` and `lh.V1_seed.label` become the analyses' ROI and seed |
| `SAMSRF_ANALYSES` | (all) | Comma-separated analysis run names to run, e.g. `rc_fit,cf_summary` |

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

### Analyses (`analyses.m`, under `analyses/`)

`analyses.m` runs SamSrf's three analyses, `samsrf_fit_prf`, `samsrf_revcor_prf` and
`samsrf_revcor_cf` from `Fitting/` (with `samsrf_fit2dprf` from `Analysis/`), unmodified,
with the shims below. It works in `analyses/`, where the analyses save their search
space (`src_pRF_Gaussian.mat`), regressors (`reg_aps_Bars.mat`) and map files. Both
caches are deleted at the start, so the first pRF run generates the search space and
the later ones load it; `rc_hull` generates the regressors and `rc_fit` loads them.
When an analysis errors inside SamSrf, `<run>.json` records the error instead of the
maps (below); SamSrf is not patched.

Inputs prepared by `run.sh` and `analyses.m`:

| File | Content |
| --- | --- |
| `labels/roi_full.label` | `lh.V123.label` of the web app's example, copied: 6587 vertices |
| `labels/seed_v1.label` | `lh.V1_seed.label`, copied: 2917 vertices (Benson V1 within V123) |
| `labels/roi_fine.label` | 200 ROI vertices: the 100 with the highest noise ceiling, plus 100 of the rest drawn with `rand('state', 1)` and `randperm`, sorted ascending |
| `labels/roi_tiny.label` | The 20 ROI vertices with the highest noise ceiling, sorted ascending |
| `subsets.json` | `roi_fine`, `roi_tiny`, `seed`, `roi_full`: 0-based vertex indices in label file order |
| `apertures/aps_Bars.mat` | `prf/aps_Bars.mat`, copied. `samsrf_fit_prf` vectorises it into `apertures/aps_Bars_vec` itself; `samsrf_revcor_prf` uses the 100 x 100 x 250 original |
| `gifti/lh_benson.gii.{f32,json}`, `gifti/lh_benson_samples.json` | `dump_gifti.py` on `benson/lh_benson.gii` (3 float32 arrays) |
| `template/lh_benson.mat` | The Benson template `Srf` as `samsrf_benson2srf` builds it (single-precision angle and eccentricity arithmetic, double `Data`), with the white surface's `Vertices` and `Faces`; `Model.Template = 'template/lh_benson'` |
| `template_data.f64` | 5 x 134260: its `Data` (`R^2` = ROI label non-zero, `x0`, `y0`, `Sigma` all NaN, `ROI`) |
| `template.json` | `values`, `shape`, `source` |

The functional `Srf` is `samsrf_gii2srf(runs, '', 1, true, true)` as in the
preprocessing section, given what `samsrf_gii2srf` reads from a surf folder:
`Vertices` and `Faces` from `surf/lh.white`, `Area` from `surf/lh.area` (a row),
`Hemisphere = 'lh'`. The runs are the original X001 runs, not the web example's
(which zeroes vertices outside V1-V3), so the CF global signal differs between the two.

Models: `Example_2D_Gaussian_pRF.json` and `Example_Reverse_Correlation_pRF.json` read
as `LoadModelJson` would (Octave has no `readstruct`: `jsondecode`, numeric arrays as
rows, the function strings through `str2func`), with `Aperture_File =
'apertures/aps_Bars'`. The CF model is `Name = 'CF_Rcp'`, `SeedRoi = 'labels/seed_v1'`,
`Template = 'template/lh_benson'`, and SamSrf's defaults.

| Run | Function | Model change | ROI |
| --- | --- | --- | --- |
| `prf_coarse` | `samsrf_fit_prf` | `Coarse_Fit_Only = 1` | `roi_full` |
| `prf_nm` | `samsrf_fit_prf` | none (Nelder-Mead) | `roi_fine` |
| `prf_hj` | `samsrf_fit_prf` | `Hooke_Jeeves_Steps = [0.01 0.01 0.01]` | `roi_fine` |
| `prf_hrf` | `samsrf_fit_prf` | `Hrf = Inf` (concurrent HRF fit) | `roi_tiny` |
| `prf_css` | `samsrf_fit_prf` | `Compressive_Nonlinearity = 1` | `roi_tiny` |
| `rc_hull` | `samsrf_revcor_prf` | none (convex hull) | `roi_full` |
| `rc_fit` | `samsrf_revcor_prf` | 2D Gaussian `Prf_Function`, `Param_Names {x0, y0, Sigma}`, `Scaled_Param [1 1 1]`, `SeedPar_Function @(V) [V(2:3); V(4)/(2*sqrt(2*log(2)))]`, `R2_Threshold = 0.1` | `roi_fine` |
| `cf_hull` | `samsrf_revcor_cf` | none (`Fit_pRF = 0`, convex hull) | `roi_full` |
| `cf_summary` | `samsrf_revcor_cf` | `Fit_pRF = -1` | `roi_full` |
| `cf_fit` | `samsrf_revcor_cf` | `Fit_pRF = 1` (Nelder-Mead) | `roi_tiny` |
| `cf_smooth` | `samsrf_revcor_cf` | `Smoothing = 3` | `roi_fine` |

Per run, after loading the map file the analysis saved and `samsrf_expand_srf`:

| File | Content |
| --- | --- |
| `<run>.json` | `name`, `analysis` (`prf`, `rc`, `cf`), `model` (the saved `Model`, after the run: function handles as `func2str` text in Octave's spacing, non-finite numbers as `"Inf"`/`"NaN"`), `roi_label`, `seed_label`, `out_file`, `values`, `raw_values`, `rows`, `vertices` (134260), `mver` (0-based analysed vertices in label order), `data_file`, `raw_rows`, `raw_file`, `seconds` (wall time of the analysis call). Absent fields are `null` |
| `<run>_data.f64` | `rows` x 134260: `Srf.Data`; 0 outside the ROI, as `samsrf_expand_srf` leaves it |
| `<run>_raw.f64` | `raw_rows` x 134260: `Srf.Raw_Data` (`rc_hull`, `rc_fit`) |
| `<run>_<out_file>` | The map file itself, renamed so the next run cannot load it (Octave binary format) |

A run that errors inside SamSrf writes `<run>.json` with `name`, `analysis`, `model`
(as given), `roi_label`, `seed_label`, `error`, `error_identifier`, `error_stack` and
`seconds`, and no maps.

`values` per run on X001: the `prf` runs give `nR^2`, the parameters (plus `Exponent`
for `prf_css` and `RLat`, `ULat`, `RDisp`, `UDisp`, `AmpRat` for `prf_hrf`), `Beta`,
`Baseline`, `Noise Ceiling` and `R^2` (`samsrf_normr2` moves raw R² to the last row
after zeroing it where the noise ceiling is <= 0, and puts R² / noise ceiling first).
`rc_hull` keeps the reverse-correlation names `R^2`, `x0`, `y0`, `Fwhm`, `Beta`, but
rows 2-4 hold the hull centroid and `sqrt(area) / (2 sqrt(2 ln 2))`; `Raw_Data` holds
the peak-based values.

Geometry checks:

| File | Content |
| --- | --- |
| `georoi.json` | `cases`: for the first three `seed_v1` vertices, `samsrf_georoi(v + 1, 20, Vertices, Faces)` as `vertex`, `steps`, `vs` (0-based, sorted) and `ds`. Immediate neighbours of `v` get distance 0, like `v` itself |
| `convexhull_cases.json` | `cases`: hand-made point sets through the lines of `samsrf_cfparam_loop`'s positive subfield (`unique(..., 'rows')`, `delaunay`, `samsrf_clusterroi(peak, R, max / 2, tri)`, `polyshape`, `convhull`, `area`, `centroid`). Each has `points`, `statistic`, `unique_points`, `unique_order`, `unique_statistic`, `threshold`, `triangles`, `pos` (0-based into the unique points), `area`, `centroid` (`"NaN"` when empty). Cases: a Gaussian on a 5 x 5 grid, a square ring with a hole, an L, two blobs on a 6 x 6 grid (only the higher one is grown), 3 collinear points and 2 points |

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
| `samsrf_loadlabel.m` | SamSrf's goes through `Read_FreeSurfer`'s `textscan`, which misreads labels in Octave (below). Reads the label directly and returns its vertex indices + 1 in file order, which the analyses keep (`mver`, `Srf.SeedVx`). |
| `gcp.m` | No-op. The fine-fit loops call `gcp` in `try` and call `samsrf_error` (fatal) when it fails, so SamSrf needs the Parallel Computing Toolbox; `parallel.pool.DataQueue` still fails and is caught (no progress reports). |
| `verLessThan.m` | Octave's errors on `'matlab'`; `samsrf_fit_prf` asks `verLessThan('matlab', '7.13')`. Returns false (a current MATLAB), errors on any other name. |
| `save.m` | Octave writes neither `-v7.3` nor function handles in a MAT 5 file; maps the `-v7.3` flag of the analyses' `save` calls to Octave's lossless `-binary`, running the built-in in the caller's workspace. Every other call passes through. |
| `nansum.m`, `nanmax.m`, `nanmedian.m` | Statistics-package functions the container lacks (`samsrf_cfparam_loop`). `mad` and `prctile` are in core Octave. |
| `imresize.m` | Image package absent. Identity for a resize to the same size (100 x 100 apertures, `Rdim` 100), an error otherwise. |
| `delaunay.m` | Octave's 2-D `delaunay` (`delaunayn([x y], [])`), but returns `zeros(0, 3)` for fewer than 3 or collinear points, where MATLAB returns an empty triangulation and qhull errors. |
| `delaunayTriangulation.m`, `convexHull.m` | MATLAB classes in `samsrf_revcor_prf`'s convex hull branch: a struct with `Points`, and Octave's `convhull` (closed index loop and area), which errors on degenerate points as MATLAB's method does. |
| `polyshape.m` | Classdef with `area`, `centroid` and `convhull` (`samsrf_revcor_prf`, `samsrf_cfparam_loop`). Drops a closing repeat and consecutive duplicates; empty (area 0, centroid NaN) for fewer than 3 points or collinear points. `convhull` is the hull of the vertices, which is also the hull of MATLAB's simplified polygon. |

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

- `samsrf_cfparam_loop` initialises `fIimg` only for the convex hull (`FitPrf = []`)
  and assigns it only inside that branch of its `parfor`, but ends with
  `fSimg = [fSimg; fIimg]` for every `FitPrf`. In Octave, where `parfor` is a `for`,
  `Fit_pRF = -1` and `Fit_pRF = 1` therefore fail after the whole vertex loop with
  `'fIimg' undefined near line 192, column 17`, and `cf_summary.json` and
  `cf_fit.json` record that error instead of maps. MATLAB's `parfor` probably creates
  an unassigned sliced output as `[]`, which would make `fSimg` one row and the 6-row
  (summary) and 8-row (fit) `Data` of `samsrf_revcor_cf` add up; that was not verified
  (no MATLAB), and the harness does not patch SamSrf to find out.
- `samsrf_revcor_cf`'s `Fwhm` is `sqrt(sum(Area(R > mR / 2)))` with `R` over the seed
  vertices and `Area` over all 134260 vertices, so it sums the area of the first 2917
  mesh vertices, not of the seed vertices. Both MATLAB and Octave index that way.
- `Vx` in the CF maps is the 1-based peak seed vertex (`SeedVx(m)`).
- An Octave process killed by a signal writes `octave-workspace` in the working
  directory; it is not an output.

## Checks on the X001 outputs

`preprocess_average.f64` has no NaN; the noise ceiling is finite for 7013 of 7099
subset vertices, within [-0.74, 0.95], with a median of 0.77 over the ROI.
`preprocess_removenoise.f64` residuals are orthogonal to the global signal to 6e-15.
The HRF peaks are at 5 s for the canonical and de Haas kernels. `prf_errfun` on the
three chosen vertices returns errors between 0.82 and 0.95 for the fixed guesses.

The analyses on X001 (16-core host; `seconds` in each JSON is the time of the analysis
call alone):

| Run | Seconds | Result |
| --- | --- | --- |
| `prf_coarse` | 1311 (search space 979 of it) | 8 x 134260. All 6587 parameter sets finite; R² is 0 for the 204 vertices whose noise ceiling is <= 0 (`samsrf_normr2`), median 0.63; x0 and y0 within ±15 (the grid). 177 vertices have \|Beta\| > 100 (up to 2e13): their best prediction is nearly constant |
| `prf_nm` | 1096 | 8 x 134260. R² in [0, 1], 180 of 200 above 0.1; 18 fine fits rejected and zeroed (a scaled parameter beyond 2 x 9.5 or Sigma <= 0); \|x0\| up to 18.8, \|y0\| up to 15.3 |
| `prf_hj` | 555 | 8 x 134260. 197 of 200 above 0.1, none rejected |
| `prf_hrf` | 1042 | 13 x 134260. All 20 fitted, R² 0.85-0.92 |
| `prf_css` | 272 | 9 x 134260. All 20 fitted, R² 0.59-0.88, exponents 0.08-4.7 |
| `rc_hull` | 625 | 6 x 134260 plus 5 raw rows. No hull failed: all 6587 centroids finite |
| `rc_fit` | 197 | 7 x 134260 plus 5 raw rows. 193 of 200 pass `R2_Threshold`; 40 of those fail `KeepFit` (a scaled parameter beyond 1.5 x 9.5), so 47 columns are NaN |
| `cf_hull` | 2106 | 10 x 134260. x0 and y0 finite for 6579 of 6587 vertices; 8 have a degenerate positive subfield (NaN centroid, Centre 0) |
| `cf_summary` | 2121 | SamSrf error: `'fIimg' undefined near line 192, column 17` |
| `cf_fit` | 3418 | SamSrf error: the same |
| `cf_smooth` | 915 (distance matrix 828 of it) | 10 x 134260. All 200 vertices finite |

The analysis calls took 5098 s for the pRF and reverse-correlation runs and 13658 s
with the CF runs; the CF invocation of `run.sh analyses` took 8718 s wall time
(`wall_time.txt` holds the last invocation's). The coarse fit of `prf_coarse` peaks
near 15 GB in Octave (`corr` of 6587 time courses against 25920 predictions in one
block).
