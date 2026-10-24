# sdc reference data

The SyN-SDC port (plan [`docs/architecture/dwi-sdc-plan.md`](../../../../docs/architecture/dwi-sdc-plan.md), issues #462-#466) is checked against native runs of sdcflows 2.17.1 with ANTs 52bc0ab on OpenNeuro ds005134 sub-01 (CC0).
The runs are `sdc/reference/` of the Hugging Face dataset `neurodeskorg/webapps`: 1329 files, 3.8 GB, at dataset commit `8520dbcafd737b895b9f5eb4f5f8149a82a3bb18`.
The prior that the port fetches is `sdc/prior/`: 9 files, 19.7 MB, at dataset commit `4c6c9e8efd8a1f4d110501f6fe30a10029bec570`.
Each folder's `README.md` gives each file's purpose, the software and the licences.

`reference.manifest.json` and `prior.manifest.json` pin the two folders at one dataset commit each, with each file's size and SHA-256, and name the subsets that later tests read:

| Subset | Files | Size | For |
| --- | ---: | ---: | --- |
| `inputs` | 44 | 277 MB | the full-brain input, the masks and the Q59 transforms |
| `field-fit` | 9 | 32.8 MB | #463: displacement conversion, fitting input, coefficients, field and mask |
| `reference-run` | 95 | 405 MB | #463: every intermediate of the double seed-1234 2 mm run and its DWI unwarp (`jacobian=True`) |
| `gate` | 430 | 1028 MB | #462: the three seeds, the native `--float 1` run, the SyN-only replays and `compare/` |
| `determinism` | 126 | 180 MB | the seed-1234 runs repeated (byte-identical) |
| `grid-0.8mm` | 236 | 1829 MB | Q68: the stock 0.8 mm grid |
| `prior-variants` | 145 | 460 MB | Q59: full SyN prior and no prior |
| `sloppy` | 63 | 145 MB | Q69 |
| `slab` | 331 | 207 MB | #464, #465: the slab with the full T1w |
| `gre` | 32 | 11 MB | the report-only GRE field map |
| `docs` | 57 | 0.7 MB | README, index, numbers, scripts, environment |
| `prior` (`prior.manifest.json`) | 9 | 19.7 MB | the prior files and their notices |

The measured numbers (seed spread, float against double, the Q68 and Q59 tests) are in `sdc/reference/README.md` and in section 6.2 of the plan.

## Fetch the data

```sh
export $(python3 exes/dwi/sdc/validation/fetch_reference.py /var/tmp/sdc-reference reference-run gate)
export $(python3 exes/dwi/sdc/validation/fetch_reference.py --folder prior /var/tmp/sdc-prior prior)
```

`fetch_reference.py` downloads only the named subsets (or `all`), checks each file's size and SHA-256, and does not download a verified file again.
It prints `SDC_REFERENCE` and `SDC_REFERENCE_SUBSETS`, or `SDC_PRIOR` with `--folder prior`.
`tests/reference.rs` checks displacement conversion and B-spline fitting on `field-fit`. Run `prepare-reference.mjs` after fetching to stage Float32 arrays through the shared JavaScript NIfTI reader. The `sdc-field-fit-reference` job in `.github/workflows/dwi-native.yml` requires these data and fails when they are missing. #462 still needs the registration gate; `hmc-reference` is its workflow pattern.

## Re-pin

After an upload changes `sdc/reference/` or `sdc/prior/`, regenerate the manifest from the new commit:

```sh
python3 exes/dwi/sdc/validation/make_manifest.py reference <40-hex commit>
python3 exes/dwi/sdc/validation/make_manifest.py prior <40-hex commit>
```

It reads the folder's `SHA256SUMS` and the Hugging Face tree at that commit, and fails when they disagree or when a subset pattern matches no file.
Subset patterns are in `SUBSETS` in that script; they are fnmatch globs in which `*` also crosses `/`.
