# Cloud 932 reduction, round 5: pre-registration (#732)

Committed before `record_geometry(..., 'polyshape-reproducers')` records
`polyshape-reproducers-5.json` for the first time.

**Input.** Round 4 (run 43564016762, both hosts byte-identical, same-host repeats
exact) found 517 reproducers of cloud 932. Two 13-point ones are certified
1-minimal: (1 2 3 4 5 6 7 8 9 12 15 16 17) and (2 3 4 5 6 7 8 9 10 12 14 15 17).
There are also 302 twelve-point reproducers, whose deletions were not recorded.
Those 302, taken from recorded verdicts only, are this round's frontier. The
round has 12,897 cases: every order-preserving subset that deletes 1 or 2
points from a frontier member and was not recorded before, with 11 (2,709) and
10 (10,188) points.

**Competing predictions per case.** As in round 4:
- H_ship: MATLAB's hull vertex set equals the shipped model's.
- H_exp: it equals the experimental model's.

Both are fixed by `predictionsSha256`. The models' hull vertex sets differ on
9,326 cases and agree on 3,571.

**Decision rules, fixed now.** They are round 4's:
- A case reproduces when MATLAB's hull equals the shipped model's and not the
  experimental one's.
- A reproducer is 1-minimal when all its one-point deletions are recorded and
  none reproduces.

This round can certify 12- and 11-point reproducers. If 10-point reproducers
exist, their 1-minimality stays open: rounds stop here by budget, not because
the minimum is reached.

**Hold-out.** As in round 4: none of these cases fits a model.
