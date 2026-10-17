# @neurodesk/dicom2vid

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
