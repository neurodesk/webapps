---
---

Remove the `@niivue/dcm2niix` declarations from BrowserQC, Deface and dwi2trx. All three import DICOM conversion only through `@neurodesk/runtime-support/dcm2niix-client`, which declares the package. Each app's production build is byte-identical, and DICOM import still converts in the built app and in the development server. No locked package version changes.
