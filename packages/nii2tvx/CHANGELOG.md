# @neurodesk/nii2tvx

## 0.3.20261010

## 0.3.20261009

## 0.3.20261007

### Minor Changes

- f075aab: Add the `disconnectome` command line. It scores a NIfTI lesion against the ENIGMA Symmetric or HCP1065 atlas with the app's WebAssembly query core and writes the app's TSV download byte for byte. Atlases come from the pinned manifest with SHA-256 checks on every load and an offline mode. A lesion off the MNI152 1 mm grid is refused with the app's SYNcro advice. Portable Linux x64, Windows x64 and macOS arm64 archives bundle a private Node runtime and both atlases. Each archive must reproduce the native `nii2tvx` table for every example lesion and atlas before release. The app now takes its table name and grid refusal from `@neurodesk/nii2tvx/disconnectome`.

## 0.2.20261004

## 0.2.20261003

## 0.2.20260930

## 0.2.20260928

## 0.1.20260928

## 0.1.20260924

## 0.1.20260923

### Patch Changes

- c8a0be2: New app: Disconnectome scores which white-matter bundles a lesion disconnects, intersecting the lesion with a population tractography atlas in WebAssembly and drawing the damaged bundles coloured by a viridis ramp over their damage. Two atlases are selectable, the 65-bundle ENIGMA Symmetric atlas by default and the 87-bundle HCP1065 atlas; each downloadable TSV is byte-identical to the nii2tvx command-line tool for that atlas.
- Convert DICOM anatomy through the shared importer and preserve the previous inputs when an example is cancelled. Complete the offline atlas inventory. Reject truncated tract files and invalid TCK headers, honor TCK data offsets, and report allocation failures without corrupting WebAssembly memory. Add native, browser, and offline regression checks.
