# QSMbly real brain example

Verified 2026-09-18 against the OSF API and downloaded archive.

Use the first subject in `01_bids.zip` from **QSM DICOM testdata for QSMxT pipeline**, credited to Steffen Bollmann and Ashley Stewart. This is the brain acquisition used in Neurodesk's [ROMEO tutorial](https://neurodesk.org/edu/tutorials/phase_processing/unwrapping.html) and [SWI tutorial](https://neurodesk.org/edu/tutorials/phase_processing/swi.html). The SWI tutorial identifies it as a single-echo acquisition with TE 20 ms. The [OSF citation endpoint](https://api.osf.io/v2/nodes/ru43c/citation/) supplies the authors and dataset title.

## Source files

The [OSF file record](https://api.osf.io/v2/files/6168f5d41da1cb002107c725/) identifies version 2 of `01_bids.zip`, last modified 2022-06-17. Download it from [OSF](https://osf.io/download/ubf3m/).

| Property | Value |
| --- | --- |
| OSF project | `ru43c` |
| OSF file ID | `6168f5d41da1cb002107c725` |
| OSF file GUID | `ubf3m` |
| Archive bytes | `39083807` |
| Archive SHA-256 | `1576e55ba8628255d2d7372f5023265e934d3c74011718e858761e7d6f494e55` |
| Selected subject | `sub-170705134431std1312211075243167001` |
| Session and run | `ses-1`, `run-1` |

Within `01_bids/<subject>/ses-1/anat/`, select the magnitude and phase NIfTI files and their matching JSON sidecars. Their common filename prefix is `sub-170705134431std1312211075243167001_ses-1_run-1_`; the suffixes are `part-mag_T2starw.nii`, `part-phase_T2starw.nii`, and the corresponding `.json` names.

The archive contains a second subject. Do not mix its files with the selected subject. Preserve the selected NIfTI bytes, including spatial transforms and scaling, when adding gzip compression for hosting.

## Acquisition and phase encoding

Direct inspection of the selected files in the [source archive](https://osf.io/download/ubf3m/) gives:

| Property | Value |
| --- | --- |
| Scanner | Siemens Prisma_fit, syngo MR E11 |
| Protocol | `QSM_p2_1mmIso_TE20`, 3D gradient echo |
| Dimensions | 224 × 224 × 160 |
| Voxel spacing | 1 × 1 × 1 mm |
| `MagneticFieldStrength` | 3 T |
| `EchoTime` | 0.02 seconds |
| `RepetitionTime` | 0.025 seconds |
| Magnitude storage | int16, observed 0–1068, slope 1, intercept 0 |
| Phase storage | int16, observed 0–4095, slope 2, intercept −4096 |

The phase values after NIfTI scaling are −4096 to 4094, not radians. QSMbly's existing phase normalization must run before unwrapping. The sidecar also contains `EchoTime1: 0.02` and `EchoTime2: 0.015`; those fields do not establish a second input echo. Each component is one 3D volume, and the matching magnitude sidecar records `EchoTime: 0.02`. Use that 20 ms echo time, consistent with the Neurodesk tutorial.

Magnitude and phase have identical spatial transforms. Preserve their oblique orientation rather than replacing their affine matrices with an axis-aligned transform.

## Attribution and license metadata

The [OSF project record](https://api.osf.io/v2/nodes/ru43c/) reports `node_license: null`, and the archive's `dataset_description.json` contains no license field. Record the license as unspecified and retain the source link and author attribution. The tutorial's MIT license is not evidence of a license for this separate dataset. Do not substitute the archive's placeholder `Authors: ["ADD AUTHORS HERE"]` for the authors in the OSF citation.

The four selected inputs are hosted under `examples/qsmbly/real-brain-qsm` in the [Neurodesk webapps dataset](https://huggingface.co/datasets/neurodeskorg/webapps/tree/ee7566df698ad9b1d0cd1e8fe65ac9ccc671657f/examples/qsmbly/real-brain-qsm), together with provenance and file hashes. The app and offline inventories pin commit `ee7566df698ad9b1d0cd1e8fe65ac9ccc671657f`.

## Reproduction and verification

Run `python3 scripts/prepare-qsmbly-example.py` with `TMPDIR` on the storage volume. The script checks the upstream archive hash and prepares the four inputs and provenance outside the repository. It does not publish or modify the app manifest.

All four hosted files were downloaded at their pinned URLs and matched the manifest SHA-256 hashes. Decompression also reproduced the original archive members byte for byte. Both images contain finite values and have matching geometry; sagittal, coronal and axial slices were inspected.

The production QSMbly build, example import and cancellation/retry tests, manifest and version checks, desktop/phone interface audit, and scoped mobile suite passed. Desktop and phone screenshots were reviewed. The shared `test:interface-workflows` suite could not exercise its six other applications because their production bundles were absent from this worktree; it has no QSMbly workflow. QSMbly's own example smoke test covers the hosted import, masking, reconstruction and download.

The complete browser example smoke test passed with the real hosted inputs: phase-quality preparation, robust threshold masking, the default reconstruction pipeline, and a downloaded 224 × 224 × 160 susceptibility map containing finite, nonzero values. This checks workflow completion, not quantitative accuracy against a reference reconstruction.
