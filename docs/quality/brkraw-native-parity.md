# BrkRaw Browser vs Native Upstream Parity

This report documents bit-for-bit parity between the pure-JavaScript browser/Node implementation (`@neurodesk/brkraw` + `apps/brkraw`) and upstream **BrkRaw v0.5.7** (`BrkRaw/brkraw` commit `5664cef2fce186286586119ba55dc92fd3216b3e`, GPL-3.0-only; packaged in NeuroContainers as `vnmd/brkraw_0.5.7:20261012`).

## Scope

- **Supported ParaVision versions:** ParaVision **5.1** and **6.0.1** (verified on official `BrkRaw/brkraw-dataset` CC BY 4.0 datasets from the Center for Animal MRI, UNC at Chapel Hill). ParaVision 7 / 360 and DWI `.bval`/`.bvec` gradient export are deferred until dedicated fixtures pass parity.
- **Ported algorithms:**
  - JCAMP-DX parsing (`packages/brkraw/src/jcamp.js`): `$$` comments, `##key=(shape) data`, nested parentheses, `<...>` angle-bracket strings, `@N*(x)` repeat expansion, and array reshaping.
  - `2dseq` decoding (`packages/brkraw/src/image.js`): `_8BIT_UNSGN_INT`, `_16BIT_SGN_INT`, `_32BIT_SGN_INT`, `_32BIT_FLOAT` in `littleEndian` and `bigEndian` byte orders (zero-copy for aligned native-endian buffers), Fortran-order reshaping, spatial z-axis normalization (`ensure3dSpatialData`), multi-slice-pack splitting, uniform NIfTI header `scl_slope`/`scl_inter` scaling (matching upstream `brkraw` 0.5.7), and automatic `float32` scaling when per-frame slopes/offsets vary across 2D slices or 3D volumes, with a `1 GiB` pre-decompression byte cap (`MAX_CONVERT_BYTES`) and lazy `File.slice` ZIP extraction (`packages/brkraw/src/zip.js`).
  - Coordinate spaces (`packages/brkraw/src/affine.js`): `resolve_matvec_and_shape`, `ACQ_scaling_phase` and `coronal` voxel flips, `unwrap_to_scanner_xyz`, and `wrap_to_subject_ras` across `subject_ras`, `scanner`, and `raw` spaces with optional `Biped` / `Quadruped` and subject-pose overrides (using banker's round-half-to-even to match `numpy.round(..., decimals=6)`).
  - NIfTI-1 encoding (`packages/brkraw/src/nifti.js`): matches `nibabel.Nifti1Image(dataobj, affine)` + `brkraw.resolver.nifti.update` (`sform_code = 2`, `qform_code = 0`, populated quaternion & `pixdim[0]` `qfac`, `slice_code`, `xyzt_units = 10`).
  - Scrubbed JSON sidecar (`packages/brkraw/src/sidecar.js`): exports non-identifying BIDS-style MRI acquisition & geometry metadata while intentionally omitting subject name/ID/DOB, operator, acquisition/study dates, and DICOM UIDs.

## Parity results against real upstream `brkraw` v0.5.7

Verified across **16 test cases** spanning both `UNC_PV6.0.1_FLASH_TurboRARE_EPI.zip` (ParaVision 6.0.1, `Quadruped`, `Head_Supine`) and `UNC_PV5.1_BOLD-EPI_TurboRARE.zip` (ParaVision 5.1, `SubjectType = None` -> `Biped` fallback, `Head_Supine`, including asymmetric SD-rat 3D coronal whole-brain TurboRARE anatomy). Every case passed **bit-for-bit** on voxel payload SHA-256, 4×4 affine (`<= 1e-5`), NIfTI header fields (`qform_code`, `sform_code`, `slice_code`, `xyzt_units`, `scl_slope`, `scl_inter`, `pixdim[0..4]`), and 3D physical RAS landmark coordinates (`peakXyzMm` and intensity center-of-mass `comXyzMm` to `<= 1e-4 mm`):

| Case | ParaVision | Shape | Space / Override | Payload SHA-256 match | Center-of-mass RAS (mm) |
| --- | --- | --- | --- | --- | --- |
| `pv6_s3_r1_p0` (Localizer axial) | 6.0.1 | `256 × 256 × 1` | `subject_ras` | **exact** (`82ca359bf765`) | `[0.17, 0.00, -5.20]` |
| `pv6_s3_r1_p1` (Localizer sagittal) | 6.0.1 | `256 × 256 × 1` | `subject_ras` | **exact** (`14e7264c50ca`) | `[0.00, -0.13, -5.04]` |
| `pv6_s3_r1_p2` (Localizer coronal) | 6.0.1 | `256 × 256 × 1` | `subject_ras` | **exact** (`cf4402a5fb55`) | `[-0.09, -0.03, -5.00]` |
| `pv6_s6_r1_p0` (2D T2 TurboRARE) | 6.0.1 | `384 × 384 × 12` | `subject_ras` | **exact** (`81748cdb9779`) | `[0.01, 0.01, -5.08]` |
| `pv6_s7_r1_p0` (2D T2 FLASH) | 6.0.1 | `384 × 384 × 12` | `subject_ras` | **exact** (`ab7a97ab407a`) | `[-0.02, 0.04, -5.38]` |
| `pv6_s10_r1_p0` (3D FieldMap) | 6.0.1 | `64 × 64 × 64` | `subject_ras` | **exact** (`9b8a5ea7827f`) | `[-0.12, 10.05, -5.48]` |
| `pv6_s11_r1_p0` (2D EPI) | 6.0.1 | `80 × 80 × 12` | `subject_ras` | **exact** (`55535b41646a`) | `[-0.04, -0.04, -5.51]` |
| `pv6_s6_r1_p0` (`scanner`) | 6.0.1 | `384 × 384 × 12` | `scanner` | **exact** (`81748cdb9779`) | `[-0.01, -5.08, -0.01]` |
| `pv6_s6_r1_p0` (`raw`) | 6.0.1 | `384 × 384 × 12` | `raw` | **exact** (`81748cdb9779`) | `[-0.01, 5.08, -0.01]` |
| `pv6_s6_r1_p0` (override) | 6.0.1 | `384 × 384 × 12` | `Biped` / `Head_Prone` | **exact** (`81748cdb9779`) | `[-0.01, 5.08, -0.01]` |
| `pv5_s3_r1_p0..p2` (TriPilot 3 packs) | 5.1 | `256 × 256 × 1` (×3) | `subject_ras` | **exact** (all 3 packs) | exact `< 1e-4 mm` |
| `pv5_s4_r1_p0` (3D 2-echo FieldMap) | 5.1 | `64 × 64 × 64 × 2` | `subject_ras` | **exact** (`b736cf0aaff5`) | `[0.39, 3.01, 5.17]` |
| `pv5_s9_r1_p0` (3D coronal rat TurboRARE) | 5.1 | `144 × 144 × 64` | `subject_ras` | **exact** (`ab501e2812c3`) | `[-0.06, 8.86, 1.74]` |
| `pv5_s9_r1_p0` (override) | 5.1 | `144 × 144 × 64` | `Quadruped` / `Head_Prone` | **exact** (`ab501e2812c3`) | `[0.06, 1.74, 8.86]` |
| `pv5_s11_r1_p0` (4D BOLD-EPI, 900 reps) | 5.1 | `72 × 72 × 32 × 900` | `subject_ras` | **exact** (`18e24cf3e30a`) | `284.8 MiB` NIfTI-1 |

## Reproduction

```bash
# 1. Generate upstream BrkRaw v0.5.7 NIfTI-1 oracles across PV5.1 & PV6.0.1
python3 packages/brkraw/validation/generate_oracles.py \
  --pv6-zip "$TMPDIR/brkraw-spike/data/UNC_PV6.0.1_FLASH_TurboRARE_EPI.zip" \
  --pv5-zip "$TMPDIR/brkraw-spike/data/UNC_PV5.1_BOLD-EPI_TurboRARE.zip" \
  --out-dir "$TMPDIR/brkraw-oracles"

# 2. Verify @neurodesk/brkraw bit-for-bit parity in Node
node packages/brkraw/validation/parity.mjs "$TMPDIR/brkraw-oracles/oracles.json"
```
