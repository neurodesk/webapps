---
"@neurodesk/dicom2vid": patch
---

Read a whole DICOM header with `parseDicomHeader`: the file meta group and every element before the pixel data, nested sequence items included, for any little-endian transfer syntax. Implicit VR elements can take their VR from a dictionary the caller supplies. Attribute tags (AT) now decode to numbers.

A prefix cut inside the header of an Explicit VR long-VR element (OB, OW, SQ, UN, UT and the like) now ends the parse as truncated instead of throwing a RangeError.
