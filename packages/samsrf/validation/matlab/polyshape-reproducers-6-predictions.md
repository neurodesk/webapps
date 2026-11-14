# Cloud 177 perturbation sweeps, round 6: pre-registration (#732)

Committed before `record_geometry(..., 'polyshape-reproducers')` records
`polyshape-reproducers-6.json` for the first time.

**Question.** On cloud 177's 1-minimal 6-point reproducer, MATLAB's default
drops the ring through input points 4 and 5 and two crossings (the sliver).
Clipper's `CleanPolygon` empties the sliver from 6 of 8 start and direction
choices; from point 5, where Clipper's union starts it, it keeps a triangle.
The experimental model keeps it. Which rule do MATLAB's drop/keep transitions
follow when the sliver's geometry changes?

**Input.** 1,212 polygons:
- the reproducer with one coordinate (y or x) of input point 5 or 4 replaced by
  `value = original + step * tolerance`, where step runs from -2.5 to +2.5 in
  steps of 0.05 and tolerance = 1e-8 * span;
- each sweep as drawn, translated by [0.37 -1.21], and scaled by 1e2.

The values are exact doubles in the spec.

**Competing hypotheses, per case.**
- H_X, the experimental model: the sliver is cleaned from the union's start.
- H_I, start-independent cleaning: the sliver, and with it point 4, survives
  only if every start and direction of Clipper's clean keeps a ring through
  point 4.
- H_S, the shipped model's hull.
- H_B, a region-level criterion (thickness or area) rather than vertex
  cleaning. It predicts drop/keep transitions where no clean regime changes;
  it has no per-case prediction.

`predictSurvival` in the spec holds H_X and H_I for every case: whether input
point 4, as perturbed, is a vertex of the default output. They differ on 405
cases. Both models' hulls are fixed by `predictionsSha256`.

The regimes, identical in all three copies (start of each regime, in
tolerance steps):

| Sweep | H_X / H_I survival regimes |
| --- | --- |
| point 5, y | -2.50: 0/0; -0.20: 1/0; +0.70: 0/0; +1.05: 1/1 |
| point 5, x | -2.50: 1/1; -0.50: 0/0; -0.30: 1/0; +0.15: 0/0; +2.15: 1/1 |
| point 4, y | -2.50: 1/1; -1.90: 1/0; +1.70: 0/0 |
| point 4, x | -2.50: 1/1; -2.45: 0/0; -0.80: 1/0; +1.00: 1/1 |

**Observables.** Whether point 4 (as perturbed) is among MATLAB's default
vertices, MATLAB's hull, and the `KeepCollinearPoints` vertices, holes and
rebuilt shapes the recorder always writes. Step 0 of the as-drawn copies
repeats the recorded reproducer (MATLAB dropped the sliver there).

**Decision rules, fixed now.**
- **H_X is refuted** by any case where H_X predicts survival and MATLAB drops
  the sliver, or the reverse; already true at step 0.
- **H_I is supported** for 177 only if it predicts MATLAB's survival on every
  case of all three copies. One counter-example refutes it.
- **H_B is supported** only if MATLAB's transitions fall inside regimes where
  H_I is constant, at the same step in all three copies.
- **Cross-host and repeat differences** are reported. A copy whose answer
  differs between hosts is excluded from every verdict and reported.

**Stop criteria and budget.**
- At most two MATLAB recordings in this round: this one, and only if its
  result calls for it, one follow-up.
- The follow-up is allowed only if some rule (H_I or H_B) explains every case
  of this round. It then tests that rule's predictions on hole formation in
  932's and 1607's 1-minimal reproducers, with predictions committed first.
- If no listed rule explains all cases, the round stops after this recording
  and reports the transitions observed.
- No model change ships from this round. A rule that explains the sweeps is
  tested on every earlier recording before being proposed for the
  experimental model.
