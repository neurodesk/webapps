# Mask and B1 extension policy

The Python reference pipeline (`mp2rage_t1.pipeline`) defines the application
preprocessing contract. Rust, the committed WASM, the browser and the portable
command line follow it. This policy resolves issue #181.

## What the method specifies

[Marques and Gruetter, 2013](https://doi.org/10.1371/journal.pone.0069294)
describe correcting MP2RAGE with measured B1. In the author's
[`T1B1correctpackageTFL.m`](https://github.com/JosePMarques/MP2RAGE-related-scripts/blob/7a4ba42864c399354d21e84fc11e3d8911428871/func/T1B1correctpackageTFL.m),
`brain` is a supplied image with zeros where no calculation is needed. If it
is empty, the code calculates everywhere. The header defines relative B1 as
one at nominal calibration and allows values from zero to two. The author's
[demo](https://github.com/JosePMarques/MP2RAGE-related-scripts/blob/7a4ba42864c399354d21e84fc11e3d8911428871/DemoForR1Correction.m)
assumes a B1 map already registered and interpolated to the MP2RAGE grid.

Neither this code nor the paper prescribes a UNI-derived brain mask or a
polynomial extrapolation clamp. We have no author validation of the exact
choices below. They are application heuristics, not corrections to the
published equations, and the clamp is not a physiological validity interval.

## No INV2

Prefer the INV2 magnitude image for masking. When it is absent, threshold
`abs(UNI - median(UNI))`, then use the same closing and hole-filling as INV2.
This preserves the existing Python behavior and uses distance from the UNI
background level instead of treating a combined UNI image as a magnitude
image. The heuristic can include background and fill ventricles; users should
inspect the maps. It is not a validated brain extraction method.

Missing INV2 is `None` in the Rust pipeline and an empty float32 slice at the
WASM boundary. The browser and portable CLI pass that absence through rather
than substituting UNI as INV2. This changes all no-INV2 result files through
the mask, including uncorrected T1 and B1 output.

## B1 field of view

The optional degree-three polynomial extension retains Python's 0.35 to 1.7
relative-B1 bounds. Both the fit sample eligibility and the extrapolated fill
use these bounds. Measured finite voxels are unchanged. The bounds restrict
an extrapolation heuristic; choosing them preserves the reference contract,
and does not assert that a measured B1 outside them is invalid. Smaller
coverage can make a polynomial unreliable even with a clamp.

The prior Rust bounds, 0.3 to 2.0, were a port mismatch. Results can change
when `extend_fov` is enabled and fit samples or extrapolated values reach these
interval differences. With INV2 and extension disabled the computation is
unchanged.

The clamp-reaching fixture also exposed Rust's ridge-regularized normal
equations, which differed from NumPy's unregularized minimum-norm fit by
0.31 ms in T1 and one UNI level. Rust now reduces the design matrix with
incremental QR and solves its small triangular factor with pure-Rust SVD,
using NumPy's machine-precision-times-matrix-size rank cutoff. This retains
bounded solver storage and handles rank-deficient measured planes. The
sparse-sample fallback averages the two central values for an even-sized
sample, matching NumPy's median. These changes can affect extension even
when neither clamp is reached.

## Independent checks

`tools/gen_cli_golden.py` calls the Python pipeline and writes every output
for absent INV2 with SA2RAGE and tfl, including non-convergence fallback.
It also generates a narrow measured B1 slab, with a linear field whose
extrapolation reaches both 0.35 and 1.7. The generator and release gate assert
that both endpoints occur. The native Rust parity test and portable CLI gate
compare all four output maps against these Python files, with the existing
0.1 ms T1, 1e-4 B1 and 1e-2 UNI tolerances. The gate additionally checks
geometry, parameters and equality to the web worker's WASM calls.
Independent NumPy component goldens cover a rank-deficient plane and the
even-sized sparse fallback, preserving measured values outside the clamp.
