# Touch-vertex pairing (H_T), predictions before evaluation (#732)

Written 2026-11-16 before any H_T variant was run. Evaluation uses only the pinned
recordings (geometry, probe, causal, reproducer rounds 1-7); no MATLAB dispatch.

## Observation that motivates it

`polyshape_ordered_rings.py` compares MATLAB's recorded `Vertices` as ordered
cycles. On the 2,500 original point clouds the experimental model matches all
rings (cycles, edges, hole flags and containing solids) in 981, while its hull
matches in 2,456. In 770 the edge sets are equal but the cycles are not. At the
touch vertices of those 770, MATLAB's two rings are two solids whose pairing,
oriented with the region on the left, takes the most counter-clockwise turn
("LL ss", 16,915 vertices where the model differs); the model there has a solid
and a touching hole or two holes ("RR hs" 9,239, "RR hh" 7,310). Where MATLAB has
a hole at a touch vertex ("RR hs", "RR hh"), the model mostly agrees.

## Hypothesis

H_T: MATLAB's boundaries are the cycles traced with the region on the left taking
the most counter-clockwise turn at every vertex, each cycle then split at every
vertex it visits twice. This keeps filled sectors that meet at a vertex in
separate solids, and leaves a hole only where an unfilled face touches the same
cycle at one vertex (or other holes).

Two placements:

- H_T-post: re-pair the model's final rings only. Vertex sets and hulls cannot
  change.
- H_T-pre: re-pair the output of each union before it is cleaned, so the clean
  sees MATLAB's neighbours at touch vertices.

## Predictions

1. H_T-post turns at least 90 % of the "cycles"-stage polygons of every family
   into "equal", and changes no hull and no vertex set.
2. H_T-post changes no polygon already "equal".
3. H_T-pre is not predicted to fix the four regressions; it is reported for every
   family against the experimental model, with every newly lost hull listed.

## Decision rules

- H_T-post is accepted as MATLAB's ring representation for the families where
  prediction 1 holds and 2 holds everywhere; any polygon it breaks is listed.
- H_T-pre is a candidate correction only if it loses no hull the experimental
  model matches on any recording and gains at least one; otherwise rejected.
- No production code changes from this round.

## Addendum, written after the first H_T run and before H_NS was run

First H_T results (ubuntu-22.04): H_T-pre loses hulls on several families and is
rejected by the rule above. H_T-post fixes 749 of the 770 "cycles" point clouds,
2,790 strip pairs and 537 bisection polygons without changing a hull, but turns 5
previously equal point clouds (485, 1278, 1399, 1935, 1993) and 4 round-7 cases
into "cycles": at their touch vertices MATLAB keeps a solid and touching holes
where the counter-clockwise rule splits solids. Prediction 2 fails, so H_T-post
is not accepted as stated.

H_NS-post: unite the model's final rings again with Clipper 6.4.2's union with
`StrictlySimple` off (the flag's four effects: no type-3 join at scanbeam tops,
collinear points removed in `FixupOutPolygon`, no `DoSimplePolygons`) and split
every output ring at each vertex it visits twice. If MATLAB's pairing is the
non-strict sweep's, H_NS-post keeps those 5 clouds and 4 cases equal and fixes at
least as many "cycles" polygons as H_T-post. It is judged by the same rules as
H_T-post (no hull or vertex-set change allowed, no equal polygon lost).

## H_G, the hull on its own grid (written before H_G was run)

H_NS-post changed no polygon of reproducer rounds 1-7 (identical to the
experimental model), so it does not explain MATLAB's pairing.

The ordered comparison also separates a later stage: polygons whose rings equal
MATLAB's in every observable (cycles, edges, hole flags, containing solids) but
whose hull differs. Reproducer rounds 4 and 5 have 124 and 130, round 1 has 2 and
the held-out probe clouds 9. In 251 of those 256 reproducer cases the final
vertices span less than the input, and MATLAB's hull mostly has one vertex more
than the model's.

H_G: MATLAB's `convhull(shape)` is `polyshape` of the convex hull of
`shape.Vertices`, so its grid and tolerance come from the span of the final
vertices, not of the input. The model snaps the final vertices (input coordinates,
survivors unchanged) to that grid, takes their integer hull and cleans it with
that tolerance.

Predictions: H_G turns at least 200 of the 256 reproducer cases above into hull
agreement, and on every recording loses no hull the experimental model matches.
Decision: H_G is a candidate correction of the experimental model only if it
loses no hull on any recording; it is then also run against the production model.

## H_G outcome and H_G2 (written before H_G2 was run)

H_G gains 393 hulls (reproducer round 4 +206, round 5 +176, round 1 +2, held-out
probe +9) and loses 88 (round 4 -26, round 5 -61, held-out near-collinear cloud
490). By the rule above it is rejected. Of the losses, 27 are polygons whose
rings already equal MATLAB's in every ordered observable, so H_G's hull
construction itself is wrong there; of the gains, 253 are such polygons.

H_G2: `convhull(shape)` is the model's own `polyshape` of the convex hull of the
final vertices: the hull (in input coordinates, counter-clockwise from the
lowest-then-leftmost vertex) goes through the whole model again, on the grid of
its own span, with Clipper's union deciding where the clean starts. Predictions:
it keeps at least the 253 ring-equal gains and recovers at least half of the 27
ring-equal losses. Decision: same rule; any lost hull rejects it.

## H_G2 outcome

H_G2 gains 396 hulls and loses 23 (round 4 -8, round 5 -13, reproducer case 28,
held-out near-collinear cloud 490). None of the 23 had rings equal to MATLAB's;
among polygons whose rings equal MATLAB's it fixes 259 hulls, loses none and
leaves 6. The first prediction holds (253 ring-equal gains kept), the second
holds (none of H_G's 27 ring-equal losses remain). By the decision rule it is
rejected, because it loses accepted hulls; the experimental model is unchanged.
