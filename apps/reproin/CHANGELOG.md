# reproin

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

## 0.1.20261111

### Patch Changes

- a811ddf: Read the app version from package.json, so the config always reports the released version.
- Updated dependencies [d643e8d]
- Updated dependencies [3beb743]
- Updated dependencies [a2675b9]
- Updated dependencies [8fca61b]
- Updated dependencies [83f5bb1]
- Updated dependencies [65a2e2b]
  - @neurodesk/webapp-components@0.27.0

## 0.1.20261109

### Patch Changes

- Updated dependencies [6ca6f49]
  - @neurodesk/webapp-components@0.26.0

## 0.1.20261108

### Patch Changes

- 16e9097: Make the example retry browser test serve provisioned DICOM files after its injected failure, avoiding transient remote download failures. Report an unexpected terminal download error immediately with the selector's message.
- Updated dependencies [fbe693d]
- Updated dependencies [af1bc1e]
- Updated dependencies [7539ad5]
- Updated dependencies [aa722fe]
- Updated dependencies [8327887]
- Updated dependencies [6102c59]
  - @neurodesk/webapp-components@0.25.0

## 0.1.20261104

### Patch Changes

- Updated dependencies
  - @neurodesk/webapp-components@0.24.0

## 0.1.20261103

### Patch Changes

- Updated dependencies [491c3ce]
  - @neurodesk/webapp-components@0.23.0
- Updated dependencies [8e9346d]
- Updated dependencies [239dedd]
  - @neurodesk/webapp-components@0.22.4

## 0.1.20261031

### Patch Changes

- Updated dependencies [d8ac48c]
- Updated dependencies [b84a269]
  - @neurodesk/webapp-components@0.22.3

## 0.1.20261030

### Minor Changes

- 9f0a277: New app: convert a ReproIn DICOM session to a BIDS dataset in the browser with dcm2niix and the reproin-rs post-pass (the `@niivue/reproin` v0.1.20261030 release), with per-file results, NIfTI viewing, a ZIP download and a public Siemens XA60 ReproIn example session. Standalone links the `reproinx` command line from the same reproin-rs release (Linux, macOS, Windows).

### Patch Changes

- Keep cancellation during ZIP creation from publishing results, and let page-drop Undo restore the previously loaded example session.
