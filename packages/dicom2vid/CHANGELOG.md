# @neurodesk/dicom2vid

## 0.5.20261018

### Patch Changes

- 67a5a8f: Read a whole DICOM header with `parseDicomHeader` (async): the file meta group and every element before the pixel data, nested sequence items included, for any little-endian transfer syntax. A Deflated Explicit VR Little Endian dataset is inflated first. `headerBytes` gives the file offset of the pixel data: Pixel Data, Float Pixel Data or Double Float Pixel Data, whichever comes first at the top level. Implicit VR elements can take their VR from a dictionary the caller supplies. Attribute tags (AT) now decode to numbers.

  A file without the 128-byte preamble that opens on its file meta group is now read in the transfer syntax that group names, by `parseDicom` too, instead of as Explicit VR Little Endian. A file with neither is read as Implicit or Explicit VR by its first element, the same way in both readers.

  A prefix cut inside the header of an Explicit VR long-VR element (OB, OW, SQ, UN, UT and the like) now ends the parse as truncated instead of throwing a RangeError.

## 0.5.20261017

## 0.5.20261016

## 0.5.20261015

### Minor Changes

- bf4a4ae: Add the `dicom2vid` command line for Linux x64, Windows x64 and macOS on Apple
  silicon. It reads NIfTI, MGZ and DICOM folders with the app's readers and
  series selection, renders the app's frames and encodes them with libvpx VP9,
  so its WebM matches the app's video in frame count, size, timing and key
  frames. The app's pipeline moved into the shared `@neurodesk/dicom2vid`
  package; its videos are byte-identical to before. The example volume now
  carries its SHA-256 pin.

### Patch Changes

- 744ecdf: Preserve distinct DICOM records with identical file names. Verify browser MP4 frame content and download checksummed video references from pinned Hugging Face URLs.
