# convexHull area and pixel grid, round hull-area-1: pre-registration (#732)

Committed before `record_geometry(..., 'hull-area')` records
`hull-area-inputs.json` for the first time. Generator: `hull_area_design.py`.
Predictions digest: `14ec8549270429828f78c0c47276000d6b13237772553814d5bfdc481c06f567`,
recomputed from the committed inputs alone by `test_hull_area_design.py` with no
recording.

## Question

SamSrfAnalysis takes a reverse-correlation hull's `Fwhm` from
`[K, AV] = convexHull(delaunayTriangulation(txy))`, `sqrt(AV) / (2 sqrt(2 ln 2))`,
and its pixel grid from `meshgrid(linspace(-a, a, n), ...)`
(`samsrf_revcor_prf.m`). Two parts of the port are fitted, not identified:

1. **AV.** `delaunay_hull_area` gives MATLAB's `Fwhm` on 27 of the 42 double RC
   hull vertices of the pinned SamSrfAnalysis recording (`cli_rc_hulls.rs`,
   `FWHM_DIFFERS`). `Fwhm` passes through a square root, so those 42 values
   constrain AV only to an interval. This round records AV itself, MATLAB's `K`,
   its triangle list and the same on the hull's own vertices.
2. **Grid ends.** The port's symmetric `linspace` sets the ends to `-a` and `a`.
   Every recorded grid so far had `(n - 1) * (a / (n - 1)) == a`, so nothing
   recorded tests that.

Every model here is fitted to declared recordings. None is a claim about how
MATLAB is implemented.

## Inventory

344 point sets on 6 grids and 164 `linspace` calls, all exact doubles in
`hull-area-inputs.json`. A set is runs of MATLAB pixel indices (column-major, top
row first, as `xc(:)` and `yc(:)` list them) on its grid's listed coordinates,
optionally reversed. The recorder rebuilds each set's points from those
coordinates; `linspace` is never used to build an input.

| Family | Role | Sets | Pixels | Construction |
| --- | --- | ---: | ---: | --- |
| cli | discovery | 42 | 266-2,260 | the 42 double RC hull vertices' suprathreshold pixels (cli-reference.json, AMD host), as cli_rc_hulls.rs rebuilds them from MATLAB's courses |
| cli-reversed | discovery | 42 | 266-2,260 | the same, input order reversed |
| blob | discovery | 20 | 35-1,088 | one or two oriented bumps with pixel noise above a random threshold, on a = 9.5, 100 x 100 |
| small | discovery | 20 | 4-78 | the same with narrow bumps |
| blob | held out | 120 | 7-1,655 | the same on six grids: a = 9.5 and 10 (100 x 100), 6.25 (64 x 64), 12.3 (101 x 101), 3.7 (50 x 50), 8 (128 x 96) |
| blob-reversed | held out | 60 | 7-1,655 | every second held-out blob, reversed |
| small | held out | 40 | 4-87 | narrow bumps on the six grids |

`linspace(-a, a, n)`: discovery a in {9.5, 0.1, 0.3, 1.1, 2.3, 10, 12.7, 0.7} x n in
{1, 2, 3, 7, 20, 99, 100, 101} (64), held out a in {1.9, 3.3, 5.7, 6.1, 13.1, 0.2,
4.7, 7.9} x n in {4, 5, 19, 21, 50, 64, 128, 255} (64), and for each of 6 discovery
and 8 held-out halves the first three n below 300 (not already listed) where
`(n - 1) * (a / (n - 1)) != a` (12 and 24).

Seed 7320. Nothing in the held-out sets or grids was used to choose anything.

## Competing predictions

Recorded per set: `Dt.Points`, `Dt.ConnectivityList`, `K`, `AV`,
`polyarea(Dt.Points(K, :))`, `polyshape(Dt.Points(K, :))` with its vertices,
centroid and area, and `K` and `AV` again for
`delaunayTriangulation(Dt.Points(K(1:end-1), :))` (the corners variant).

**K.** The port's model (`delaunay_boundary`): the hull boundary with exactly
collinear points kept, counter-clockwise from the first input point on it,
closed. Frozen per set as a SHA-256 of the index list.

**AV, frozen values.** Sums run left to right in double precision.

| Model | AV |
| --- | --- |
| A0 | the port's `delaunay_hull_area`: corners counter-clockwise from the lexicographically smallest, cross products from that corner |
| A1 | shoelace `x(i) y(i+1) - x(i+1) y(i)` over the predicted K, closed |
| A2 | A1 with every point taken from K(1) |
| A3 | `polyarea`'s `(x(i+1) - x(i)) (y(i+1) + y(i))` over the predicted K |
| A4 | the fan from K(1): cross products of consecutive vertices from K(1) |
| A5 | A4 with each triangle's `abs(cross) / 2` summed |

On these sets A2, A4 and A5 agree everywhere, as they must for convex rings
(the shoelace terms from K(1) are the fan's). The other pairs differ on 83 to
99 of the 124 discovery sets and 111 to 184 of the 220 held-out sets. Every A model
predicts the corners variant's AV equal to the full set's, bit for bit, on all
344 sets.

**AV, frozen formulas on recorded inputs.** Code in `hull_area_design.py`, fixed
now, applied to what MATLAB records:

- A1k to A5k: A1 to A5 on the recorded K instead of the predicted one.
- T1 to T5 (`triangle_areas`): the recorded `ConnectivityList`, rows in order,
  `cross = (b - a) x (c - a)` (T1 to T3) or
  `xa (yb - yc) + xb (yc - ya) + xc (ya - yb)` (T4, T5); T1 and T5 sum the signed
  crosses and halve the absolute total, T2 and T4 sum `abs(cross) / 2`, T3 sums
  `abs(cross)` and halves.

A triangle sum predicts different AV for the full set and its corners variant
wherever the two triangulations differ.

Evidence before recording, through `Fwhm` on the pinned 42: A0 27, A1 18, A2,
A4 and A5 19, A3 16. No frozen A model is expected to survive the cli
discovery sets; the triangle sums are the hypothesis this round can test, and
the corners variant separates them from every hull formula.

**Grid.** For n = 1 all give `[a]`.

| Model | linspace(-a, a, n) |
| --- | --- |
| L0 | the port: `(2i - (n - 1)) * (a / (n - 1))`, ends set to `-a` and `a` |
| L1 | the same without setting the ends |
| L2 | `-a + (i * (2a)) / (n - 1)`, ends set |
| L3 | L2 without setting the ends |

L0 and L1 differ on 13 discovery and 30 held-out grids; L0 and L2 on 51 and 86.
Each prediction is frozen as the SHA-256 of the grid's value bits.

## Observable and comparison (fixed now)

Bit for bit, per AMD host's recording:

1. AV and the corners variant's AV, as recorded doubles;
2. K and the corners variant's K, as index sequences (start and direction
   included);
3. each grid's values;
4. reported, not decided: the polyshape centroid and area against the port's
   shipped `Hull::of_delaunay_boundary` chain, `polyarea` against AV, and
   `ConnectivityList` against the port's `Triangulation`.

## Decision rules

- An AV model is **supported on discovery** if it equals AV and the corners
  variant's AV on every discovery set. It is **supported** if it also does on
  every held-out set. One difference refutes it.
- The held-out sets are evaluated only after the discovery outcome is written
  down; only models supported on discovery are evaluated on them.
- The K model and each grid model are judged the same way.
- **Adoption.** The port changes its AV only to a supported model that it can
  compute from its own data with MATLAB's bits on every recorded set. For a
  triangle sum, that includes reproducing the recorded `ConnectivityList` order;
  until it does, nothing is adopted. Adoption must then pass every existing gate
  with no value lost: `cli_rc_hulls.rs` with `FWHM_DIFFERS` emptied, the revcor
  fixtures, and the CLI matrix comparison. The grid changes only to a supported
  grid model other than L0.

## AMD verification

Decisions use the recordings made on AMD CPUs, discovery and held out alike.
Same-host repeats must be exact (`compare-geometry.mjs`). A recording from
another CPU is compared with the AMD one and reported; it decides nothing. A
dispatch that records on no AMD CPU still counts toward the budget.

## Budget and stop

At most two dispatches for this round, counting any that fail.

- **Dispatch 1** records this round.
- **Dispatch 2** is allowed only if no model here is supported on discovery but
  a formula built from the discovery recording alone equals every discovery set
  (AV and corners variant), or a K or grid rule built the same way does. Its code
  and its predictions for a new held-out set, drawn with a new seed, are
  committed before dispatch 2; that set alone decides it.
- Otherwise the round stops after dispatch 1. Whatever is not supported stays a
  documented gap, and the port's AV and grid are unchanged.

## Addendum: dispatch 1 recorded on no AMD CPU

Written after dispatch 1 (run
[44216621796](https://github.com/neurodesk/webapps/actions/runs/44216621796),
commit 860f39a67) and before any model was evaluated on its recording.

Both runners were Intel CPUs, a Xeon Platinum 8573C (ubuntu-22.04) and a Xeon
6975P-C (ubuntu-24.04). Each host's two MATLAB processes agree exactly, and the
two hosts' 4,112 arrays are byte-identical. By the AMD rule this dispatch
decides nothing, and it counts as the first of the two.

This amendment supersedes the original stop rule, "Otherwise the round stops
after dispatch 1", after the CPU draw was known. The fresh held-out set below
limits that adaptation; this was not the original decision rule.

The rest of the round:

- Dispatch 1's recording is used only to build candidates. Anything built from
  it is built from its discovery sets and grids alone.
- **Dispatch 2** records this round again, unchanged, together with a fresh
  held-out set drawn with seed 7321 (`hull-area-inputs-2.json`). The code and
  predictions of every candidate built from dispatch 1 are committed, with their
  digest, before dispatch 2.
- Decisions use dispatch 2's AMD recordings under the rules above. A frozen or
  conditional model must hold on every discovery set, the original held-out
  sets and the fresh set. A model built from dispatch 1 is judged on the
  discovery sets and on the fresh set alone. Dispatch 1's recording is reported
  beside them.
- If dispatch 2 also records on no AMD CPU, the round stops undecided. Both
  recordings are then reported, and the port's AV and grid stay as they are.

Dispatch 1's discovery sets gave no new AV candidate: the searches for one are
in the round's results below, and none equalled every discovery set. The fresh
set is 40 blobs, 20 of them also reversed, and 20 small sets on the six held-out
grids, and 44 grids (12 whose last symmetric value is not `a`), all role
`fresh`. Its predictions digest, from `hull_area_design.py predict
hull-area-inputs-2.json`: `3a0966d7a1c9df424a2d16db9b0f6f77252d7e9fa514aa760f0542bb6a81c9d4`.

## Results

Dispatch 2 (run
[44229635416](https://github.com/neurodesk/webapps/actions/runs/44229635416),
commit d725a2d3a) recorded on an AMD EPYC 7763 (ubuntu-22.04), which decides,
and an Intel Xeon 6975P-C (ubuntu-24.04), which is reported. Both repeats were
exact, all 5,080 arrays are byte-identical across the hosts, and the 4,112 arrays
of the round's own inputs equal dispatch 1's. Pinned as
`hull-area-reference.json`; `hull_area_report.py check` reruns the judgement below
in CI.

Discovery, AMD host (124 sets, 76 grids), sets or grids that differ:

| Model | Differ | Model | Differ |
| --- | ---: | --- | ---: |
| K | 0 | L0 | 0 |
| A0 | 86 | L1 | 13 |
| A1, A1k | 105 | L2, L3 | 51 |
| A2, A4, A5 and their k forms | 94 | T1 to T3 | 121 |
| A3, A3k | 103 | T4, T5 | 122 |

The discovery decision (SHA-256 `f8ee7fcb60c28021ddfdb5e6d79df792cff8259c7f2ecf9e4de50fb7fd1e1d49`)
named K and L0. On the held-out and fresh sets (300 sets, 132 grids) neither differs
anywhere, on either host. Both are supported:

- **K** is the port's model: the exact boundary with collinear points kept,
  counter-clockwise from the first input point on it.
- **L0**: R2023b's `linspace(-a, a, n)` is `(2i - (n - 1)) * (a / (n - 1))` with
  the ends set to `-a` and `a`. That holds on all 208 grids, 55 of them where the
  ends matter. The port's grid already is this.

**AV is not identified.** Every frozen and conditional model was refuted on
discovery. What the recording shows about it:

- It depends on the hull alone. It equals the corners variant's AV on every
  set, so it is not a sum over the triangulation of the points.
- It depends on where the listing starts. Reversing the input order changes it
  in 31 of 42 CLI sets.
- On discovery it is within 5 ULP of the exactly rounded area, and exact in 48 of 124. Held-out sets reach 7 ULP.
- It equals `polyarea` of the same vertices in 23 and the polyshape area in 48.

The searches on dispatch 1's discovery sets reached at most 73 of 124: clockwise
from K(1), cross products from the box centre, summed in order. They covered
start, direction, term form, origin and summation order, triangle sums over the
hull's own triangulation, and Qhull-style facet sums. So nothing could be frozen
for dispatch 2, and both dispatches are spent.

What follows for the port:

- The grid is unchanged.
- The convex-hull analysis keeps the previous grid and hull in production. On
  MATLAB's grid its `Fwhm` loses a value the previous grid matched, through this
  unidentified area (`revcor_prf::pixel_grid`).
- `cli_rc_hulls.rs` holds MATLAB's grid and the stored-order hull as a diagnostic,
  with the 15 `Fwhm` values that still differ.
