# MKL's AVX512_E1 branch (Intel hosts): identification record

MATLAB R2023b on an Intel host runs MKL 2021.3's `AVX512_E1` branch, and its double
results differ from the AMD hosts' (`CNR auto`) that the shipped port follows. This folder
records how that branch's real double least squares was identified from existing
recordings, under pre-registered predictions, discovery and held-out sets and stop rules.
The resulting reference is the test-only crate `exes/samsrf/mkl-avx512`
(`samsrf-mkl-avx512`), gated by `exes/samsrf/mkl-avx512/tests/recordings.rs`. No new
MATLAB recording was made.

## Where the Intel host first departs

On inputs that are identical between the hosts, or between a host and the port:

- MATLAB's `zscore` (its `mean`, `sum` and `std`): on the constants-gamma-gemv recording
  (AMD EPYC 9V74, Intel Xeon 6975P-C, byte-identical inputs) the port's `zscore` of each
  host's own `detrend` output equals that host's `zscore` in every value, 255,495 on both
  hosts; where the two hosts' `detrend` outputs agree, their `zscore` outputs agree.
- `nanmean(Srf.Data, 2)`: from each reverse-correlation host's own courses the port's
  global signal equals the recorded one on the Intel host too (2,000 of 2,000 double).
- MATLAB's own `x' * y` below 51 elements, its HRF sums and `conv`: identical on both
  hosts of the numerics recordings.
- The first host-dependent arithmetic is MKL's: `detrend`'s solve (50,761 of 247,500
  Intel values at 250 samples equal the AMD arithmetic), `norm` (`dnrm2`, 1-2 ULP from the
  AMD order at 10 of 24 lengths on both Intel models) and `x' * y` from 51 elements.

The double global regression's residuals (`samsrf_removenoise`) therefore depend on
MKL's least-squares chain, not on MATLAB's z-score or mean.

## Pre-registrations

Each file was frozen before the data it names as held out were read; amendments and
results were only appended, so every frozen version is a byte prefix of the file:

| File | Version | Prefix bytes | sha256 of the prefix |
| --- | --- | --- | --- |
| `prereg-dnrm2.md` | original | 2,870 | `33951f693321505277413a3fdc455d74c3920e60332892a33b22e80161e970fd` |
| `prereg-dnrm2.md` | amendment 1 (correctly rounded family) | 4,199 | `1fde38f2c926df05f493082ba954aa147dfd42b492b00f6946f9109e0474e95d` |
| `prereg-chain.md` | original | 3,375 | `3ae1c9cf19492fedc7906949bd7e54f0174ac9c1154d4abbe1b23514a0b61667` |
| `prereg-chain.md` | amendment 1 (leading-entry update) | 4,258 | `faf936c6b0c2c9305fb417c0e0ac674630eac628f7c8d9eace0927b947e99093` |
| `prereg-chain.md` | freeze (amendment 2) | 6,610 | `a8e3bd0ce8a4993b0e7646e381cd76ad4acd75ac98b176cf4d4515e265185b66` |

`head -c 6610 prereg-chain.md | sha256sum` checks the freeze. The frozen model is
`chain.py` (sha256 `757823662d6ddc1d9d801c13a733c2cb709bb7833fc07883ccf10916a04d8809`,
also in `chain.frozen.sha256`), which `heldout_eval.py` verifies before it runs.

## Results

`dnrm2` (`prereg-dnrm2.md`): no candidate of the frozen lane-tree family reproduced the
24 discovery norms (the best 23; every candidate missed n = 13), so the held-out sets
stayed unread. On the discovery data, Intel's norms are the correctly rounded norm in all
24 cases (|error| at most 0.472 ULP); the AMD order is in 14. Amendment 1 froze the
correctly rounded norm before the held-out sets were read. Held out: R(1,1) of all 95 real
double kernel chains matches (with LAPACK's `dlapy2`), and 519 of the 520 Intel `corr`
values from 25 to 50 elements match. The last one is reproduced by the correctly rounded
dot product (MATLAB's pair tree is 0.878 ULP low there) or by either norm one ULP below
its correctly rounded value; the recording cannot tell which. By its own frozen rule the
norm is therefore not identified from `corr`. It entered the chain pre-registration below
as a switch, and the frozen chain, with the correctly rounded norm, passed both held-out
sets.

Least-squares chain (`prereg-chain.md`): with correctly rounded norms, a 16-lane `?gemv`
with fused accumulation and update, the 16-lane single-column and the paired grouped
`?ormqr` trees with fused updates and a fused leading entry, and a fused
back-substitution, every step of the 95 Intel chains and Q'Y and coefficients of the 190
eight-column solves matched (discovery). The frozen chain then reproduced, once:

| Held-out set | Intel host | Frozen chain | AMD arithmetic |
| --- | --- | --- | --- |
| `detrend` of the 1,485 constants-gamma-gemv direct cases | Xeon 6975P-C | 255,495 / 255,495 | 55,277 |
| double `samsrf_removenoise`, three revcor cases (21 courses, up to 1,500 rows) | Xeon 8370C | 42,000 / 42,000 | 4,844 |

`X * B` rounds both products and adds them, as on AMD; the fused alternative was refuted
on both held-out sets. The AMD controls reproduced both sets on the AMD host. After the
freeze, with no change to the model, the Rust reference also reproduced every recorded
course of the 134,257-134,260-vertex pipeline runs (Xeon 6975P-C, 70,500 values), the
revcor raw-file preprocessing and its global signal (Xeon 8370C, 187,000 values) and the
SamSrfAnalysis double `Srf.Y` (Xeon 8573C, 84,000 values).

Seen on discovery data only, not part of the reference: Intel's `dznrm2` is also the
correctly rounded norm (24 of 24 complex vectors on both Intel models; the AMD order 11).

## Reproducing

`PINS` holds the pinned recordings, each extracted by
`packages/samsrf/validation/container/download.py` into a folder named after its
reference (`numerics`, `numerics2`, `arithmetic-order`, `qr-reference`, `qr-kernels`,
`cgg`, `revcor-reference`).

```sh
python3 -I dnrm2_candidates.py "$PINS" discovery.json        # equals discovery-1.json
python3 -I dnrm2_family2.py "$PINS" family2.json             # equals family2-1.json
python3 -I chain_steps.py "$PINS" ubuntu-22.04-3 steps.json --grid
python3 -I fprev_tree.py "$PINS/qr-kernels/ubuntu-22.04-3" ormqr double 0 8 0 21,33,65
SAMSRF_HELDOUT_DUMP="$TMPDIR/heldout-inputs" SAMSRF_CGG_DIR="$PINS/cgg" SAMSRF_CGG_RUNS_DIR="$X001_RUNS" \
  SAMSRF_REVCOR_REFERENCE_DIR="$PINS/revcor-reference" \
  cargo test --release --manifest-path exes/samsrf/Cargo.toml -p samsrf-mkl-avx512 --test recordings write_held_out_inputs
python3 -I heldout_eval.py "$PINS" "$TMPDIR/heldout-inputs" heldout.json   # equals heldout-1.json
```

`X001_RUNS` holds `lh_uBars1.gii` and `lh_uBars2.gii`
(`packages/samsrf/validation/matlab/fetch_x001_runs.py`). The native workflow runs the Rust
gates on every recording above.
