# histo2mri

## 0.1.20261124

### Patch Changes

- 94d6e09: In a browser that offers WebMCP, every app registers tools with the browser's built-in AI agent. The agent can read what the app does, load any of its examples, use the files you already opened or ask you to choose others, run any operation and wait for its report, run it again with other settings without asking for the files again, move and restyle the viewer, and save an output of the run it names. When it needs a decision, it asks you in a dialog that says an AI agent is asking, and closing the dialog declines. It uses files you opened in the app only after you confirm them in a dialog that lists them. It loads data from a web address only after you allow that address, the viewer gets that one file and not a redirect, and for a ZARRo store the dialog names the store's address, under which ZARRo then reads without following a redirect. It changes only how the viewer shows images, never their data or position, it never removes what the viewer shows unless the dialog says so, and it cannot capture the viewer or save images from it. When you use the page yourself, a request the agent already started does nothing more, and before it uses its files or the results of its latest run again it asks you in one dialog that names them and what that run was given, its files and the address it read; declining releases them. A dialog names what it asks about as it is when it opens, and if that changes before you allow it, it shows the change in place and asks again; loading the same example again is no change, and on the third change the dialog closes as declined. Escape, the close button and a click beside the dialog all decline, also after it showed a change. After you allow it, the agent gets that run's report and outputs exactly as the run ended, even if the page shows other results by then. Opening other files, picking an example or a handoff releases them at once, so it never runs on or reports an earlier examination by mistake. It can read what the viewer shows at any time, as you see it. Each app's Privacy dialog says what such an agent can read and do. Browsers without WebMCP load none of this. No browser enables WebMCP by default yet: Chrome offers it behind a testing flag, and each catalogue can hold an origin trial token for its host.

  Automation contracts can mark a parameter `required: true`. Easy MP2RAGE's acquisition values, QSMbly's echo times and field strength and micro-sam's prompts are now required, and the desktop contract schema and NeuroFlow tools accept and publish the mark.

- Updated dependencies [dce0e7f]
- Updated dependencies [01e85d7]
- Updated dependencies [94d6e09]
  - @neurodesk/webapp-components@0.29.0
  - @neurodesk/greedy@0.10.20261124

## 0.1.20261119

### Patch Changes

- Updated dependencies [3db69e4]
  - @neurodesk/webapp-components@0.28.1
  - @neurodesk/greedy@0.9.20261119

## 0.1.20261113

### Patch Changes

- Updated dependencies [3ae3eb4]
- Updated dependencies [3f0eab6]
  - @neurodesk/webapp-components@0.28.0
  - @neurodesk/greedy@0.9.20261113

## 0.1.20261111

### Minor Changes

- 3beb743: Add Histology to MRI, a browser app that registers 2D histology sections (RGB or greyscale TIFF, PNG or JPEG) to an MRI volume. The user gives the slice axis and an approximate slice; the app samples the MRI on that plane, chooses the section's orientation, registers it rigidly and affinely with Greedy's NMI metric, optionally searches the plane's offset and tilt, and finishes with a Greedy stationary-velocity warp, all in one worker per run. It downloads the section warped onto the MRI plane (RGBA NIfTI), the sections drawn into the MRI grid, and Greedy-compatible affine and warp files in world coordinates, and overlays the result on the MRI with adjustable opacity. On a synthetic test (an MRI slice deformed by a known affine and smooth warp and re-coloured as H&E) the mean landmark error falls from 7.5 mm (12.5 voxels of 0.6 mm) to 0.21 mm (0.35 voxels); on the AHEAD example it falls from 6.8 mm (11.3 voxels) to 1.8 mm (3.0 voxels) at six manual landmarks, where the plane search and warp did not reduce it (the affine alone gives 1.7 mm).

  `@neurodesk/webapp-components/file-io/tiff` gains `readTiffImage`, which reads one greyscale or colour image (RGB with alpha dropped, white-is-zero inverted, palette, YCbCr, CMYK and CIELab converted to RGB) and refuses stacks, channel stacks and over-budget images before decoding. The new `@neurodesk/webapp-components/file-io/raster-image` reads PNG and JPEG sizes from their headers (walking JPEG segments) and decodes them to RGBA without EXIF rotation.

  `@neurodesk/greedy`'s `registerAffineGreedy` and `registerRigidGreedy` take an optional `initial` matrix, and the package exports its single-threaded build as `@neurodesk/greedy/wasm-single` for bundled workers.

### Patch Changes

- Updated dependencies [d643e8d]
- Updated dependencies [3beb743]
- Updated dependencies [a2675b9]
- Updated dependencies [8fca61b]
- Updated dependencies [83f5bb1]
- Updated dependencies [65a2e2b]
  - @neurodesk/webapp-components@0.27.0
  - @neurodesk/greedy@0.9.20261111

## 0.0.20261109

### Patch Changes

- Reject unflagged extra TIFF images and restore the previous viewer when MRI import fails or is cancelled.
