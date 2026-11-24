# stitching

## 0.2.20261124

### Patch Changes

- 94d6e09: In a browser that offers WebMCP, every app registers tools with the browser's built-in AI agent. The agent can read what the app does, load any of its examples, use the files you already opened or ask you to choose others, run any operation and wait for its report, run it again with other settings without asking for the files again, move and restyle the viewer, and save an output of the run it names. When it needs a decision, it asks you in a dialog that says an AI agent is asking, and closing the dialog declines. It uses files you opened in the app only after you confirm them in a dialog that lists them. It loads data from a web address only after you allow that address, the viewer gets that one file and not a redirect, and for a ZARRo store the dialog names the store's address, under which ZARRo then reads without following a redirect. It changes only how the viewer shows images, never their data or position, it never removes what the viewer shows unless the dialog says so, and it cannot capture the viewer or save images from it. When you use the page yourself, a request the agent already started does nothing more, and before it uses its files or the results of its latest run again it asks you in one dialog that names them and what that run was given, its files and the address it read; declining releases them. A dialog names what it asks about as it is when it opens, and if that changes before you allow it, it shows the change in place and asks again; loading the same example again is no change, and on the third change the dialog closes as declined. Escape, the close button and a click beside the dialog all decline, also after it showed a change. After you allow it, the agent gets that run's report and outputs exactly as the run ended, even if the page shows other results by then. Opening other files, picking an example or a handoff releases them at once, so it never runs on or reports an earlier examination by mistake. It can read what the viewer shows at any time, as you see it. Each app's Privacy dialog says what such an agent can read and do. Browsers without WebMCP load none of this. No browser enables WebMCP by default yet: Chrome offers it behind a testing flag, and each catalogue can hold an origin trial token for its host.

  Automation contracts can mark a parameter `required: true`. Easy MP2RAGE's acquisition values, QSMbly's echo times and field strength and micro-sam's prompts are now required, and the desktop contract schema and NeuroFlow tools accept and publish the mark.

- Updated dependencies [dce0e7f]
- Updated dependencies [94d6e09]
  - @neurodesk/webapp-components@0.29.0

## 0.2.20261119

### Patch Changes

- Updated dependencies [3db69e4]
  - @neurodesk/webapp-components@0.28.1

## 0.2.20261113

### Patch Changes

- Updated dependencies [3ae3eb4]
- Updated dependencies [3f0eab6]
  - @neurodesk/webapp-components@0.28.0

## 0.2.20261111

### Patch Changes

- a73f0ae: Every hosted app page names its home page as canonical, so search engines index one page for an app that several catalogues serve. A copy keeps its own share link (`og:url`). When a catalogue's search finds no app of its own, its landing page lists the matching apps of other catalogues, each linking to the host that serves it.
- 65a2e2b: Move the complex FFT (radix-2 with Bluestein for other lengths, in any number of dimensions) to `@neurodesk/webapp-components/fft` and use it from calcium imaging and stitching, replacing their two app copies. Results are unchanged.
- Updated dependencies [d643e8d]
- Updated dependencies [3beb743]
- Updated dependencies [a2675b9]
- Updated dependencies [8fca61b]
- Updated dependencies [83f5bb1]
- Updated dependencies [65a2e2b]
  - @neurodesk/webapp-components@0.27.0

## 0.2.20261110

### Minor Changes

- c554700: Show what stitching changed. The viewer's Layout and Stitched views put the layout preview and the stitched mosaic on one grid with one contrast window, and switching between them keeps the zoom, so a seam that is doubled in Layout can be checked in Stitched. Tile outlines mark every tile at its layout position (cyan) and where stitching placed it (orange); an Outlines button hides them. The wheel now zooms at the pointer and right-drag pans, and the status line reports how far tiles moved.

### Patch Changes

- 3877250: The musculoskeletal and microscopy catalogues are now titled "MSK Webapps" and "Microscopy Webapps", without "SciGet". The page title and the app bar's "More … web apps" link follow; the SciGet logo and hub link stay.
- 0745d63: Also served from the new Preclinical Webapps catalogue (preclinicalapps.sciget.org). dcm2niix, DICOM View, dicompare, MRI2vid, niimath, ANTs Denoise and elastix are also served from mskapps.sciget.org, where DICOM View hands off to MuscleMap, SeedSeg and Carotid Flow again; niimath and MRI2vid are also served from microscopyapps.sciget.org. QSMbly serves its deep-learning WebAssembly gzipped (6.5 MB instead of 24.8 MB) and inflates it in the browser.

## 0.1.20261109

### Patch Changes

- Updated dependencies [6ca6f49]
  - @neurodesk/webapp-components@0.26.0

## 0.1.20261108

### Minor Changes

- 8327887: Add Tile stitching, a browser app that stitches overlapping 2D or 3D microscopy tiles (TIFF or OME-TIFF) from a grid layout, a Fiji TileConfiguration file or OME stage positions. Pairs are registered by phase correlation with cross-correlation checks of the strongest peaks (after Preibisch et al. 2009), positions are optimised by weighted least squares with outlier rejection, and the tiles are fused with linear blending into TIFF and zipped OME-Zarr, with Fiji's TileConfiguration.registered.txt. On the NIST MIST example every tile is within 0.31 px of Fiji's Grid/Collection stitching.

  `@neurodesk/webapp-components/file-io/tiff` now reads OME stage positions (`stagePosition`, micrometres, from the first image's first plane (TheZ = TheC = TheT = 0); null otherwise; always present).

  Compute Pearson correlation with stable incremental covariance so high-offset uint32 and float64 tiles retain correct matching scores.

  Reject source tile selections over the input budget before reading, check cancellation between file reads, and escape CSV fields so punctuation in filenames preserves report columns.

  Refresh the registered-position text reference after stable correlation changes its final floating-point digits; the example's fused TIFF and recorded Fiji accuracy comparison are unchanged.

  Require compatible tile calibration for translation-only stitching, allowing one part per million of metadata rounding, and convert relative stage displacement with a shared pixel size so absolute stage origins cannot distort placement.

  Share checksum-pinned Blosc and Zstd codec chunks in the composite runtime store to keep the catalogue within its duplicate-content budget. Standalone bundles retain their codecs.

  Resolve Vite preload-table paths from the app base when projecting catalogue sites so shared codecs are included alongside ordinary module imports.

### Patch Changes

- Updated dependencies [fbe693d]
- Updated dependencies [af1bc1e]
- Updated dependencies [7539ad5]
- Updated dependencies [aa722fe]
- Updated dependencies [8327887]
- Updated dependencies [6102c59]
  - @neurodesk/webapp-components@0.25.0
