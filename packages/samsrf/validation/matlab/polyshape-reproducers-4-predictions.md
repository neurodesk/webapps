# Cloud 932 reduction, round 4: pre-registration (#732)

Committed before `record_geometry(..., 'polyshape-reproducers')` records
`polyshape-reproducers-4.json` for the first time.

**Input.** The nine 16-point reproducers of cloud 932 (round 3, run 43526041360)
are the frontier. The round has 12,873 cases: every order-preserving subset
that deletes 1 to 4 points from a frontier member and was not recorded before.
They hold 15 (123 cases), 14 (789), 13 (3,154) and 12 (8,807) points, are stored
as bitmasks of 1-based indices into the cloud, and are not transformed.

**Competing predictions per case.**
- H_ship: MATLAB's `convhull` vertex set equals the shipped model's
  (`Hull::of_polygon`).
- H_exp: it equals the experimental Clipper model's.

Both models' hulls for every case are fixed by `predictionsSha256` in the spec.
That is a SHA-256 over each case's shipped and then experimental hull bytes
(`prediction_bytes` in `polyshape_reduce.py`), computed from the committed models.
Neither is used as MATLAB's answer. On 11,718 cases the two models' hull vertex
sets differ, so the recording decides between them there. On the other 1,155
they agree, and the recording can refute both.

**Decision rules, fixed now.**
- A case reproduces the regression when MATLAB's hull vertex set equals the
  shipped model's and differs from the experimental one's.
- A reproducer R is 1-minimal when every one-point deletion of R has been
  recorded and none reproduces.
- This round can certify 1-minimality only for reproducers of 13 to 16 points,
  whose deletions it contains. If the smallest reproducers have 12 points, a
  further round (`lookahead` from them) is needed.
- Same-host repeats must be exact. Cross-host differences are reported, not
  hidden; only identical hosts' arrays are pinned as one recording.

**Hold-out.** None of these cases is used to fit a model. Any later model
hypothesis is tested against this round together with the original, probe,
causal and earlier reproducer recordings, with its predictions written before
it is run.
