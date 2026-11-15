# Controlled touching regions and enclosed voids, round 7: pre-registration (#732)

Committed before `record_geometry(..., 'polyshape-reproducers')` records
`polyshape-reproducers-7.json` for the first time. Generator:
`polyshape_controlled.py`. Predictions digest: `e005370603ec92e0869cc8a102e68e2d7d9c73daefe7648b78647e8424685b4a`, verified by
`controlled_predictions_match_their_preregistered_digest` with no recording.

## Question

Does MATLAB's default `polyshape` merge regions that touch at single vertices
around an enclosed void, and keep the void as a hole (H_M, H_M1)? Or does it keep
the regions apart, as the experimental model does? And does a two-vertex contact
behave differently (H_M1 against H_M)? This round tests the touching-region
explanation of the 932 and 1607 holes on shapes built for it. It is not a
claim about MATLAB's internals.

## Inventory

148 base shapes with unique identities, 592 cases. Each case is one input ring.
All coordinates are exact doubles in the spec.

| Family | Shapes | Cases | Construction |
| --- | ---: | ---: | --- |
| pinwheel | 72 | 288 | k = 3, 4, 5, 6 tips touching at single corners around a regular k-gon void; void circumradius s x 2e-8 for s in 0.5, 1, 1.5, 2, 3, 5, 10, 100, 1e4; rotations 0 and sqrt(2)-1 rad |
| lens | 18 | 72 | two regions touching each other at two vertices around a quadrilateral void of width s x 2e-8, same s; both rotations |
| filled | 8 | 32 | the k-pinwheel without the backward void loop (void filled, s = 10); both rotations |
| gapped | 48 | 192 | the pinwheel with each corner split g x 2e-8 apart (g = 0.5, 2, 10; s = 3, 100), so neighbours do not touch; both rotations |
| reproducer | 2 | 8 | the 1-minimal reproducers of 932 and 1607 (relevance controls) |

Each shape is recorded in four variants: as drawn; reversed and started 3
vertices later; translated by [0.37 -1.21]; scaled by 1e2. The tolerance of
each drawn shape is 1e-8 x span, stored per shape (1.28e-8 to 2.31e-8), so s
and g are nominal multiples of 2e-8.

**Discovery and held-out cases.** The discovery set is 43 cases: the drawn copies of rotation-0 shapes with k = 3 or
5 (pinwheel, filled, gapped), of every rotation-0 lens, and of both reproducers.
The other 549 cases are held out: k = 4 and 6, rotated shapes, and the
reversed, translated and scaled copies. None of them was used to choose
anything.

## Competing predictions

The models are the experimental model (default), H_M (`experimental::Hypothesis`
merge_touching) and H_M1 (merge_touching, single_contact). Each predicts per
case the hull vertex set and its final rings, each with a hole flag and a vertex
set. All are frozen by the digest above.

Distinguishability: the experimental model and H_M differ on 496 cases, the
experimental model and H_M1 on 464, H_M and H_M1 on 50 (mainly lenses). The
hulls agree on these synthetic shapes, so the rings decide. Predicted topology,
as solid rings (s) and holes (h) per case:

| Family | Model | Predicted topology (cases) |
| --- | --- | --- |
| filled | experimental | 1s0h: 32 |
| filled | h-merge | 1s0h: 32 |
| filled | h-merge-single | 1s0h: 32 |
| gapped | experimental | 10s3h: 4, 11s0h: 8, 12s2h: 4, 3s0h: 32, 4s0h: 32, 5s0h: 40, 5s1h: 4, 6s0h: 40, 6s2h: 4, 7s0h: 10, 7s4h: 4, 9s0h: 10 |
| gapped | h-merge | 11s0h: 4, 1s0h: 86, 2s0h: 33, 3s0h: 5, 4s0h: 6, 5s0h: 10, 5s2h: 6, 5s3h: 2, 6s0h: 12, 6s5h: 4, 6s6h: 4, 7s7h: 8, 8s0h: 4, 9s0h: 8 |
| gapped | h-merge-single | 11s0h: 4, 1s0h: 82, 2s0h: 37, 3s0h: 5, 4s0h: 6, 5s0h: 10, 5s1h: 4, 5s3h: 2, 6s0h: 14, 6s2h: 4, 6s6h: 4, 7s7h: 8, 8s0h: 4, 9s0h: 8 |
| lens | experimental | 1s0h: 28, 1s1h: 20, 2s0h: 24 |
| lens | h-merge | 1s0h: 28, 1s1h: 44 |
| lens | h-merge-single | 1s0h: 28, 1s1h: 20, 2s0h: 24 |
| pinwheel | experimental | 3s0h: 72, 4s0h: 72, 5s0h: 72, 6s0h: 72 |
| pinwheel | h-merge | 1s0h: 36, 1s1h: 252 |
| pinwheel | h-merge-single | 1s0h: 36, 1s1h: 252 |
| reproducer | experimental | 3s0h: 4, 6s0h: 4 |
| reproducer | h-merge | 1s0h: 4, 1s4h: 4 |
| reproducer | h-merge-single | 1s0h: 4, 1s2h: 4 |

On the pinwheels:
- the experimental model predicts k separate tips;
- H_M and H_M1 predict one region with the void as a hole for s of 1 or more,
  and no hole at s = 0.5, where the void cleans away.

On the lenses, H_M predicts one region with a hole from s = 2; H_M1 predicts the
experimental model's two regions.

The gapped construction also leaves thin pieces between the split corners, so
the models predict many rings there. It stays a control for tips that do not
touch, and its cases are compared like the others.

## Observable and comparison (fixed now)

MATLAB's default polyshape boundaries (NaN-separated) with per-boundary
`ishole` flags, and its `convhull` vertices. The recorder also writes the
`KeepCollinearPoints` output; it is a separate configuration and is reported,
not used to judge.

A model agrees with MATLAB on a case when:
1. its hull vertex set equals MATLAB's, bit for bit; and
2. for pinwheel, lens, filled and gapped shapes, whose every vertex is an exact
   input point, the multiset of (hole flag, vertex set) of its rings equals
   MATLAB's, bit for bit;
3. for the reproducer controls, whose crossings are unsnapped by the model,
   the numbers of solid and hole rings equal MATLAB's, together with (1).

## Decision rules

- A model is **supported on a family** only if it agrees on every discovery case
  of that family.
- It is **supported overall** only if it also agrees on every held-out case of
  that family. One disagreement refutes it for that family.
- Every family and every model is reported. A model agreeing on no family is
  rejected.
- A rule that is supported on pinwheels and lenses does not change the
  experimental model by itself. It must then pass the full adoption checks of
  the README: all four regressions, every accepted original, held-out, probe,
  causal and reproducer case, and the CF gates.
- Same-host repeats must be exact. Cross-host differences in arrays are reported.
  The runner CPU models are recorded and reported as they are.

## Budget and stop

At most two dispatches:
- **Dispatch 1** records this round (the recorder also repeats rounds 1-6).
- **Dispatch 2** is allowed only if one model agrees with every discovery case of
  a family except across a single interval of s or g between two adjacent
  values, where MATLAB changes behaviour. Then a refinement sweep of that
  interval may be recorded, with its own predictions committed first.
- Otherwise the round stops after dispatch 1 and reports the model rejections.
