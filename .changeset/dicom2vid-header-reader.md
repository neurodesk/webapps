---
"@neurodesk/dicom2vid": patch
---

Read a whole DICOM header with `parseDicomHeader`: the file meta group and every element before the pixel data, nested sequence items included, for any little-endian transfer syntax. Implicit VR elements can take their VR from a dictionary the caller supplies. Attribute tags (AT) now decode to numbers.
