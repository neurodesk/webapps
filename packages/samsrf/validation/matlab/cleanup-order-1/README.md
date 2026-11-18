# cleanup-order-1: hull-anchor sequencing diagnostic

**Prepared for independent review. No recording is authorized yet.** This is a
new proposed round, with a planned ceiling of one paired-host dispatch. The
older `hull-area-1` round remains exhausted at two dispatches; none of its
history, decisions or inputs is amended here.

## Question and fixed predictions

Does `convhull(polyshape(P))` choose its initial boundary anchor before or after
removing collinear hull vertices? This concerns polyshape hull ordering, not
`delaunayTriangulation.convexHull` area or a universal ring-reconstruction rule.

The two models are frozen in `predictions.json`:

- `survivor_model`: reconstruct rings, compute a hull without collinear points,
  clean it, then select the first stored-shape vertex surviving on that hull.
- `preclean_model`: reconstruct the same rings, retain collinear boundary points,
  select the first stored-shape point on that boundary, orient clockwise, then
  apply the unchanged cleaner, retaining the anchor it returns.

The six new simple concave inputs include reversed, translated, decimal and
rotated controls. Five distinguish the complete hull order. The two decimal
cases also predict different centroid x bits: `3fb6c089dbe0d964` versus
`3fb6c089dbe0d965`. The rotated case must match both models. Predictions include
all shape, hull, centroid and area bits, not only those distinguishing bits.

The seven-point exposed control is `polygon_point_clouds:48` from the immutable
[geometry recording](../geometry-reference.json), archive SHA-256
`f54f4bfbc908595356ca28a9e16a18f88f9944411e27c036d4018e1dd033ddc0`.
Its first shape vertex is input 0, its first stored-shape vertex surviving on the
hull is input 1, and MATLAB's hull starts at input 2. The native start is input 4.
Choosing the initial boundary anchor before cleaning reproduces the control's
hull and estimate, but the native rings are also wrong: two versus MATLAB's
seven. `control.json` therefore carries the actual pinned MATLAB shape, hull
and estimate, with source-array hashes; the evaluator never uses the native
shape prediction to validate this control.

All earlier geometry, CF and 424 hull-area outputs were exposed during offline
analysis. The exposed control is not validation. The six drafted inputs have
not been evaluated in MATLAB in this work; they are not an independent blind
validation set for a fitted production algorithm. No additional model fitting
or adaptive inputs are permitted within this round.

The original draft `inputs.json`, `inputs.tsv`, `predictions.json` and
`predicted.tsv` are preserved byte for byte. Their historical `draft` text is
provenance, not an execution permission. This document and `contract.json`
define the committed protocol. The production base is
`36ac29932b9c1e214ae1ed765923a96c0818bb29`. `model-main.rs` and
`model-polyshape.patch` reproduce the original offline model from that base's
`exes/samsrf/core/src/polyshape.rs`; they are never linked into production.

A separate simple-input stored-order candidate gained 46,110 exact polygon
values with no losses and 17 CF replay/pipeline values per recorded host with
no losses. It changed **zero target production-matrix values**: all 48 map
files matched committed WASM `abbd6625e895a1ec7eee6bcd3eb03ae93b7b79a45ebdf16a42a90208a6908daa`
byte for byte. That candidate is not shipped or used as evidence that the
remaining production parity problem is solved.

## Budget and preselected hosts

Independent review of this committed proposal/tooling and explicit new budget
authorization are required before any dispatch. Planned maximum:

- One dispatch, two MATLAB jobs, each capped at 15 minutes.
- Requested runners: `ubuntu-22.04` and `ubuntu-24.04`.
- Required actual CPU classes: one `AuthenticAMD`/AMD and one
  `GenuineIntel`/Intel, both x86-64, in either runner-label assignment.
- Two fresh MATLAB processes per job, seven cases once per process: exactly
  fourteen case records per host, twenty-eight overall.
- Zero retries, reruns, replacement hosts or adaptive cases. Run attempts other
  than 1 are refused before MATLAB setup. A second dispatch is not authorized.

GitHub runner labels **do not guarantee CPU class**. Each process records
`lscpu`, BLAS/version/thread receipts, its PID and a process nonce. Two Intel
hosts, two AMD hosts, unknown hardware or missing receipts mean **undecided,
stop**. No output-dependent CPU selection or AMD-only acceptance is allowed.

MATLAB is pinned to R2023b Update 11, full version
`23.2.0.3097123 (R2023b) Update 11`, `GLNXA64`. The exact expected BLAS version
string is in `contract.json`. Requested controls match the existing recording
workflow. MATLAB has previously cleared `MKL_NUM_THREADS`; the observed receipt
explicitly permits `""` or `"1"` for that field and requires
`maxNumCompThreads == 1`. This is a receipt, not proof that every internal
operation obeyed a requested numerical policy.

## Recording and decision contract

The existing workflow's `probes` choice gains `cleanup-order-1`; it gains no
new dispatch input. A separate recording job uses the pinned MATLAB setup and
run-command actions without secrets or publication permissions. Other recording
routes and ordinary CI retain their behavior. No old recorder, default input,
production algorithm or WASM module changes.

The preparation step verifies all committed source hashes, the exact checkout
SHA and committed blobs (including the contract itself), base ancestry, the dispatch selector and requested environment. The receipt
binds the actual ASCII TSV byte hash, contract hash, source-file hashes, GitHub
run ID/attempt and requested runner. Each fresh MATLAB process rehashes those
files before computing any case. The two run-command steps are separate
processes; their PIDs and nonces must differ. There is no in-process repeat loop.

The evaluator is read-only. It requires exact object fields and case identities,
seven cases once in each process, real double arrays, integer dimensions and
counts, lowercase sixteen-digit IEEE-754 hexadecimal words, exact MATLAB
version/release, CPU/BLAS receipts and input/code hashes. It rejects duplicate
JSON keys, JSON NaN constants, unexpected records/files and malformed receipts.
The six new cases must be finite. Only the exposed control's recorded shape
separators may be nonfinite, exactly at their pinned bit patterns.

All compared array words are **literal hexadecimal identities**, including
signed zero and every NaN sign/payload. No anchor rotation, order normalization,
NaN canonicalization, ULP allowance or tolerance is applied. Same-host repeats
must also have identical warnings. Cross-host warning prose is retained but is
not compared; all array identities and bits are compared.

Decision sequence:

1. Validate both complete host recordings and distinct fresh-process receipts.
   Missing, malformed, wrong-version, wrong-hash or nonrepeating data stops.
2. Require the actual AMD/Intel pair from this one dispatch. A wrong pair stops.
3. Require the six new shape arrays to equal the frozen one-ring predictions.
   Otherwise the experiment did not isolate hull cleaning and stops.
4. Require the exposed control to reproduce its actual pinned MATLAB arrays,
   and require all arrays to agree across hosts. Any disagreement stops.
5. A model survives this diagnostic only if all six new hull arrays and all
   eighteen estimate words match it exactly on both hosts. Exactly one model
   must survive. Otherwise stop with an undecided result.

A host job reports `host-valid-pair-undecided`; this is never scientific
acceptance. Both artifact directories must be downloaded together and passed
to the paired evaluator. Its failure exit code and `undecided-stop` result
cannot be replaced by a successful per-host check or workflow checkmark.

Even a `diagnostic-supported` result is **not production approval**. Any later
production rule still needs all previous polygon/template/revcor/CLI cases in
both precisions and both hosts, per-value nonregression, independent readers and
review, and production-WASM validation. One lost exact value blocks adoption.

## Reproduction without evaluating new MATLAB cases

From this directory, run `python3 -m unittest test_contract.py`. The cases are
synthetic protocol fixtures built from frozen predictions; no MATLAB is called.
The parent Python test wrapper and package workflow-contract test run in normal
CI. `record_cleanup_order.m` has only been parsed by Octave during preparation;
no MATLAB compatibility or scientific outcome is claimed from that parse.

To reproduce the model output offline, extract the pinned base's polyshape
source to a scratch directory, apply `model-polyshape.patch`, copy
`model-main.rs` there as `main.rs`, compile with Rust 1.100.0, and run the binary
with this directory's `inputs.tsv`. Compare stdout byte for byte to
`predicted.tsv`. Scratch must use `$TMPDIR`, not `/tmp`.

After future review and authorization, the selector is `record_matlab=true`,
`probes=cleanup-order-1`, `include_matrix=false`; all other recording/release
selectors remain false or none. No invocation is made by this PR. Download the
two exact-head artifacts into a directory containing exactly `ubuntu-22.04/`
and `ubuntu-24.04/`, then run:

```sh
python3 evaluate.py pair RECORDINGS --commit EXACT_DISPATCH_SHA
```

Each source file's hash is listed in `contract.json`; the exact contract byte
hash is recorded in both process receipts. The dispatch commit seals the
contract itself without a circular self-hash. Tests and the workflow are part
of the source hash inventory. Freeze a reviewed head before recording; changing
code, models, inputs, predictions or decisions after observation requires a
new proposal and does not consume an extra attempt under this budget.

## Preparation history

On 2026-11-18 the offline draft fixed these inputs, two models and predictions
without new MATLAB output. Parent review requested a strict evaluator, concrete
AMD/Intel host classes and fresh-process repeats. This implementation preserves
the four original input/prediction files byte for byte and adds those protocol
checks. The original prediction JSON SHA-256 remains
`1d0b2f35f62c85ee5d01d5d798f61ba9e0b27be247066d8c49e1018890e0b090`.
The model patch uses zero context to avoid whitespace-only patch lines; applying
it reconstructs the identical draft model source and identical output TSV.
No recording has occurred, and no scientific model has been refitted here.
