# Validation against FID-A

The Rust port is checked against FID-A itself running in GNU Octave (11.1 with
statistics 1.8.2).

* FID-A: https://github.com/CIC-methods/FID-A at 1eaa2075625745beb7632f608dc2947b73295309.
* Octave needs two local fixes to run FID-A's Siemens reader, applied to a copy of
  the checkout, never to FID-A: `read_twix_hdr.m` indexes the struct array that
  Octave's `regexp(..., 'names')` returns (FID-A assumes a cell array), and
  `version=='XA60'` comparisons become `strcmp(version,'XA60')` (the `==` form
  errors on the 2-character VB/VD/VE version strings). `octave-shims/` adds
  MATLAB's `contains`.
* `export_fida.m` writes a FID-A structure as `name.json` + `name.bin` for the tests.

## Processing (src/ops)

### Octave set-up

`fida_setup.m` puts the patched FID-A copy (`FIDA_OCT`, default
`$TMPDIR/fida/FID-A-oct`) on the path, then the shims:

* `octave-shims/nlinfit.m`, `statset.m`: statistics 1.8.2 has no `nlinfit` or
  `statset` (the only Octave `nlinfit` is in the GPL optim package, which is not
  installed and needs compiled parts). The shim is the Levenberg-Marquardt
  algorithm MATLAB's `nlinfit` documents, written for this port and identical
  step for step to `src/ops/nlinfit.rs` (forward-difference Jacobian with step
  `eps^(1/3)*beta`, `lambda` from 0.01, x0.1 on success, x10 until the SSE does
  not rise, stop on `TolX`/`TolFun`/`MaxIter`). So the reference and the port
  run the same optimiser; what the comparison tests is everything else. MATLAB's
  own `nlinfit` also has robust fitting and error models (unused by FID-A); the
  optim `nlinfit` uses an SVD-based LM with different step control and would
  converge to the same minima within `TolX` but along different paths.
* `octave-shims/padarray.m`: the image package is not installed; op_zeropad only
  uses `padarray(x, n, 'post')`.
* `octave-shims/noplot/`: no-op `figure`, `plot`, `waitbar`, ... so FID-A's
  plotting (op_rmbadaverages, mapVBVD's waitbar) runs headless.
* One more FID-A fix, needed only by `ref_ops.m` (run it with
  `FIDA_OCT` pointing at a copy with the fix): Octave parses
  `phamp = fid_temp'\fid';` in op_removeWater.m and op_HSVDfit.m as
  `fid_temp' \ fid'` with the wrong operand shapes ("matrix dimension mismatch");
  the line becomes `fid_temp_h = fid_temp'; fid_h = fid'; phamp = fid_temp_h\fid_h;`.

### Regenerating the references

```
export FIDA_TEST_DATA=$TMPDIR/fida/testdata      # receives ops/...
cd exes/fida/validation
octave-cli ref_pipelines.m                        # ops/ge_press, ops/special, ops/special_single (~1.5 GB)
FIDA_OCT=<copy with the op_removeWater fix> octave-cli ref_ops.m   # ops/single_ops
octave-cli ref_mega.m                               # ops/siemens_mega
PHILIPS_MEGA=<dir> octave-cli ref_mega_philips.m   # ops/philips_mega (Osprey's sdat/MEGA/sub-01)
cd .. && FIDA_TEST_DATA=... cargo test --release
```

`FIDA_EXAMPLES` (default `/home/ubuntu/src/mrs/FID-A/exampleData`) is FID-A's
example data. The inputs to the Rust tests are the structures FID-A's own
readers load (`raw`, `raww`), exported by these scripts, so the ops are tested
independently of the Rust readers. Without `FIDA_TEST_DATA` the reference tests
print a notice and pass.

* `pressproc_det.m`, `specialproc_det.m`: `run_pressproc_auto` and
  `run_specialproc_auto` with the random draws fixed exactly as
  `src/ops/pipeline.rs` fixes them (PRESS: tmax 0.25 s, 1.6-4.0 ppm; SPECIAL:
  tmax 0.2 s, 1.8-4.2 ppm) and figures/report/file output removed; they export
  every intermediate structure and a `values.json` of coil phases and weights,
  per-pass bad-average metrics and removals, per-average frequency and phase
  corrections, phases, referencing shifts, SNR and linewidths.
* GE PRESS: `GE/sample01_press/press/P17920.7` read with `io_loadspec_GE(...,1)`
  and conjugated, as `run_pressproc_GEauto` does (32 coils, 16 averages, 2 water
  frames). SPECIAL: `Siemens/sample02_special/special/specialDLPFC.dat` and
  `special_w/specialDLPFC_w.dat` (32 coils, 80 averages x 2 subspectra; water 4 x 2).
* `ref_ops.m`: the modes and arguments the pipelines do not use (coil modes
  `'h'`/`'gls'` and the self-referenced forms, op_alignrcvrs, op_combineRcvrs,
  op_rmbadaverages at another threshold and `'f'`, op_rmworstaverage,
  op_takeaverages, op_alignAverages `'a'` and with estimated tmax,
  op_alignAverages_fd `'n'`, op_freqAlignAverages, op_timerange, op_freqrange,
  first-order op_addphase, op_zeropad, op_filter, op_ampScale, op_complexConj,
  op_freqshift, op_autophase, op_ppmref, op_getSNR, op_getLW, op_removeWater,
  op_HSVDfit, op_ecc_klose, op_takesubspec, op_combinesubspecs `'summ'`,
  op_alignMPSubspecs `'o'`/`'i'`, op_alignISIS without averages, op_fourStepCombine
  modes 0-3 on four subspectra built from the SPECIAL water data).

### Single precision in FID-A

`io_loadspec_twix` returns single-precision FIDs, so FID-A's first SPECIAL
alignment (op_alignAverages on the coil-combined data) runs `nlinfit` in float32;
every later step works in double because op_alignAverages allocates its output
with `zeros`. The float32 fit is limited by rounding: against the same pipeline
in double it moves the cumulative drift by up to 0.052 Hz and 0.012 deg, ph0 by
0.0055 deg, and the final spectrum by 5.4e-4 relative. The port computes in
double throughout, so `ref_pipelines.m` casts the SPECIAL data to double for the
reference (`ops/special`) and keeps the float32 run as `ops/special_single`;
`tests/ref_special.rs` reports both. The GE reader returns double.

### Agreement

Relative error is max |Rust - FID-A| / max |FID-A| over all FIDs. "Steps"
tests feed each op FID-A's own input to that step; "pipeline" tests run the
whole Rust pipeline from the raw data.

GE PRESS (tests/ref_press.rs):

| quantity | agreement |
| --- | --- |
| coil phases / weights, op_addrcvrs, op_rmbadaverages (metric, removals), op_averaging, op_leftshift, op_zeropad + op_filter | exact (0 or < 1e-15 relative) |
| op_alignAverages of water ('n') | 1.6e-12 Hz, fids 1.1e-12 |
| op_alignAverages_fd pass 1 / 2 | 4.5e-9 / 1.9e-7 Hz, 3.4e-9 / 4.0e-6 deg; fids 1.9e-9 / 7.0e-8 |
| op_autophase ph0, op_ppmref shift | < 1e-9 deg, < 1e-9 Hz |
| pipeline: cumulative drift | 2.7e-8 Hz, 5.8e-7 deg (2 passes, as FID-A) |
| pipeline: final metabolite / water spectra | 1.4e-9 / 2.9e-13 |
| pipeline: unprocessed metabolite / water | 1.0e-9 / 3.1e-13 |
| SNR (843.0), NAA linewidth (2.84 Hz), water linewidth (1.90 Hz) | 1e-9 relative, 1e-9 Hz, 1e-11 Hz |

SPECIAL (tests/ref_special.rs, double-precision reference):

| quantity | agreement |
| --- | --- |
| coil phases / weights, op_addrcvrs (32 x 160 x 4096) | 2.8e-14 deg, 5.6e-17; fids 4.4e-16 |
| 4 alternating op_alignAverages / op_alignISIS passes | <= 3.2e-6 Hz, <= 1.3e-5 deg; fids <= 8.5e-10 |
| op_combinesubspecs, op_rmbadaverages (2 passes, averages 5, 60, 67 removed) | exact |
| op_alignAverages_fd ('n'), water op_alignAverages | 6.7e-9 Hz, 3.2e-8 deg; fids 5.6e-10 |
| pipeline: cumulative drift | 3.3e-6 Hz, 7.8e-7 deg (1 pass, as FID-A) |
| pipeline: final metabolite / water spectra | 2.0e-9 / 5.6e-11 |
| pipeline: unprocessed metabolite / water | 9.5e-10 / 1.1e-11 |
| SNR (650.3), NAA linewidth (4.26 Hz), water linewidth (5.80 Hz) | 2.5e-8 relative, 2e-10 Hz, 7e-11 Hz |

MEGA-PRESS (tests/ref_mega.rs, `megapressproc_det.m`):

| quantity | Siemens (FID-A, 32 coils) | Philips (Osprey, SDAT) |
| --- | --- | --- |
| reader input | twix, exact | `split_alternate` + `drop_empty_transients` vs `io_loadspec_sdat(..., 2)`, exact |
| pipeline: cumulative drift | 9.8e-8 Hz, 2.4e-6 deg | 8.9e-5 Hz in one transient, the other 293 <= 2.2e-6 Hz; 5.1e-5 deg |
| pipeline: difference / sum / subspectra / water | 2.4e-9 / 4.1e-10 / 6.1e-10 / 7.5e-10 | 1.7e-6 / 2.2e-7 / 2.3e-7 / 2.8e-12 |

The Philips data are single-channel and noisier per transient; one edit-ON
transient's fit stops 8.9e-5 Hz from FID-A's, and that transient's phase error,
averaged over 147, is the 1.7e-6 of the difference spectrum. The Philips test
gates at 1e-4 Hz and 1e-5 relative; the Siemens gates are unchanged. The test
also scrambles the Philips subspectra into every other storage layout (edit-ON
first, not inverted, both) and checks that the classification restores the
same input.

Individual ops (tests/ref_ops.rs): all shape and arithmetic ops, coil modes
(`'h'` exact, `'gls'` weights 9.4e-10, fids 3.2e-11), op_combineRcvrs,
op_rmworstaverage, op_takesubspec, op_combinesubspecs, op_fourStepCombine,
op_getSNR (2.4e-14 relative), op_getLW (1e-11 Hz) and op_ecc_klose agree to
< 1e-12; the alignment variants to < 4e-9 Hz and < 1e-7 deg (op_alignMPSubspecs
1.1e-9); op_removeWater finds the same 30 components and 9 water components
(ppm to 2e-10), model spectrum 8.7e-12, water-removed FID 1.4e-10; op_HSVDfit
model 1.4e-9, residual 1.5e-11.

The tolerances the tests enforce are looser: 1e-5 Hz and 1e-4 deg for fitted
drifts, 1e-6 relative for aligned or pipeline spectra, 1e-12 for exact ops. The
remaining differences are the optimiser's: nlinfit stops at `TolX = 1e-8`
relative to the parameters, and near convergence (a second drift pass, where
the corrections are ~0) rounding decides the last step.

### What FID-A does that the port does differently

* op_rmbadaverages `'f'` fails in FID-A (`'tmax' undefined`, in MATLAB and
  Octave); the port implements what the branch intends (whole spectrum after
  10 Hz broadening, no time window). There is no FID-A reference for it.
* op_ecc is interactive (asks for a time window, fits `splinefit`); the port
  provides op_ecc_klose (the plain Klose correction) as `op_ecc`.
* op_removeWater / op_HSVDfit take the leading singular subspace of the Hankel
  matrix from its Gram matrix instead of a full SVD (the poles depend only on
  that subspace); `model.fids` is the FID whose spectrum is FID-A's
  `model.specs` (FID-A stores the conjugated row there). They require a single
  spectrum (FID-A silently uses the first FID).
* GE and Philips MEGA-PRESS: FID-A's readers split alternate transients into
  subspectra only when told to (`subspecs = 2`), and `run_megapressproc_auto`
  assumes the Siemens layout (edit-OFF first, the two stored phase-inverted).
  `src/ops/editing.rs` decides from the data instead, as Osprey's
  `osp_onOffClassifyMEGA` does: NAA/Cr differing between alternate transients
  marks editing, the larger NAA is edit-OFF, and anti-correlated creatine marks
  inversion; it then brings the data to FID-A's layout. Empty transients (a
  Philips water reference padded with zero rows) are dropped before averaging.
  FID-A's own GE MEGA-PRESS sample (`P21504.7`) stores 8-transient sums whose
  edit states cancel (alternate frames agree to 0.4 %, in FID-A as in the port),
  so it is not detected as edited, and `run_megapressproc_GEauto` is not ported.
* Where FID-A asks the user (already left-shifted or zero-filled data, which
  subspectrum to phase), the port proceeds or takes an argument.
