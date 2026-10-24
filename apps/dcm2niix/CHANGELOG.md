# dcm2niix

## 0.2.20261024

### Patch Changes

- Updated dependencies [bd5f3a8]
  - @neurodesk/webapp-components@0.22.0
  - @neurodesk/runtime-support@0.9.12
  - @neurodesk/mri2vid@0.6.20261024
- Updated dependencies [941884c]
- Updated dependencies [a028e96]
- Updated dependencies [650ce5f]
- Updated dependencies [343c256]
- Updated dependencies [ba38bd9]
- Updated dependencies [941884c]
- Updated dependencies [ef05562]
  - @neurodesk/webapp-components@0.21.0
  - @neurodesk/mri2vid@0.6.20261024
  - @neurodesk/runtime-support@0.9.11
- Updated dependencies [3a7e5bb]
- Updated dependencies [72cbb8d]
  - @neurodesk/webapp-components@0.20.0
  - @neurodesk/runtime-support@0.9.10
  - @neurodesk/mri2vid@0.5.20261024
- Updated dependencies [3fc9cf2]
  - @neurodesk/webapp-components@0.19.1
  - @neurodesk/runtime-support@0.9.9
  - @neurodesk/mri2vid@0.5.20261024

## 0.2.20261022

### Patch Changes

- Updated dependencies [d32b485]
  - @neurodesk/webapp-components@0.19.0
  - @neurodesk/runtime-support@0.9.8
  - @neurodesk/dicom2vid@0.5.20261022

## 0.2.20261020

### Minor Changes

- 5c9c3b2: Add dcm2niix, a browser-only catalog app that converts one MRI examination at a time into a reviewed BIDS dataset. Accept files, folders and ZIP archives; review anatomical, diffusion and reverse phase encoding acquisitions; enter missing metadata; and download an organized BIDS dataset with an explicit identifying-metadata policy. Preserve separate acquisitions and image/gradient ordering, and link reverse EPI fieldmaps to their DWI targets. Include a pinned DICOM example, Philips native-reference checks and offline/interface workflow coverage.

### Patch Changes

- Updated dependencies
  - @neurodesk/runtime-support@0.9.7
- Updated dependencies
  - @neurodesk/runtime-support@0.9.5
  - @neurodesk/webapp-components@0.17.1
  - @neurodesk/dicom2vid@0.5.20261020
- Updated dependencies [14db080]

- Updated dependencies [03261d0]

- Updated dependencies [c865c0c]

- Updated dependencies [4b40da1]

  - @neurodesk/webapp-components@0.17.0
  - @neurodesk/dicom2vid@0.5.20261020
  - @neurodesk/runtime-support@0.9.4

- Updated dependencies
  - @neurodesk/webapp-components@0.17.2
  - @neurodesk/runtime-support@0.9.6
  - @neurodesk/dicom2vid@0.5.20261020
- Updated dependencies
  - @neurodesk/runtime-support@0.9.5
  - @neurodesk/webapp-components@0.17.1
  - @neurodesk/dicom2vid@0.5.20261020
- Updated dependencies [14db080]

## 0.1.20261020

### Patch Changes

- Updated dependencies [a36fde4]

  - @neurodesk/webapp-components@0.18.0
  - @neurodesk/runtime-support@0.9.5
  - @neurodesk/dicom2vid@0.5.20261020

- Receive the source DICOM series from DICOM View's shared Open in another webapp menu.

- Updated dependencies [14db080]

- Updated dependencies [03261d0]

- Updated dependencies [c865c0c]

  - @neurodesk/webapp-components@0.17.0
  - @neurodesk/dicom2vid@0.5.20261020
  - @neurodesk/runtime-support@0.9.4

- Updated dependencies [3f1d770]

- Updated dependencies [14b8248]

- Updated dependencies [d9718cd]

- Updated dependencies [d1fa022]

  - @neurodesk/webapp-components@0.16.3
  - @neurodesk/runtime-support@0.9.3
  - @neurodesk/dicom2vid@0.5.20261020

- Updated dependencies [4b40da1]

## 0.1.20261019

### Patch Changes

- Keep anatomical echo files attached to their converter acquisition when outputs are interleaved or an echo is excluded. Order runs by the converter's series number, preserve split acquisitions, and require echo time before exporting echo-labelled images. Refuse ambiguous duplicate echoes until acquisition labels distinguish them.

- Name the echoes of a multi-echo anatomical acquisition (dcm2niix `_e1`, `_e2`) with the BIDS `echo-` entity instead of `run-`. Repeated multi-echo acquisitions keep both entities.

- Updated dependencies [af2e8db]

- Updated dependencies [b3404ec]

  - @neurodesk/webapp-components@0.16.3
  - @neurodesk/runtime-support@0.9.3
  - @neurodesk/dicom2vid@0.5.20261019

- ac0b4e9: Keep anatomical filenames free of direction entities after review edits, preserve slice-timing orientation and technical encoding metadata in privacy-filtered exports, and reject classic DICOM phase/real/imaginary images. Refuse anatomical exports with attached diffusion gradients until the user reassigns the scan or clears them. Report missing or malformed automation assignments clearly and classify the app as Vite with WebAssembly.

- Updated dependencies [da2584b]
  - @neurodesk/runtime-support@0.9.2

## 0.1.20261018

### Minor Changes

- b67e4e9: Add dcm2niix (`dcm2niix`), a browser-only catalog app that runs dcm2niix on one MRI examination at a time. Accept files, folders and ZIP archives; review anatomical, diffusion and reverse phase encoding acquisitions; enter missing metadata; and download an organized BIDS dataset with an explicit identifying-metadata policy. Preserve separate acquisitions and image/gradient ordering, and link reverse EPI fieldmaps to their DWI targets.

  Share bounded conversion deadlines, NIfTI text removal, report-form styling and in-memory automation reset. Include a pinned DICOM example, Philips native-reference checks and offline/interface workflow coverage.

### Patch Changes

- Updated dependencies [7c0d201]

  - @neurodesk/webapp-components@0.16.2
  - @neurodesk/runtime-support@0.9.1
  - @neurodesk/dicom2vid@0.5.20261018

- a560d01: Invalidate confirmation while replacement gradients load, keep the latest edit when reads overlap, and block export until the edit settles. Reject materially non-unit b-vectors without changing the supplied values.

- Updated dependencies [b67e4e9]

  - @neurodesk/runtime-support@0.7.2
  - @neurodesk/webapp-components@0.15.1
  - @neurodesk/dicom2vid@0.5.20261018

- Updated dependencies [7c0d201]
  - @neurodesk/webapp-components@0.16.2
  - @neurodesk/runtime-support@0.9.1
  - @neurodesk/dicom2vid@0.5.20261018
