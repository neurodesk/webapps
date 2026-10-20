# white-matter-lesions

## 0.5.20261020

### Patch Changes

- Updated dependencies
  - @neurodesk/runtime-support@0.9.5
  - @neurodesk/webapp-components@0.17.1
  - @neurodesk/synthsr@0.6.20261020
  - @neurodesk/synthstrip@0.2.0
  - @neurodesk/white-matter-lesions@0.5.20261020
- 14db080: DICOM View's "Open in White matter lesions" button is now an "Open in another webapp"
  menu that lists every app of the site from the registry. Most apps receive the converted
  NIfTI image; apps the registry marks `handoff: dicom` (dicompare, QSMbly, dwi2trx, NODDI,
  Carotid Flow) receive the series' DICOM files, and `handoff: none` keeps an app that cannot
  use a single series (Zarro, FastPrep, SurfAnnotate, LCModel) out of the menu. The shared shell
  receives a handoff for every app the way a page drop opens files, through the app's own
  inputs; dicompare opens the files as reference acquisitions, and White matter lesions
  keeps its own receiver.

  A multiframe DICOM whose frames lie in different planes, such as a scanner's MPR head
  scout, which dcm2niix refuses, now shows each frame as its own correctly placed slice
  instead of failing with exit code 2. `readDicomFrames` in `@neurodesk/dicom2vid` reads a
  file's frames with their own position, orientation and pixel spacing.

  Dropping files or a folder on the image now opens them. FreeBrowse draws NiiVue inside a
  shadow root, so the page drop never saw the canvas and NiiVue swallowed the drop; the page
  drop now reads the event's composed path. It also no longer routes files to the
  automation contract's hidden input.

  DICOM View opens series in the ACS layout, without the 3D render, with FreeBrowse's
  panel closed.

- Updated dependencies [14db080]

- Updated dependencies [03261d0]

- Updated dependencies [c865c0c]

- Updated dependencies [4b40da1]

  - @neurodesk/webapp-components@0.17.0
  - @neurodesk/runtime-support@0.9.4
  - @neurodesk/synthsr@0.6.20261020
  - @neurodesk/synthstrip@0.1.5
  - @neurodesk/white-matter-lesions@0.5.20261020

- 3f1d770: `takeHandoff` takes a `signal`: an abort stops the copy out of storage instead of
  letting it run on in the background, and rejects with the signal's reason. White
  matter lesions passes its load job's signal, so the footer × ends the copy of an
  image sent from another app. `copiesInPieces` is exported and pinned to the user
  agents Playwright's engines report.

- d9718cd: White matter lesions reads only the NIfTI header when an image is chosen. It used to copy the whole image into memory to read its dimensions, which added a second copy of a 1 GB FLAIR to the load. The shared `readNiftiHeader(file)` reads the first bytes of a plain or gzipped file, and `describeNiftiFile` is built on it.

- Updated dependencies [3f1d770]

- Updated dependencies [14b8248]

- Updated dependencies [d9718cd]

- Updated dependencies [d1fa022]

  - @neurodesk/webapp-components@0.16.3
  - @neurodesk/runtime-support@0.9.3
  - @neurodesk/synthsr@0.6.20261020
  - @neurodesk/synthstrip@0.1.5
  - @neurodesk/white-matter-lesions@0.5.20261020

- Updated dependencies [ea2a6d2]

- Updated dependencies [c1a4dda]

- Updated dependencies [1f4aecd]

- Updated dependencies [3329c39]

- Updated dependencies [46935f7]

- Updated dependencies [d1fa022]

  - @neurodesk/webapp-components@0.16.0
  - @neurodesk/runtime-support@0.8.0
  - @neurodesk/synthsr@0.6.20261020
  - @neurodesk/synthstrip@0.1.5
  - @neurodesk/white-matter-lesions@0.5.20261020

- Updated dependencies [d1fa022]
  - @neurodesk/webapp-components@0.16.3
  - @neurodesk/runtime-support@0.9.3
  - @neurodesk/synthsr@0.6.20261020
  - @neurodesk/synthstrip@0.1.5
  - @neurodesk/white-matter-lesions@0.5.20261020

## 0.5.20261019

### Patch Changes

- Updated dependencies [da2584b]
  - @neurodesk/synthsr@0.6.20261019
  - @neurodesk/runtime-support@0.9.2
  - @neurodesk/white-matter-lesions@0.5.20261019
  - @neurodesk/synthstrip@0.1.5

## 0.5.20261018

### Minor Changes

- b68209b: DICOM View can open the selected image in White matter lesions. Open in White matter lesions, under the series, sends the converted 3D image, named as its download is, and the same tab opens White matter lesions with the image loaded and ready to segment. A time series or a single slice keeps the button disabled and says why. Choosing another series while a send is in progress cancels it. DICOM View's automation contract now gives its image artifact the `application/x-nifti` media type.

  White matter lesions loads an image sent from DICOM View on opening and reports "Loaded <name> from DICOM View" in the status bar. It never starts segmentation itself.

  `@neurodesk/webapp-components/handoff` passes files between apps on one site: `sendHandoff` stores them in IndexedDB and opens the target app; `takeHandoff` claims them once and returns copies. An entry can be opened for 2 minutes, only by the tab that sent it, and is deleted when it is opened. The app shell deletes expired entries whenever an app opens.

  The cross-origin isolation service worker bootstrap publishes `coiWillReload`, which resolves once a page knows whether it is about to reload, and `coiHoldReloads`, which stops later automatic reloads. Pages that use neither behave as before.

### Patch Changes

- Updated dependencies [7c0d201]

  - @neurodesk/webapp-components@0.16.2
  - @neurodesk/runtime-support@0.9.1
  - @neurodesk/synthsr@0.6.20261018
  - @neurodesk/synthstrip@0.1.5
  - @neurodesk/white-matter-lesions@0.5.20261018

- Updated dependencies

- Updated dependencies [46935f7]

  - @neurodesk/runtime-support@0.9.0
  - @neurodesk/webapp-components@0.16.1
  - @neurodesk/synthsr@0.6.20261018
  - @neurodesk/synthstrip@0.1.5
  - @neurodesk/white-matter-lesions@0.5.20261018

- Updated dependencies [ea2a6d2]

- Updated dependencies [0511cd7]

- Updated dependencies [a07f659]

- Updated dependencies [3329c39]

  - @neurodesk/webapp-components@0.16.0
  - @neurodesk/runtime-support@0.8.0

- Updated dependencies [b67e4e9]

  - @neurodesk/runtime-support@0.7.2
  - @neurodesk/webapp-components@0.15.1
  - @neurodesk/synthsr@0.6.20261018
  - @neurodesk/synthstrip@0.1.5
  - @neurodesk/white-matter-lesions@0.5.20261018

- Updated dependencies [b68209b]

  - @neurodesk/webapp-components@0.15.0
  - @neurodesk/runtime-support@0.7.1
  - @neurodesk/synthsr@0.6.20261018
  - @neurodesk/synthstrip@0.1.5
  - @neurodesk/white-matter-lesions@0.5.20261018

- Updated dependencies [7c0d201]

  - @neurodesk/webapp-components@0.16.2
  - @neurodesk/runtime-support@0.9.1
  - @neurodesk/synthsr@0.6.20261018
  - @neurodesk/synthstrip@0.1.5
  - @neurodesk/white-matter-lesions@0.5.20261018

- Updated dependencies [46935f7]

  - @neurodesk/runtime-support@0.9.0
  - @neurodesk/webapp-components@0.16.1
  - @neurodesk/synthsr@0.6.20261018
  - @neurodesk/synthstrip@0.1.5
  - @neurodesk/white-matter-lesions@0.5.20261018

- Updated dependencies [3329c39]

  - @neurodesk/webapp-components@0.16.0
  - @neurodesk/runtime-support@0.8.0

- Updated dependencies [b67e4e9]
  - @neurodesk/runtime-support@0.7.2
  - @neurodesk/webapp-components@0.15.1
  - @neurodesk/synthsr@0.6.20261018
  - @neurodesk/synthstrip@0.1.5
  - @neurodesk/white-matter-lesions@0.5.20261018

## 0.4.20261018

### Patch Changes

- Updated dependencies [67a5a8f]

- Updated dependencies [b8b37d6]

- Updated dependencies [2ae93ae]

- Updated dependencies [ccb2970]

- Updated dependencies [67a5a8f]
  - @neurodesk/runtime-support@0.7.0
  - @neurodesk/webapp-components@0.14.4
  - @neurodesk/synthsr@0.6.20261018
  - @neurodesk/synthstrip@0.1.5
  - @neurodesk/white-matter-lesions@0.4.20261018

## 0.4.20261017

### Minor Changes

- 202fd16: Step through segmented lesions in the viewer. ‹ and › centre the crosshair on each lesion in turn, largest first, and the Overlay toggle hides the mask or probability map to check the FLAIR beneath. The Output section shows the lesion count and the total, largest, median and smallest lesion volume. `lesionResults` now also returns the ranked lesions (`lesions`: volume and centroid in mm).

### Patch Changes

- Updated dependencies [b547d52]

- Updated dependencies [202fd16]
  - @neurodesk/webapp-components@0.14.3
  - @neurodesk/white-matter-lesions@0.4.20261017
  - @neurodesk/runtime-support@0.6.4
  - @neurodesk/synthsr@0.6.20261017
  - @neurodesk/synthstrip@0.1.5

## 0.3.20261016

### Patch Changes

- Persist checksum-verified model and example caches across browser restarts. Bind runtime caches to each document’s checksum manifest to avoid reusing bytes from a different deployment.

- Updated dependencies

  - @neurodesk/webapp-components@0.14.2
  - @neurodesk/runtime-support@0.6.3
  - @neurodesk/synthsr@0.6.20261016
  - @neurodesk/synthstrip@0.1.5
  - @neurodesk/white-matter-lesions@0.3.20261016

- 245a946: Run SynthStrip brain extraction through the streamed browser session, layer by layer in slabs,
  as SYNcro does. An image covering a whole head at 1 mm conforms to SynthStrip's 256³ grid, where
  one whole-graph ONNX Runtime session ran out of WebAssembly memory with "std::bad_alloc".
  The streamed session reproduces the recorded browser SynthStrip mask bit for bit.

- Updated dependencies [7443048]

  - @neurodesk/webapp-components@0.14.1
  - @neurodesk/runtime-support@0.6.2
  - @neurodesk/synthsr@0.6.20261016
  - @neurodesk/synthstrip@0.1.5
  - @neurodesk/white-matter-lesions@0.3.20261016

- Updated dependencies
  - @neurodesk/webapp-components@0.14.2
  - @neurodesk/runtime-support@0.6.3
  - @neurodesk/synthsr@0.6.20261016
  - @neurodesk/synthstrip@0.1.5
  - @neurodesk/white-matter-lesions@0.3.20261016

## 0.3.20261015

### Patch Changes

- Updated dependencies [c74b26f]

  - @neurodesk/runtime-support@0.6.1
  - @neurodesk/synthsr@0.6.20261015
  - @neurodesk/synthstrip@0.1.5
  - @neurodesk/white-matter-lesions@0.3.20261015

- dd65e6a: Visual refresh: Inter, neutral greys with the Neurodesk logo green for action,
  focus and selection only, a compact 48px app bar, sentence-case section titles
  and a quieter status bar. The example menu is now the input control: examples,
  then Choose files… and Choose folder…. The whole window, the viewer included,
  accepts dropped files; a drop mid-session replaces the inputs with Undo in the
  status bar. Before any input the status reads "Drag and drop files". MuscleMap
  drops its separate drop box and Add File(s) button.

  Page drops fill empty image slots in order while keeping DICOM series together.
  New selections supersede unfinished drop traversal, and registration apps load
  each dropped image in order. The shared drop handler also respects the different
  native input and file-field event contracts.
  Failed imports leave only successfully loaded slots occupied, and Undo can
  restore loaded examples.

- Updated dependencies [0569da8]

- Updated dependencies [dd65e6a]

- Updated dependencies [dcc74e7]

  - @neurodesk/runtime-support@0.6.0
  - @neurodesk/webapp-components@0.14.0
  - @neurodesk/synthsr@0.6.20261015
  - @neurodesk/synthstrip@0.1.5
  - @neurodesk/white-matter-lesions@0.3.20261015

- 84d192a: FLAMeS no longer rejects high-resolution FLAIR. A 0.4 mm 3D FLAIR of
  544 × 544 × 480 voxels exceeded SynthSR's 128 Mi voxel reader cap and failed
  with "Unsupported image dimensions". An input finer than FLAMeS's
  1 × 0.9 × 0.9 mm grid is now downsampled to that grid with nnU-Net's cubic
  resampling before brain extraction. Inputs up to 512 Mi voxels are accepted.
  The mask, probability map and table then use the resampled grid; the web app
  shows them over the resampled FLAIR and offers it for download, and the
  `flames` command writes it as `INPUT_flair_resampled.nii`. Inputs at or
  coarser than 1 × 0.9 × 0.9 mm are unchanged. `readVolume` in
  `@neurodesk/synthsr` takes an optional `maxVoxels` cap.

- Updated dependencies [84d192a]

  - @neurodesk/white-matter-lesions@0.3.20261015
  - @neurodesk/synthsr@0.6.20261015

- Updated dependencies [c74b26f]

  - @neurodesk/runtime-support@0.6.1
  - @neurodesk/synthsr@0.6.20261015
  - @neurodesk/synthstrip@0.1.5
  - @neurodesk/white-matter-lesions@0.3.20261015

- Updated dependencies [dcc74e7]
  - @neurodesk/runtime-support@0.6.0
  - @neurodesk/webapp-components@0.14.0
  - @neurodesk/synthsr@0.6.20261015
  - @neurodesk/synthstrip@0.1.5
  - @neurodesk/white-matter-lesions@0.3.20261015

## 0.3.20261014

### Patch Changes

- Updated dependencies [27c9549]

- Updated dependencies [850e642]

- Updated dependencies [ad92e2f]
  - @neurodesk/runtime-support@0.5.0
  - @neurodesk/webapp-components@0.13.0
  - @neurodesk/synthsr@0.6.20261014
  - @neurodesk/synthstrip@0.1.5
  - @neurodesk/white-matter-lesions@0.3.20261014

## 0.3.20261012

### Patch Changes

- Updated dependencies
  - @neurodesk/webapp-components@0.12.3
  - @neurodesk/runtime-support@0.4.3
  - @neurodesk/synthsr@0.6.20261012
  - @neurodesk/synthstrip@0.1.5
  - @neurodesk/white-matter-lesions@0.3.20261012

## 0.3.20261010

### Minor Changes

- Load each verified FLAMeS fold after the previous inference session is released, rather than retaining all five model graphs. Stream the command line's model preflight checks while preserving early missing or corrupt file refusal. Keep the model pins, inference parameters and output reference gates unchanged, and measure the complete five-fold browser workflow in Chrome and native Safari.

### Patch Changes

- Updated dependencies

  - @neurodesk/webapp-components@0.12.2
  - @neurodesk/runtime-support@0.4.2
  - @neurodesk/synthsr@0.6.20261010
  - @neurodesk/synthstrip@0.1.5
  - @neurodesk/white-matter-lesions@0.3.20261010

- Updated dependencies

  - @neurodesk/white-matter-lesions@0.3.20261010
  - @neurodesk/runtime-support@0.4.1
  - @neurodesk/webapp-components@0.12.1
  - @neurodesk/synthsr@0.6.20261010
  - @neurodesk/synthstrip@0.1.5

- Updated dependencies
  - @neurodesk/webapp-components@0.12.2
  - @neurodesk/runtime-support@0.4.2
  - @neurodesk/synthsr@0.6.20261010
  - @neurodesk/synthstrip@0.1.5
  - @neurodesk/white-matter-lesions@0.3.20261010

## 0.2.20261009

### Patch Changes

- Updated dependencies [bb10737]

- Updated dependencies [66bf9e9]

- Updated dependencies [501ea0c]

- Updated dependencies [64ffefa]
  - @neurodesk/synthstrip@0.1.4
  - @neurodesk/webapp-components@0.12.0
  - @neurodesk/runtime-support@0.3.0
  - @neurodesk/white-matter-lesions@0.2.20261009
  - @neurodesk/synthsr@0.6.20261009

## 0.2.20261007

### Minor Changes

- 5ec8fe3: Add the `flames` command line: FLAMeS lesion segmentation on the CPU with ONNX Runtime Node, writing the web app's lesion mask, probability map and lesion table under the same names. It takes the app's `--folds 1|5` and `--skull-stripped` settings, installs SynthStrip and all five folds with SHA-256 checks on every load, and ships as portable Linux x64 and Windows x64 archives and a signed macOS arm64 installer that each bundle Node and the models. Each release must reproduce the web app's lesion count, mask volume and summed probability, as recorded in a browser, on the pinned example with one fold and with the ensemble. With one fold it must also match the web app's WebAssembly pipeline at mask Dice 0.998 or better, with no probability more than 0.1 apart. The pipeline moves into the new `@neurodesk/white-matter-lesions` package, which the web app now uses.

### Patch Changes

- Updated dependencies [22aa4bf]

  - @neurodesk/webapp-components@0.11.1
  - @neurodesk/runtime-support@0.2.1
  - @neurodesk/synthsr@0.6.20261007
  - @neurodesk/synthstrip@0.1.3
  - @neurodesk/white-matter-lesions@0.2.20261007

- Updated dependencies

  - @neurodesk/webapp-components@0.11.0
  - @neurodesk/runtime-support@0.2.0
  - @neurodesk/synthsr@0.6.20261007
  - @neurodesk/synthstrip@0.1.2
  - @neurodesk/white-matter-lesions@0.2.20261007

- Updated dependencies [70f2770]

- Updated dependencies [5ec8fe3]

  - @neurodesk/webapp-components@0.10.2
  - @neurodesk/white-matter-lesions@0.2.20261007
  - @neurodesk/synthsr@0.6.20261007

- Updated dependencies [22aa4bf]

  - @neurodesk/webapp-components@0.11.1
  - @neurodesk/runtime-support@0.2.1
  - @neurodesk/synthsr@0.6.20261007
  - @neurodesk/synthstrip@0.1.3
  - @neurodesk/white-matter-lesions@0.2.20261007

- Updated dependencies
  - @neurodesk/webapp-components@0.11.0
  - @neurodesk/runtime-support@0.2.0
  - @neurodesk/synthsr@0.6.20261007
  - @neurodesk/synthstrip@0.1.2
  - @neurodesk/white-matter-lesions@0.2.20261007

## 0.1.20261005

### Patch Changes

- Updated dependencies
  - @neurodesk/synthsr@0.6.20261005

## 0.1.20261004

### Patch Changes

- f12d686: Fall back to the CPU when WebGPU returns blank lesion scores. Some virtual GPUs, including GitHub's macOS runners, complete a WebGPU run but return all zeros, which reported no lesions. Non-finite or constant network output now counts as a WebGPU failure, so the segmentation restarts on WebAssembly.

- Updated dependencies

  - @neurodesk/synthsr@0.6.20261004

- Updated dependencies

  - @neurodesk/webapp-components@0.10.1
  - @neurodesk/synthsr@0.6.20261004

- df84067: Correct the lesion mask in the viewer before downloading it. Edit on the lesion mask row opens the shared editor over the FLAIR with Draw, Erase and Fill tools. Apply replaces the mask in the Output list and recomputes the lesion count, volume and lesion table from the edited mask, marking both rows `(edited)`. Download returns the edited mask under the same name as a uint8 NIfTI. Cancel discards the strokes. Loading a new image or segmenting again closes an open edit. The probability map and the run report remain as the model produced them.

- Updated dependencies [0204fe1]

- Updated dependencies [ec85a09]

  - @neurodesk/webapp-components@0.10.0
  - @neurodesk/synthsr@0.6.20261004

- Updated dependencies [257192b]

  - @neurodesk/synthsr@0.6.20261004
  - @neurodesk/synthstrip@0.1.1
  - @neurodesk/runtime-support@0.1.3

- Updated dependencies

  - @neurodesk/webapp-components@0.9.0
  - @neurodesk/synthsr@0.5.20261004

- Updated dependencies

  - @neurodesk/synthsr@0.6.20261004

- Updated dependencies

  - @neurodesk/webapp-components@0.10.1
  - @neurodesk/synthsr@0.6.20261004

- Updated dependencies [ec85a09]

  - @neurodesk/webapp-components@0.10.0
  - @neurodesk/synthsr@0.6.20261004

- Updated dependencies [257192b]
  - @neurodesk/synthsr@0.6.20261004
  - @neurodesk/synthstrip@0.1.1
  - @neurodesk/runtime-support@0.1.3

## 0.1.20261003

### Patch Changes

- Updated dependencies
  - @neurodesk/webapp-components@0.8.0
  - @neurodesk/synthsr@0.5.20261003

## 0.1.20260930

### Patch Changes

- 5909f26: Fix the lesion probability overlay by using NiiVue's supported display-range options. Probabilities below 0.1 stay transparent instead of tinting the entire FLAIR image orange; downloaded probabilities are unchanged. Open Advanced settings by default so skull stripping, model and processing options are immediately visible.

- Updated dependencies

- Updated dependencies

  - @neurodesk/webapp-components@0.7.0
  - @neurodesk/synthsr@0.5.20260930

- Updated dependencies

  - @neurodesk/webapp-components@0.6.2
  - @neurodesk/synthsr@0.5.20260930

- Updated dependencies
  - @neurodesk/webapp-components@0.7.0
  - @neurodesk/synthsr@0.5.20260930

### Minor Changes

- Add White matter lesions: FLAMeS lesion segmentation of a single FLAIR image in the browser, after SynthStrip brain extraction, with a lesion mask, probability map and lesion table. Result lists can mark a result as not viewable, which keeps its row and disables View.

- Expose FLAIR lesion segmentation through the shared automation contract, with awaited completion, cancellation, artifacts and model provenance.
