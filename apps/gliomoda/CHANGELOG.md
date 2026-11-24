# gliomoda

## 0.1.20261124

### Patch Changes

- 94d6e09: In a browser that offers WebMCP, every app registers tools with the browser's built-in AI agent. The agent can read what the app does, load any of its examples, use the files you already opened or ask you to choose others, run any operation and wait for its report, run it again with other settings without asking for the files again, move and restyle the viewer, and save an output of the run it names. When it needs a decision, it asks you in a dialog that says an AI agent is asking, and closing the dialog declines. It uses files you opened in the app only after you confirm them in a dialog that lists them. It loads data from a web address only after you allow that address, the viewer gets that one file and not a redirect, and for a ZARRo store the dialog names the store's address, under which ZARRo then reads without following a redirect. It changes only how the viewer shows images, never their data or position, it never removes what the viewer shows unless the dialog says so, and it cannot capture the viewer or save images from it. When you use the page yourself, a request the agent already started does nothing more, and before it uses its files or the results of its latest run again it asks you in one dialog that names them and what that run was given, its files and the address it read; declining releases them. A dialog names what it asks about as it is when it opens, and if that changes before you allow it, it shows the change in place and asks again; loading the same example again is no change, and on the third change the dialog closes as declined. Escape, the close button and a click beside the dialog all decline, also after it showed a change. After you allow it, the agent gets that run's report and outputs exactly as the run ended, even if the page shows other results by then. Opening other files, picking an example or a handoff releases them at once, so it never runs on or reports an earlier examination by mistake. It can read what the viewer shows at any time, as you see it. Each app's Privacy dialog says what such an agent can read and do. Browsers without WebMCP load none of this. No browser enables WebMCP by default yet: Chrome offers it behind a testing flag, and each catalogue can hold an origin trial token for its host.

  Automation contracts can mark a parameter `required: true`. Easy MP2RAGE's acquisition values, QSMbly's echo times and field strength and micro-sam's prompts are now required, and the desktop contract schema and NeuroFlow tools accept and publish the mark.

- Updated dependencies [dce0e7f]
- Updated dependencies [94d6e09]
  - @neurodesk/webapp-components@0.29.0
  - @neurodesk/synthsr@0.6.20261124
  - @neurodesk/gliomoda@0.1.6

## 0.1.20261119

### Patch Changes

- Updated dependencies [3db69e4]
  - @neurodesk/webapp-components@0.28.1
  - @neurodesk/synthsr@0.6.20261119
  - @neurodesk/gliomoda@0.1.5

## 0.1.20261113

### Patch Changes

- Updated dependencies [3ae3eb4]
- Updated dependencies [3f0eab6]
- Updated dependencies [9312d3a]
  - @neurodesk/webapp-components@0.28.0
  - @neurodesk/synthsr@0.6.20261113
  - @neurodesk/gliomoda@0.1.4

## 0.1.20261111

### Patch Changes

- Updated dependencies [d643e8d]
- Updated dependencies [3beb743]
- Updated dependencies [a2675b9]
- Updated dependencies [8fca61b]
- Updated dependencies [83f5bb1]
- Updated dependencies [65a2e2b]
  - @neurodesk/webapp-components@0.27.0
  - @neurodesk/synthsr@0.6.20261111
  - @neurodesk/gliomoda@0.1.3

## 0.1.20261109

### Patch Changes

- Updated dependencies [6ca6f49]
  - @neurodesk/webapp-components@0.26.0
  - @neurodesk/synthsr@0.6.20261109
  - @neurodesk/gliomoda@0.1.2

## 0.1.20261108

### Minor Changes

- c798e49: Add GlioMODA, a new app that segments adult gliomas on skull-stripped MRI registered to the BraTS/SRI24 atlas grid. It takes any of GlioMODA's 11 sequence combinations of T1c, FLAIR, T1 and T2 (plus the ResEncL model for all four), recognises the sequences from BraTS, BraTS Toolkit, UPENN-GBM and BIDS file names, and runs the GlioMODA v1.0.2 networks with ONNX Runtime Web on WebGPU or the CPU, repeating nnU-Net 2.5.2's normalisation, mirrored sliding-window prediction and region labels. It downloads the BraTS label map (necrotic core, oedema, enhancing tumour) and a volume table. On the UPENN-GBM example its labels match the Neurocontainers GlioMODA 0.0.4 container's for every model.

  Store container validation volumes in the pinned Hugging Face dataset instead of Git. Verify their SHA-256 before parity and browser comparisons.

  Reject non-finite or degenerate spatial transforms and modalities whose voxel-to-world matrices differ by more than 1e-5 before segmentation.

### Patch Changes

- Updated dependencies [fbe693d]
- Updated dependencies [af1bc1e]
- Updated dependencies [7539ad5]
- Updated dependencies [aa722fe]
- Updated dependencies [8327887]
- Updated dependencies [6102c59]
  - @neurodesk/webapp-components@0.25.0
  - @neurodesk/synthsr@0.6.20261108
  - @neurodesk/gliomoda@0.1.1
