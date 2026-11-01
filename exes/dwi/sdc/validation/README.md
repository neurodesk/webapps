# sdc reference data

The SyN-SDC port (plan [`docs/architecture/dwi-sdc-plan.md`](../../../../docs/architecture/dwi-sdc-plan.md), issues #462-#466) is checked against native runs of sdcflows 2.17.1 with ANTs 52bc0ab on OpenNeuro ds005134 sub-01 (CC0).
The runs are `sdc/reference/` of the Hugging Face dataset `neurodeskorg/webapps`: 1329 files, 3.8 GB, at dataset commit `8520dbcafd737b895b9f5eb4f5f8149a82a3bb18`.
The prior that the port fetches is `sdc/prior/`: 9 files, 19.7 MB, at dataset commit `4c6c9e8efd8a1f4d110501f6fe30a10029bec570`.
The Q68 runs on the 1.2 mm and 1.6 mm SyN grids are `sdc/reference/grid-q68/`: 217 files, 648 MB, at dataset commit `e773666df37ccbeec6a6e075313cdfa2caca8f96`.
Each folder's `README.md` gives each file's purpose, the software and the licences.

`reference.manifest.json`, `prior.manifest.json` and `grid.manifest.json` pin the three folders at one dataset commit each, with each file's size and SHA-256, and name the subsets that later tests read:

| Subset | Files | Size | For |
| --- | ---: | ---: | --- |
| `inputs` | 44 | 277 MB | the full-brain input, the masks and the Q59 transforms |
| `field-fit` | 9 | 32.8 MB | #463: displacement conversion, fitting input, coefficients, field and mask |
| `reference-run` | 95 | 405 MB | #463: every intermediate of the double seed-1234 2 mm run and its DWI unwarp (`jacobian=True`) |
| `gate` | 430 | 1028 MB | #462: the three seeds, the native `--float 1` run, the SyN-only replays and `compare/` |
| `registration-gate` | 11 | 21.7 MB | #462 on the 1.2 mm grid: the replay's EPI reference, sidecar and masks, the end-to-end inputs, and the pinned drivers, comparison and environment |
| `determinism` | 126 | 180 MB | the seed-1234 runs repeated (byte-identical) |
| `grid-0.8mm` | 236 | 1829 MB | Q68: the stock 0.8 mm grid |
| `prior-variants` | 145 | 460 MB | Q59: full SyN prior and no prior |
| `sloppy` | 63 | 145 MB | Q69 |
| `slab` | 331 | 207 MB | #464, #465: the slab with the full T1w |
| `gre` | 32 | 11 MB | the report-only GRE field map |
| `docs` | 57 | 0.7 MB | README, index, numbers, scripts, environment |
| `prior` (`prior.manifest.json`) | 9 | 19.7 MB | the prior files and their notices |
| `replay-1.2mm` (`grid.manifest.json`) | 28 | 152 MB | #462: the 1.2 mm double seed-1234 run (replay inputs and reference) and the 1.2 mm `--float 1` fields |
| `grid-1.6mm` (`grid.manifest.json`) | 104 | 212 MB | Q68: the 1.6 mm runs |
| `docs` (`grid.manifest.json`) | 8 | 0.1 MB | the grid README, comparisons and scripts |

The measured numbers (seed spread, float against double, the Q68 and Q59 tests) are in `sdc/reference/README.md` and in section 6.2 of the plan.

## Fetch the data

```sh
export $(python3 exes/dwi/sdc/validation/fetch_reference.py /var/tmp/sdc-reference reference-run gate)
export $(python3 exes/dwi/sdc/validation/fetch_reference.py --folder prior /var/tmp/sdc-prior prior)
export $(python3 exes/dwi/sdc/validation/fetch_reference.py --folder grid /var/tmp/sdc-grid replay-1.2mm)
```

`fetch_reference.py` downloads only the named subsets (or `all`), checks each file's size and SHA-256, and does not download a verified file again.
It prints `SDC_REFERENCE` and `SDC_REFERENCE_SUBSETS`, `SDC_PRIOR` with `--folder prior`, or `SDC_GRID` with `--folder grid`.
`tests/reference.rs` checks displacement conversion and B-spline fitting on `field-fit`. Run `prepare-reference.mjs` after fetching to stage Float32 arrays through the shared JavaScript NIfTI reader. The `sdc-field-fit-reference` job in `.github/workflows/dwi-native.yml` requires these data and fails when they are missing. #462's registration gate on the 1.2 mm grid is `packages/hmc-registration/validation/sdc-gate/`; `.github/workflows/sdc-registration-gate.yml` fetches `registration-gate` and `replay-1.2mm` and requires its SyN-only replay.

## Re-pin

After an upload changes `sdc/reference/` or `sdc/prior/`, regenerate the manifest from the new commit:

```sh
python3 exes/dwi/sdc/validation/make_manifest.py reference <40-hex commit>
python3 exes/dwi/sdc/validation/make_manifest.py prior <40-hex commit>
python3 exes/dwi/sdc/validation/make_manifest.py grid <40-hex commit>
```

It reads the folder's `SHA256SUMS` and the Hugging Face tree at that commit, and fails when they disagree or when a subset pattern matches no file.
Subset patterns are in `SUBSETS` in that script; they are fnmatch globs in which `*` also crosses `/`.
