# deconvolution

## 0.1.20261124

### Patch Changes

- 94d6e09: In a browser that offers WebMCP, every app registers tools with the browser's built-in AI agent. The agent can read what the app does, load any of its examples, use the files you already opened or ask you to choose others, run any operation and wait for its report, run it again with other settings without asking for the files again, move and restyle the viewer, and save an output of the run it names. When it needs a decision, it asks you in a dialog that says an AI agent is asking, and closing the dialog declines. It uses files you opened in the app only after you confirm them in a dialog that lists them. It loads data from a web address only after you allow that address, the viewer gets that one file and not a redirect, and for a ZARRo store the dialog names the store's address, under which ZARRo then reads without following a redirect. It changes only how the viewer shows images, never their data or position, it never removes what the viewer shows unless the dialog says so, and it cannot capture the viewer or save images from it. When you use the page yourself, a request the agent already started does nothing more, and before it uses its files or the results of its latest run again it asks you in one dialog that names them and what that run was given, its files and the address it read; declining releases them. A dialog names what it asks about as it is when it opens, and if that changes before you allow it, it shows the change in place and asks again; loading the same example again is no change, and on the third change the dialog closes as declined. Escape, the close button and a click beside the dialog all decline, also after it showed a change. After you allow it, the agent gets that run's report and outputs exactly as the run ended, even if the page shows other results by then. Opening other files, picking an example or a handoff releases them at once, so it never runs on or reports an earlier examination by mistake. It can read what the viewer shows at any time, as you see it. Each app's Privacy dialog says what such an agent can read and do. Browsers without WebMCP load none of this. No browser enables WebMCP by default yet: Chrome offers it behind a testing flag, and each catalogue can hold an origin trial token for its host.

  Automation contracts can mark a parameter `required: true`. Easy MP2RAGE's acquisition values, QSMbly's echo times and field strength and micro-sam's prompts are now required, and the desktop contract schema and NeuroFlow tools accept and publish the mark.

- Updated dependencies [dce0e7f]
- Updated dependencies [94d6e09]
  - @neurodesk/webapp-components@0.29.0

## 0.1.20261119

### Patch Changes

- Updated dependencies [3db69e4]
  - @neurodesk/webapp-components@0.28.1

## 0.1.20261113

### Patch Changes

- Updated dependencies [3ae3eb4]
- Updated dependencies [3f0eab6]
  - @neurodesk/webapp-components@0.28.0
- 37be3c2: Refuse a computed PSF for voxels over ten Airy radii or depths of field, such as a millimetre-scale MRI, with a message instead of running WebAssembly out of memory.
- Updated dependencies [37be3c2]
  - @neurodesk/deconvolution@0.2.1

## 0.1.20261111

### Minor Changes

- d643e8d: Add Deconvolution, a microscopy app that sharpens one widefield or confocal stack in the browser with Richardson-Lucy, optionally regularised by total variation (Dey et al. 2006), using a theoretical Gibson-Lanni PSF for the objective or a measured bead stack. It reads TIFF, OME-TIFF, ImageJ TIFF and NIfTI with their voxel size, and downloads the deconvolved stack as calibrated TIFF and NIfTI with the PSF used. `@neurodesk/deconvolution` holds the Rust core as committed WebAssembly: its Richardson-Lucy equals scikit-image's to 2e-14 and its PSF equals adaptive quadrature of the Gibson-Lanni integral to 2e-7 and psfmodels within 8e-5. The shared TIFF reader (`@neurodesk/webapp-components/file-io/tiff`) now reads an ImageJ 8-bit palette stack as intensity, the grey sample of grey + alpha pages and inverted WhiteIsZero integers, skips reduced-resolution pages, follows OME TiffData plane mapping (refusing planes in other files, and taking an interleaved RGB or grey + alpha channel, which OME counts as several in SizeC, as one page per plane), leaves a plain TIFF's page axis unknown rather than calling its pages time points, and `imagejDescription` describes a calibrated z stack.

  Refuse a NIfTI whose decoded image is over the limit from its header, before inflating it, bound decompression against a header that understates its data, reject oversized source files before reading them, and check cancellation around input decoding.

### Patch Changes

- Updated dependencies [d643e8d]
- Updated dependencies [3beb743]
- Updated dependencies [a2675b9]
- Updated dependencies [8fca61b]
- Updated dependencies [83f5bb1]
- Updated dependencies [65a2e2b]
  - @neurodesk/deconvolution@0.2.0
  - @neurodesk/webapp-components@0.27.0

## 0.0.20261109

### Patch Changes

- Reset manual PSF size overrides for automated deconvolution so results depend only on automation inputs and parameters.
