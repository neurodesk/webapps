---
"dwi2trx": patch
"@neurodesk/webapp-components": patch
---

Failures of actions started from the interface (fiber colour, display mode, FA floor,
the vector previews and generator, loading files) now appear in the status bar and the
technical log instead of being lost as unhandled rejections. A tensor fit or tracking
run whose input was replaced is logged without overwriting the newer input's status.
Files chosen while the viewer is still starting no longer fail with
"Cannot access … before initialization". Tensor maps and streamlines are unchanged.

`@neurodesk/webapp-components` declares types for its `./file-io/nifti` export and adds a
typed `./file-io/download` export, so TypeScript apps can import them without `allowJs`.
