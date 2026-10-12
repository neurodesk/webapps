---
"lcmodel": patch
"@neurodesk/lcmodel": patch
---

Messages that let a site diagnose a failure from the technical log alone:

- Every loaded dataset logs the parameters the fit relies on (sequence, field,
  TE, TR) and where its voxel is, or, for a GE P-file whose header does not
  make a voxel box, the header values it was built from.
- A DICOM folder without a spectrum is reported once, with what it is
  (series, description, modality, image type, storage class, pixel data).
- LCModel's diagnostics are explained: MYBASI 10 names the basis set's and
  the data's echo times; information lines say the fit is unaffected.
- Tissue correction logs the T1's data type, scaling and qform/sform codes,
  the browser and WebGPU adapter, and why a large T1 goes to the CPU.
