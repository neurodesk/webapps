# volume_pol port

`src/volume-pol.js` ports EZminc `volume_pol` (minc-toolkit-v2 `EZminc/tools/volume_pol.cpp`,
version 1.1) as BISON calls it:

```
volume_pol <src> <target> --order 1 --noclamp --expfile <exp> --clobber <out>
```

`--source_mask` and `--target_mask` are also ported. `--min`, `--max`, `--hist`, `--joint`,
`--kl` and `--ks` are not.

## Algorithm

1. **Range.** Each image is read as double. Its range comes from `volume_min_max`, which skips
   NaN and infinite voxels. Without a mask, min and max start at voxel 0. With a mask, min starts
   at `1e10` and max at `-1e10`, and an `else if` means a voxel that sets a new maximum never
   updates the minimum. The first in-mask voxel therefore never sets the minimum. The port keeps
   this.
2. **Histogram.** 100 buckets over [min, max], `k = 100 / (max - min)`. Bucket centre
   `value(i) = i/k + min + 0.5/k`. Index `floor(k * (v - min - 0.5/k))`, clamped to 0..99. Each
   finite (and in-mask) voxel is split linearly between the two nearest centres. A voxel in
   bucket 99 goes all to bucket 99. Then each bucket is divided by the voxel count.
3. **Percentiles.** `for (pc = 0.001; pc < 1.0; pc += 0.001)`, accumulated in double. The port
   uses the same loop, so the count and the values of `pc` are the same. `find_percentile`
   finds the first bucket `i` where the cumulative sum reaches `pc` and the last non-empty bucket
   `j` before it, with `f = (acc - pc) / hist[i]`. For `i > 0` the result is
   `value(i)*(1-f) + value(j)*f + 0.5/k`. For `i == 0` it is `(value(0) + 0.5/k)*(1-f) + min*f`.
   If the sum never reaches `pc`, `i` is 100: the bucket read clamps to 99, `value(100)` does not.
4. **Fit.** A least-squares fit of the target percentile onto the source percentile, on the
   `Polinom_Mod` basis: term 0 is `x`, term 1 is `1`, term n is `x^n`. The normal equations are
   accumulated in double and solved with GSL `gsl_linalg_SV_decomp` + `SV_solve`. Order 1 is a
   slope through the origin, `c0 = Σxy / Σx²`. The port repeats GSL's one-unknown path
   (`(1/|a|) * ((a * (1/|a|)) * b)`), so the result is bit-identical. Order 2 gives
   `[slope, intercept]`. For order 2 and up the port uses a Jacobi eigen-solve, not GSL's
   Golub-Kahan SVD.
5. **Apply.** Every voxel is mapped, masks or not: `val = Σ basis(i, x) * c[i]` in double.
   `--noclamp` affects only this step and the expression. Without it, `val` is clamped to the
   target range of step 1 (the masked range if there is a target mask). NaN stays NaN and 0
   stays 0 at order 1. The output file takes the source's MINC storage type, so a float source
   gives `float32(val)`. `applyVolumePol` returns that `Float32Array`.
6. **Expression file.** `print_expression` writes C++ `ostream` default formatting (`%g`, 6
   significant digits): `c0*A[0]` for order 1, `c0*A[0]+c1` for order 2 (a negative intercept
   prints as `+-`), and `clamp(...,min,max)` (limits cast to float) without `--noclamp`. For
   order 3 and up upstream prints `c[i]*A[0]^i`, which is not the `Polinom_Mod` polynomial it
   fitted. The port keeps this. BISON uses the `_VP.mnc` image, which has the full-double
   coefficient, and does not read the expression file.

## Deliberate divergences

- The port refuses an image with no finite range (constant, all NaN, or an empty mask). Upstream
  divides by zero and writes NaN coefficients. A mask of the wrong size is an error in both.
- `--order 0` throws. Upstream changes it to 1.
- `formatG` rounds an exact 7-digit decimal tie away from zero. glibc rounds it to even. A fitted
  coefficient does not hit this.

## Measured agreement

The reference is minc-toolkit-v2 `volume_pol` 1.1 with system GSL 2.8. The coefficients were
read bit for bit from GSL's solution vector under gdb (`break gsl_linalg_SV_solve`). The outputs
are float MINC, read with `minctoraw -float`. The target is BISON's `Av_T1.mnc` converted to float
(193x229x193). The comparison harness was a scratch script and is not committed.

| Case | Source | Coefficients vs binary | Output voxels |
| --- | --- | --- | --- |
| order 1, `--noclamp` | 0.61·Av_T1 + 7 + N(0,3) | bit-identical (1.3309027659174468) | 8,530,021 / 8,530,021 identical |
| order 1, `--noclamp` | real T1 (ds007831 sub-PAM, 256x256x176) | bit-identical (0.3835113102994042) | 11,534,336 identical |
| order 1, clamped | real T1 | bit-identical, same expression | all identical |
| order 1, both masks | real T1, mask T1 > 60, target `Mask.mnc` | bit-identical (0.30461284258590143) | all identical |
| order 2, `--noclamp` | real T1 | max relative 4.1e-16 | all identical |
| order 2, both masks | real T1 | max relative 3.4e-14 | all identical |
| order 3, `--noclamp` | real T1 | max relative 3.4e-12 | all identical |

In every case the expression file text is identical. `test/volume-pol.test.js` holds the binary's
results for a 24x20x16 seeded phantom (order 1 with and without clamping, order 1 with both
masks, order 2). It checks the coefficients, the expression, and a sum and FNV-1a hash of every
output voxel.
