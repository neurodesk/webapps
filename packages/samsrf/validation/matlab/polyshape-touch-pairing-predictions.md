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
