# `@neurodesk/brkraw`

Pure-JavaScript browser and Node converter for **Bruker BioSpin ParaVision** (`2dseq` + JCAMP-DX) preclinical MRI studies, porting the core decoding and affine resolution of **BrkRaw v0.5.7** (`BrkRaw/brkraw@5664cef2fce186286586119ba55dc92fd3216b3e`, `GPL-3.0-only`).

## Scope & contract

- **Inputs:** Bruker ParaVision study folders or `.zip` archives (ParaVision 5.1 and 6.0.1 verified against upstream `brkraw` 0.5.7). ZIP inspection reads only the central directory and JCAMP parameter files (`subject`, `acqp`, `method`, `visu_pars`, `reco`) via `File.slice` without loading raw `fid` or `2dseq` payloads until a scan/reconstruction is converted.
- **Decoding:** Supports `_8BIT_UNSGN_INT`, `_16BIT_SGN_INT`, `_32BIT_SGN_INT`, and `_32BIT_FLOAT` in `littleEndian` and `bigEndian` byte orders (zero-copy for aligned native-endian buffers), Fortran-order reshaping, spatial z-axis normalization (`ensure3dSpatialData`), multi-slice-pack splitting, uniform header `scl_slope`/`scl_inter` scaling (bit-for-bit identical to upstream `brkraw` 0.5.7), and automatic `float32` scaling when per-frame slopes/offsets vary across 2D slices or 3D volumes. Enforces a pre-decompression `1 GiB` memory limit (`MAX_CONVERT_BYTES`) and a `16 MiB` JCAMP entry cap.
- **Orientation & spaces:** Full port of `resolve_matvec_and_shape`, `ACQ_scaling_phase` and `coronal` voxel flips, `unwrap_to_scanner_xyz`, and `wrap_to_subject_ras` across `subject_ras` (default), `scanner`, and `raw` spaces with optional `subject_type` (`Biped` / `Quadruped`) and `subject_position` overrides.
- **Outputs:** NIfTI-1 (`.nii` / `.nii.gz`) with matched `sform` affine (`sform_code=2`, `qform_code=0`, matching BrkRaw 0.5.7) and a scrubbed BIDS-style JSON sidecar that omits identifying subject, operator, date, and UID fields.
