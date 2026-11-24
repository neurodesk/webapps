# lightsheet-atlas

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

- a2675b9: Add Light-sheet atlas, a microscopy app that registers a cleared mouse brain to the Allen Mouse Brain CCFv3 (50 µm, from the BrainGlobe Atlas API) with Greedy and counts cell candidates per brain region, following BrainGlobe's brainreg and cellfinder. It reads TIFF stacks and OME-Zarr images plane by plane, detects candidates with a port of cellfinder's classical detection (identical to cellfinder 1.10.1 on its test crop: every thresholded plane and all 38 candidates), and writes the registered atlas labels, the candidate list and a per-region table of candidate counts, volumes and densities. Counts are of unclassified candidates. The Allen atlas is for research and noncommercial use only. On BrainGlobe's test brain its labels agree with brainreg's with a whole-brain Dice of 0.97.

  `@neurodesk/webapp-components` gains `file-io/microscopy-stack`, plane-by-plane readers for TIFF stacks (multi-page or one file per plane, with OME-XML and ImageJ voxel sizes read by the shared `file-io/tiff` parsers; a single OME-TIFF's z planes are the pages its TiffData maps, and a mapping the reader cannot follow, such as planes in another file, is refused before any pixel is decoded; OME-TIFF folders and files with several image series are refused) and OME-Zarr folders. `micrometresPerUnit` also reads the NGFF spellings meter and centimeter. `@neurodesk/greedy` exports its single-threaded WebAssembly glue as `@neurodesk/greedy/wasm-single` for bundlers.

### Patch Changes

- Updated dependencies [d643e8d]
- Updated dependencies [3beb743]
- Updated dependencies [a2675b9]
- Updated dependencies [8fca61b]
- Updated dependencies [83f5bb1]
- Updated dependencies [65a2e2b]
  - @neurodesk/webapp-components@0.27.0
  - @neurodesk/greedy@0.9.20261111

## 0.0.20261110

### Patch Changes

- Include newly registered applications in catalogue analytics when the saved usage report predates them, preserving usage ranking.

## 0.0.20261109

### Patch Changes

- Reject multi-page files in TIFF sequences and require an explicit channel for multi-channel OME-Zarr inputs.
