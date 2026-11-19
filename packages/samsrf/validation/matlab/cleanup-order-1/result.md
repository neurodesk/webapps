# cleanup-order-1 result: undecided STOP

The single authorized [dispatch 44405417497](https://github.com/neurodesk/webapps/actions/runs/44405417497)
ran attempt 1 at reviewed commit `717eeabb80fafe7b7c0e73ee742dc90546c5e154`.
Its contract SHA-256 was
`6f79a4ea01412f74fa79d270fc49aef54dc9bc01ce92506be686eb2bc0a4af65`.
The unchanged paired evaluator returned exit 1:

```json
{"status":"undecided-stop","reason":"dyadic-concave: unexpected warning","production_approval":false}
```

Both jobs completed two fresh MATLAB processes. The actual hosts were AMD
EPYC 7763 and Intel Xeon 6975P-C. All 28 case records and their journals were
retained. Every new case recorded `MATLAB:polyshape:repairedBySimplify` in all
four processes; the exposed control also recorded that warning. The warning's
origin was not isolated to a particular operation. No warning was waived and
no model was accepted.

An independent parent audit verified the commit-bound source and contract,
artifact hashes, process identities, journals and literal cross-process array
equality. That evidence does not override the scientific STOP. Neither frozen
prediction entered production.

| Artifact | SHA-256 |
| --- | --- |
| `14474624381`, ubuntu-22.04 | `20ba23562f0405c73fb8ff10b8822e089f563db0dafd078a8b0e1dba4396b34d` |
| `14475375007`, ubuntu-24.04 | `07370a5263c52432ddb84c52eede1d9392e2861456b167c8aa8ef1d902429f44` |

The authorized budget is **1/1 exhausted, with zero retries**. The earlier
hull-area-1 budget remains exhausted at 2/2. These inputs have now been exposed
and cannot be described as blind holdouts. Any further recording requires a
separate reviewed proposal and authorization.

The frozen proposal remains in Git at the dispatch commit. Later synthetic
protocol tests seal temporary fixtures independently; they do not update this
scientific contract or authorize another execution.
