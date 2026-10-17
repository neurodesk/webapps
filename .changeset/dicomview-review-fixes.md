---
"dicomview": patch
---

Downloaded and displayed BIDS sidecars are anonymised by dcm2niix: they no longer carry the patient's name, ID or birth date.

Files without the DICOM preamble that start with their file meta group, including Implicit VR ones, and Deflated Explicit VR Little Endian files are now indexed and their headers shown.
