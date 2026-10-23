---
"mri2vid": minor
"@neurodesk/mri2vid": minor
---

Decode DICOM with dcm2niix (`@niivue/dcm2niix`) in the app and the command line. Compressed series (JPEG, JPEG-LS, JPEG 2000, RLE) now open, and Siemens mosaics are split by dcm2niix. Videos from DICOM that already worked are unchanged: dcm2niix's volume is laid back out in `MRI2vid.py`'s order, and the parity goldens still match bit for bit.
