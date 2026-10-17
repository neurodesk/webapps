---
"@neurodesk/dicom2vid": patch
---

Read a whole DICOM header with `parseDicomHeader` (async): the file meta group and every element before the pixel data, nested sequence items included, for any little-endian transfer syntax. A Deflated Explicit VR Little Endian dataset is inflated first. `headerBytes` gives the file offset of the pixel data. Implicit VR elements can take their VR from a dictionary the caller supplies. Attribute tags (AT) now decode to numbers.

A file without the 128-byte preamble that opens on its file meta group is now read in the transfer syntax that group names, by `parseDicom` too, instead of as Explicit VR Little Endian.

A prefix cut inside the header of an Explicit VR long-VR element (OB, OW, SQ, UN, UT and the like) now ends the parse as truncated instead of throwing a RangeError.
