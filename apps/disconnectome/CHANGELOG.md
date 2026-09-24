# disconnectome

## 0.1.20260924

### Patch Changes

- Updated dependencies [39a9ea5]
  - @neurodesk/webapp-components@0.4.5
  - @neurodesk/nii2tvx@0.1.20260924

## 0.1.20260923

### Patch Changes

- Disconnectome gains the shared Support action along with every other webapp. It
  merged after the release that recorded the action for the other 25 apps, so this
  notes it against the same release date.
  - @neurodesk/nii2tvx@0.1.20260923

### Patch Changes

- c8a0be2: New app: Disconnectome scores which white-matter bundles a lesion disconnects, intersecting the lesion with a population tractography atlas in WebAssembly and drawing the damaged bundles coloured by a viridis ramp over their damage. Two atlases are selectable, the 65-bundle ENIGMA Symmetric atlas by default and the 87-bundle HCP1065 atlas; each downloadable TSV is byte-identical to the nii2tvx command-line tool for that atlas.
- Convert DICOM anatomy through the shared importer and preserve the previous inputs when an example is cancelled. Complete the offline atlas inventory. Reject truncated tract files and invalid TCK headers, honor TCK data offsets, and report allocation failures without corrupting WebAssembly memory. Add native, browser, and offline regression checks.
- Updated dependencies [c8a0be2]
- Updated dependencies
  - @neurodesk/nii2tvx@0.1.20260923
