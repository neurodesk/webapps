# stardist

## 0.2.20261124

### Minor Changes

- bdc9700: Add StarDist 3D (`3D_demo`) and the remaining official 2D pretrained models (`2D_versatile_he` for RGB H&E brightfield histology and `2D_paper_dsb2018`) alongside `2D_versatile_fluo`. Port StarDist 0.9.1's 3D tiling, continuous kernel/convex-hull and voxel-overlap 3D NMS, and polyhedron rasterization (`src/stardist3d.js`), add full-colour RGBA NIfTI display for H&E and 3-plane multiplanar NIfTI display for 3D stacks, add public-domain H&E skin histology and synthetic 3D examples, and validate every model's browser label TIFF and CSV table voxel/pixel-for-voxel against Python StarDist 0.9.1.

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

## 0.1.20261111

### Patch Changes

- 8fca61b: `@neurodesk/webapp-components/file-io/tiff` reads the planes of a 2D image TIFF (`openTiffPlanes`: RGB, palette as colour or as indices, multi-sample and one-page-per-channel images, pyramid levels and alpha left out), names OME pages by their channels through TiffData (`omePageChannels`), and writes label TIFFs (`writeLabelTiff`). StarDist and micro-sam read and write TIFF through it instead of their own copies. StarDist now names OME channels by their TiffData mapping and refuses the TiffData layouts micro-sam refuses.
- Updated dependencies [d643e8d]
- Updated dependencies [3beb743]
- Updated dependencies [a2675b9]
- Updated dependencies [8fca61b]
- Updated dependencies [83f5bb1]
- Updated dependencies [65a2e2b]
  - @neurodesk/webapp-components@0.27.0

## 0.1.20261110

### Patch Changes

- 3877250: The musculoskeletal and microscopy catalogues are now titled "MSK Webapps" and "Microscopy Webapps", without "SciGet". The page title and the app bar's "More … web apps" link follow; the SciGet logo and hub link stay.

## 0.1.20261109

### Patch Changes

- Updated dependencies [6ca6f49]
  - @neurodesk/webapp-components@0.26.0

## 0.1.20261108

### Minor Changes

- b239d4a: Add StarDist, a new app that segments cell nuclei in 2D fluorescence microscopy with StarDist's pretrained `2D_versatile_fluo` model. It reads TIFF, OME-TIFF and PNG images (one chosen channel), runs the model with ONNX Runtime Web on the CPU in overlapping tiles, and ports StarDist's non-maximum suppression and label drawing. It downloads a label TIFF and a per-nucleus CSV table (centroid, area, mean intensity, probability) and shows the labels filled or as outlines. On the DSB 2018 example its 118 nuclei equal Python StarDist 0.9.1's pixel for pixel.

### Patch Changes

- d02feb7: StarDist and ZARRo move to the SciGet Microscopy catalogue at https://microscopyapps.sciget.org/. Links to their old addresses on webapps.neurodesk.org redirect there with the rest of the path, the query and the fragment. Their app bar, page title and privacy text name SciGet.

  elastix is now also served at https://microscopyapps.sciget.org/elastix/, under the SciGet brand. It stays at https://webapps.neurodesk.org/elastix/ as well.

- Updated dependencies [fbe693d]
- Updated dependencies [af1bc1e]
- Updated dependencies [7539ad5]
- Updated dependencies [aa722fe]
- Updated dependencies [8327887]
- Updated dependencies [6102c59]
  - @neurodesk/webapp-components@0.25.0
