# brain-extraction

## 0.5.20261024

### Patch Changes

- Updated dependencies [0066f60]
  - @neurodesk/webapp-components@0.21.1
  - @neurodesk/runtime-support@0.9.12
  - @neurodesk/synthsr@0.6.20261024
  - @neurodesk/synthstrip@0.2.0
  - @neurodesk/brain-extraction@0.5.20261024
- Updated dependencies [941884c]
- Updated dependencies [a028e96]
- Updated dependencies [650ce5f]
- Updated dependencies [343c256]
- Updated dependencies [941884c]
  - @neurodesk/webapp-components@0.21.0
  - @neurodesk/runtime-support@0.9.11
  - @neurodesk/brain-extraction@0.5.20261024
  - @neurodesk/synthsr@0.6.20261024
  - @neurodesk/synthstrip@0.2.0
- 72cbb8d: Hosted apps can hand their NiiVue viewer to an AI agent on the same computer. `automation.agentConnection()` and `createAgentControl()` connect the page to a local nv-mcp server only after the person chooses **Connect an agent**, and report the connection in the app's status bar. The new `neurodesk-mcp` command (`@neurodesk/agent-server`) is that server for Node, accepting pages from `https://webapps.neurodesk.org` and localhost. It refuses a malformed request or frame without stopping, keeps serving when a client resets its socket, and closes a refused socket once it has answered. Brain Extraction shows the control as a preview when opened with `?agent` (or `?agent=<port>`). Its Privacy text says what a connected agent can read: screenshots of the viewer, and the names, dimensions, intensity statistics and display settings of the loaded images. An agent that runs on a cloud model sends what it reads to its provider. Chrome asks to allow local network access, and Safari cannot connect. Firefox connected without a prompt in one test on macOS. App builds bundle nv-mcp's browser client, which loads only when an agent connects or calls it. The components list nv-mcp as a devDependency, so command-line installs of the components carry neither nv-mcp nor the MCP server stack, and the components' type declarations compile without it.
- Updated dependencies [3a7e5bb]
- Updated dependencies [72cbb8d]
  - @neurodesk/webapp-components@0.20.0
  - @neurodesk/runtime-support@0.9.10
  - @neurodesk/synthsr@0.6.20261024
  - @neurodesk/synthstrip@0.2.0
  - @neurodesk/brain-extraction@0.5.20261024
- Updated dependencies [3fc9cf2]
  - @neurodesk/webapp-components@0.19.1
  - @neurodesk/runtime-support@0.9.9
  - @neurodesk/synthsr@0.6.20261024
  - @neurodesk/synthstrip@0.2.0
  - @neurodesk/brain-extraction@0.5.20261024
- Updated dependencies
  - @neurodesk/webapp-components@0.21.1
  - @neurodesk/runtime-support@0.9.14
  - @neurodesk/synthsr@0.6.20261024
  - @neurodesk/synthstrip@0.2.0
  - @neurodesk/brain-extraction@0.5.20261024
- Updated dependencies [328cb77]
  - @neurodesk/webapp-components@0.20.1
  - @neurodesk/runtime-support@0.9.13
  - @neurodesk/synthsr@0.6.20261024
  - @neurodesk/synthstrip@0.2.0
  - @neurodesk/brain-extraction@0.5.20261024
- Updated dependencies [14a8b29]
- Updated dependencies [941884c]
  - @neurodesk/webapp-components@0.20.0
  - @neurodesk/runtime-support@0.9.12
  - @neurodesk/synthsr@0.6.20261024
  - @neurodesk/synthstrip@0.2.0
  - @neurodesk/brain-extraction@0.5.20261024
- Updated dependencies
  - @neurodesk/webapp-components@0.19.3
  - @neurodesk/runtime-support@0.9.11
  - @neurodesk/synthsr@0.6.20261024
  - @neurodesk/synthstrip@0.2.0
  - @neurodesk/brain-extraction@0.5.20261024
- Updated dependencies
  - @neurodesk/webapp-components@0.19.2
  - @neurodesk/synthsr@0.6.20261024
  - @neurodesk/runtime-support@0.9.10
  - @neurodesk/brain-extraction@0.5.20261024
  - @neurodesk/synthstrip@0.2.0

## 0.5.20261022

### Patch Changes

- Updated dependencies [d32b485]
  - @neurodesk/webapp-components@0.19.0
  - @neurodesk/runtime-support@0.9.8
  - @neurodesk/synthsr@0.6.20261022
  - @neurodesk/synthstrip@0.2.0
  - @neurodesk/brain-extraction@0.5.20261022

## 0.5.20261020

### Minor Changes

- Add SynthStrip no-CSF extraction to the browser and command line, with distinct output names and a checksum-pinned model included in offline bundles. Keep a completed no-CSF browser run in normal CI.

### Patch Changes

- Updated dependencies
  - @neurodesk/runtime-support@0.9.7
  - @neurodesk/synthsr@0.6.20261020
  - @neurodesk/synthstrip@0.2.0
  - @neurodesk/brain-extraction@0.5.20261020
- Updated dependencies
  - @neurodesk/synthstrip@0.2.0
  - @neurodesk/brain-extraction@0.5.20261020

## 0.4.20261020

### Patch Changes

- Updated dependencies [c865c0c]
  - @neurodesk/webapp-components@0.17.1
  - @neurodesk/runtime-support@0.8.2
  - @neurodesk/synthsr@0.6.20261020
  - @neurodesk/synthstrip@0.1.5
  - @neurodesk/brain-extraction@0.4.20261020
- Record the injected MindGrab runtime's actual version in brain extraction provenance, including SYNcro's separately pinned build.
- Updated dependencies [a36fde4]
- Updated dependencies
- Updated dependencies
  - @neurodesk/webapp-components@0.17.0
  - @neurodesk/brain-extraction@0.4.20261020
  - @neurodesk/runtime-support@0.8.1
  - @neurodesk/synthsr@0.6.20261020
  - @neurodesk/synthstrip@0.1.5
- 14b8248: MindGrab's automatic backend no longer runs WebGL2 on a software renderer (SwiftShader, llvmpipe), which returned a blank brain mask without WebGPU; the threaded CPU module runs instead. The choice and MindGrab's own output appear in the technical log.
- Updated dependencies [ea2a6d2]
- Updated dependencies [3f1d770]
- Updated dependencies [14b8248]
- Updated dependencies [d9718cd]
- Updated dependencies [c1a4dda]
- Updated dependencies [1f4aecd]
- Updated dependencies [3329c39]
- Updated dependencies [46935f7]
- Updated dependencies [d1fa022]

  - @neurodesk/webapp-components@0.16.0
  - @neurodesk/runtime-support@0.8.0
  - @neurodesk/synthsr@0.6.20261020
  - @neurodesk/synthstrip@0.1.5
  - @neurodesk/brain-extraction@0.4.20261020

- @neurodesk/synthsr@0.6.20261020

- @neurodesk/brain-extraction@0.4.20261020

- 657c330: Record the injected MindGrab runtime's actual version in brain extraction provenance, including SYNcro's separately pinned build.

- Updated dependencies [a36fde4]

- Updated dependencies [657c330]

  - @neurodesk/webapp-components@0.18.0
  - @neurodesk/brain-extraction@0.4.20261020
  - @neurodesk/runtime-support@0.9.5
  - @neurodesk/synthsr@0.6.20261020
  - @neurodesk/synthstrip@0.1.5

- Updated dependencies [14db080]

- Updated dependencies [03261d0]

- Updated dependencies [c865c0c]

  - @neurodesk/webapp-components@0.17.0
  - @neurodesk/runtime-support@0.9.4
  - @neurodesk/synthsr@0.6.20261020
  - @neurodesk/synthstrip@0.1.5
  - @neurodesk/brain-extraction@0.4.20261020

- 14b8248: MindGrab's automatic backend no longer runs WebGL2 on a software renderer (SwiftShader, llvmpipe), which returned a blank brain mask without WebGPU; the threaded CPU module runs instead. The choice and MindGrab's own output appear in the technical log.

- Updated dependencies [ea2a6d2]

- Updated dependencies [3f1d770]

- Updated dependencies [14b8248]

- Updated dependencies [d9718cd]

- Updated dependencies [c1a4dda]

- Updated dependencies [1f4aecd]

- Updated dependencies [3329c39]

- Updated dependencies [46935f7]

- Updated dependencies [d1fa022]

  - @neurodesk/webapp-components@0.16.3
  - @neurodesk/runtime-support@0.9.3
  - @neurodesk/synthsr@0.6.20261020
  - @neurodesk/synthstrip@0.1.5
  - @neurodesk/brain-extraction@0.4.20261020

- Updated dependencies [657c330]

  - @neurodesk/brain-extraction@0.4.20261020

- Updated dependencies [4b40da1]

  - @neurodesk/webapp-components@0.17.0
  - @neurodesk/runtime-support@0.9.4
  - @neurodesk/synthsr@0.6.20261020
  - @neurodesk/synthstrip@0.1.5
  - @neurodesk/brain-extraction@0.4.20261020

- Updated dependencies [657c330]

  - @neurodesk/brain-extraction@0.4.20261020

  - @neurodesk/webapp-components@0.16.3
  - @neurodesk/runtime-support@0.9.3
  - @neurodesk/synthsr@0.6.20261020
  - @neurodesk/synthstrip@0.1.5
  - @neurodesk/brain-extraction@0.4.20261020

- Updated dependencies

- Updated dependencies

  - @neurodesk/webapp-components@0.17.0
  - @neurodesk/brain-extraction@0.4.20261020
  - @neurodesk/runtime-support@0.8.1
  - @neurodesk/synthsr@0.6.20261020
  - @neurodesk/synthstrip@0.1.5

- Updated dependencies

  - @neurodesk/webapp-components@0.17.0
  - @neurodesk/runtime-support@0.8.1
  - @neurodesk/synthsr@0.6.20261020
  - @neurodesk/synthstrip@0.1.5
  - @neurodesk/brain-extraction@0.4.20261020

- Updated dependencies

  - @neurodesk/brain-extraction@0.4.20261020

- Updated dependencies

  - @neurodesk/webapp-components@0.18.0
  - @neurodesk/runtime-support@0.8.2
  - @neurodesk/synthsr@0.6.20261020
  - @neurodesk/synthstrip@0.1.5
  - @neurodesk/brain-extraction@0.4.20261020

- Updated dependencies

  - @neurodesk/brain-extraction@0.4.20261020
  - @neurodesk/webapp-components@0.17.0
  - @neurodesk/runtime-support@0.8.1
  - @neurodesk/synthsr@0.6.20261020
  - @neurodesk/synthstrip@0.1.5

- Updated dependencies
  - @neurodesk/runtime-support@0.9.5
  - @neurodesk/webapp-components@0.17.1
  - @neurodesk/synthsr@0.6.20261020
  - @neurodesk/synthstrip@0.1.5
  - @neurodesk/brain-extraction@0.4.20261020
- Updated dependencies [4b40da1]

- NiiVue moves to 1.0.0-rc.26 in Brain Extraction, Carotid Flow, SYNcro, SynthSeg, White Matter Lesions, and, through the shared FreeBrowse viewer, Spinal Cord Toolbox, DICOM View and TopoFit. From rc.25, NiiVue places a loaded drawing on the right voxels of a sagittal or otherwise permuted image (niivue/mono#251), so the mask editor no longer probes and reverses NiiVue's load on opening a mask. Opening a mask for editing now takes one load instead of up to five on such images. MuscleMap, SeedSeg and VesselBoost run NiiVue 0.68, which already loaded drawings correctly; they pick up the simpler editor.

  From rc.22 NiiVue renders with WebGL2 by default, so the five apps that pinned rc.11 or rc.14 draw their viewer with WebGL2 even where WebGPU is available; segmentation and other processing keep their own WebGPU backends.

- Updated dependencies
  - @neurodesk/webapp-components@0.17.2
  - @neurodesk/runtime-support@0.9.6
  - @neurodesk/synthsr@0.6.20261020
  - @neurodesk/synthstrip@0.1.5
  - @neurodesk/brain-extraction@0.4.20261020
- Updated dependencies [14db080]

## 0.4.20261019

### Patch Changes

- Updated dependencies [af2e8db]

- Updated dependencies [b3404ec]

  - @neurodesk/webapp-components@0.16.3
  - @neurodesk/runtime-support@0.9.3
  - @neurodesk/synthsr@0.6.20261019
  - @neurodesk/synthstrip@0.1.5
  - @neurodesk/brain-extraction@0.4.20261019

- 5ad652c: Load the shared compact BET WebAssembly kernel in the browser instead of a second full QSM bundle. Align its core pin with QSMbly while preserving the existing BET mask references and original image geometry.

- Updated dependencies [5ad652c]

  - @neurodesk/brain-extraction@0.4.20261019

- Updated dependencies [da2584b]
  - @neurodesk/synthsr@0.6.20261019
  - @neurodesk/runtime-support@0.9.2
  - @neurodesk/brain-extraction@0.4.20261019
  - @neurodesk/synthstrip@0.1.5

## 0.4.20261018

### Patch Changes

- Updated dependencies [b68209b]
  - @neurodesk/webapp-components@0.15.0
  - @neurodesk/runtime-support@0.7.1
  - @neurodesk/synthsr@0.6.20261018
  - @neurodesk/synthstrip@0.1.5
  - @neurodesk/brain-extraction@0.4.20261018
- Updated dependencies [67a5a8f]
- Updated dependencies [b8b37d6]
- Updated dependencies [2ae93ae]
- Updated dependencies [ccb2970]
- Updated dependencies [67a5a8f]

  - @neurodesk/runtime-support@0.7.0
  - @neurodesk/webapp-components@0.14.4
  - @neurodesk/synthsr@0.6.20261018
  - @neurodesk/synthstrip@0.1.5
  - @neurodesk/brain-extraction@0.4.20261018

- Updated dependencies [7c0d201]

  - @neurodesk/webapp-components@0.16.2
  - @neurodesk/runtime-support@0.9.1
  - @neurodesk/synthsr@0.6.20261018
  - @neurodesk/synthstrip@0.1.5
  - @neurodesk/brain-extraction@0.4.20261018

- Updated dependencies

- Updated dependencies [46935f7]

  - @neurodesk/runtime-support@0.9.0
  - @neurodesk/webapp-components@0.16.1
  - @neurodesk/synthsr@0.6.20261018
  - @neurodesk/synthstrip@0.1.5
  - @neurodesk/brain-extraction@0.4.20261018

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
  - @neurodesk/brain-extraction@0.4.20261018

- Updated dependencies [b68209b]

  - @neurodesk/webapp-components@0.15.0
  - @neurodesk/runtime-support@0.7.1
  - @neurodesk/synthsr@0.6.20261018
  - @neurodesk/synthstrip@0.1.5
  - @neurodesk/brain-extraction@0.4.20261018

- Updated dependencies [67a5a8f]

- Updated dependencies [b8b37d6]

- Updated dependencies [2ae93ae]

- Updated dependencies [ccb2970]

  - @neurodesk/runtime-support@0.7.0
  - @neurodesk/webapp-components@0.14.4
  - @neurodesk/synthsr@0.6.20261018
  - @neurodesk/synthstrip@0.1.5
  - @neurodesk/brain-extraction@0.4.20261018

- Updated dependencies [b67e4e9]
  - @neurodesk/runtime-support@0.7.2
  - @neurodesk/webapp-components@0.15.1
  - @neurodesk/synthsr@0.6.20261018
  - @neurodesk/synthstrip@0.1.5
  - @neurodesk/brain-extraction@0.4.20261018

## 0.4.20261017

### Patch Changes

- Updated dependencies [b547d52]
  - @neurodesk/webapp-components@0.14.3
  - @neurodesk/runtime-support@0.6.4
  - @neurodesk/synthsr@0.6.20261017
  - @neurodesk/synthstrip@0.1.5
  - @neurodesk/brain-extraction@0.4.20261017

## 0.4.20261016

### Patch Changes

- Persist checksum-verified model and example caches across browser restarts. Bind runtime caches to each document’s checksum manifest to avoid reusing bytes from a different deployment.
- Updated dependencies
  - @neurodesk/webapp-components@0.14.2
  - @neurodesk/runtime-support@0.6.3
  - @neurodesk/synthsr@0.6.20261016
  - @neurodesk/synthstrip@0.1.5
  - @neurodesk/brain-extraction@0.4.20261016
- 245a946: Run SynthStrip brain extraction through the streamed browser session, layer by layer in slabs,
  as SYNcro does. An image covering a whole head at 1 mm conforms to SynthStrip's 256³ grid, where
  one whole-graph ONNX Runtime session ran out of WebAssembly memory with "std::bad_alloc".
  The streamed session reproduces the recorded browser SynthStrip mask bit for bit.
- Updated dependencies [7443048]

  - @neurodesk/webapp-components@0.14.1
  - @neurodesk/runtime-support@0.6.2
  - @neurodesk/synthsr@0.6.20261016
  - @neurodesk/synthstrip@0.1.5
  - @neurodesk/brain-extraction@0.4.20261016

- Persist checksum-verified model and example caches across browser restarts. Bind runtime caches to each document’s checksum manifest to avoid reusing bytes from a different deployment.

- Updated dependencies

  - @neurodesk/webapp-components@0.14.2
  - @neurodesk/runtime-support@0.6.3
  - @neurodesk/synthsr@0.6.20261016
  - @neurodesk/synthstrip@0.1.5
  - @neurodesk/brain-extraction@0.4.20261016

- 245a946: Run SynthStrip brain extraction through the streamed browser session, layer by layer in slabs,
  as SYNcro does. An image covering a whole head at 1 mm conforms to SynthStrip's 256³ grid, where
  one whole-graph ONNX Runtime session ran out of WebAssembly memory with "std::bad_alloc".
  The streamed session reproduces the recorded browser SynthStrip mask bit for bit.

- Updated dependencies [7443048]
  - @neurodesk/webapp-components@0.14.1
  - @neurodesk/runtime-support@0.6.2
  - @neurodesk/synthsr@0.6.20261016
  - @neurodesk/synthstrip@0.1.5
  - @neurodesk/brain-extraction@0.4.20261016

## 0.4.20261015

### Patch Changes

- Updated dependencies [c74b26f]
  - @neurodesk/runtime-support@0.6.1
  - @neurodesk/synthsr@0.6.20261015
  - @neurodesk/synthstrip@0.1.5
  - @neurodesk/brain-extraction@0.4.20261015
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
  - @neurodesk/brain-extraction@0.4.20261015
- Updated dependencies [84d192a]

  - @neurodesk/synthsr@0.6.20261015
  - @neurodesk/brain-extraction@0.4.20261015

- Updated dependencies [c74b26f]

  - @neurodesk/runtime-support@0.6.1
  - @neurodesk/synthsr@0.6.20261015
  - @neurodesk/synthstrip@0.1.5
  - @neurodesk/brain-extraction@0.4.20261015

- dd65e6a: Visual refresh: Inter, neutral greys with the Neurodesk logo green for action,
  focus and selection only, a compact 48px app bar, sentence-case section titles
  and a quieter status bar. The example menu is now the input control: examples,
  then Choose files… and Choose folder…. The whole window, the viewer included,
  accepts dropped files; a drop mid-session replaces the inputs with Undo in the
  status bar. Before any input the status reads "Drag and drop files". MuscleMap
  drops its separate drop box and Add File(s) button.

- Updated dependencies [0569da8]

- Updated dependencies [dd65e6a]

- Updated dependencies [dcc74e7]

  - @neurodesk/runtime-support@0.6.0
  - @neurodesk/webapp-components@0.14.0
  - @neurodesk/synthsr@0.6.20261015
  - @neurodesk/synthstrip@0.1.5
  - @neurodesk/brain-extraction@0.4.20261015

- Updated dependencies [84d192a]
  - @neurodesk/synthsr@0.6.20261015
  - @neurodesk/brain-extraction@0.4.20261015

## 0.4.20261014

### Patch Changes

- Updated dependencies [27c9549]
- Updated dependencies [850e642]
- Updated dependencies [ad92e2f]

  - @neurodesk/runtime-support@0.5.0
  - @neurodesk/webapp-components@0.13.0
  - @neurodesk/synthsr@0.6.20261014
  - @neurodesk/synthstrip@0.1.5
  - @neurodesk/brain-extraction@0.4.20261014

- Updated dependencies [27c9549]

- Updated dependencies [850e642]

- Updated dependencies [ad92e2f]
  - @neurodesk/runtime-support@0.5.0
  - @neurodesk/webapp-components@0.13.0
  - @neurodesk/synthsr@0.6.20261014
  - @neurodesk/synthstrip@0.1.5
  - @neurodesk/brain-extraction@0.4.20261014

## 0.4.20261012

### Patch Changes

- Updated dependencies
  - @neurodesk/webapp-components@0.12.3
  - @neurodesk/runtime-support@0.4.3
  - @neurodesk/synthsr@0.6.20261012
  - @neurodesk/synthstrip@0.1.5
  - @neurodesk/brain-extraction@0.4.20261012

## 0.4.20261010

### Patch Changes

- Preserve original operation failures while draining GPU error scopes and reject failed DICOM field fallback tasks without hanging. Resolve correctness findings with switch scopes, safe own-property checks, equivalent regular expressions and documented optional cleanup/cache behavior. Surface actionable release, filesystem and schema preload failures; retain scientific literals and arithmetic.
- Updated dependencies
  - @neurodesk/webapp-components@0.12.2
  - @neurodesk/runtime-support@0.4.2
  - @neurodesk/synthsr@0.6.20261010
  - @neurodesk/synthstrip@0.1.5
  - @neurodesk/brain-extraction@0.4.20261010
- Updated dependencies

  - @neurodesk/runtime-support@0.4.1
  - @neurodesk/webapp-components@0.12.1
  - @neurodesk/brain-extraction@0.4.20261010
  - @neurodesk/synthsr@0.6.20261010
  - @neurodesk/synthstrip@0.1.5

- Preserve original operation failures while draining GPU error scopes and reject failed DICOM field fallback tasks without hanging. Resolve correctness findings with switch scopes, safe own-property checks, equivalent regular expressions and documented optional cleanup/cache behavior. Surface actionable release, filesystem and schema preload failures; retain scientific literals and arithmetic.

- Updated dependencies

  - @neurodesk/webapp-components@0.12.2
  - @neurodesk/runtime-support@0.4.2
  - @neurodesk/synthsr@0.6.20261010
  - @neurodesk/synthstrip@0.1.5
  - @neurodesk/brain-extraction@0.4.20261010

  - @neurodesk/runtime-support@0.4.1
  - @neurodesk/webapp-components@0.12.1
  - @neurodesk/brain-extraction@0.4.20261010
  - @neurodesk/synthsr@0.6.20261010
  - @neurodesk/synthstrip@0.1.5

- Updated dependencies

  - @neurodesk/webapp-components@0.12.2
  - @neurodesk/runtime-support@0.4.2
  - @neurodesk/synthsr@0.6.20261010
  - @neurodesk/synthstrip@0.1.5
  - @neurodesk/brain-extraction@0.4.20261010

- Updated dependencies
  - @neurodesk/runtime-support@0.4.1
  - @neurodesk/webapp-components@0.12.1
  - @neurodesk/brain-extraction@0.4.20261010
  - @neurodesk/synthsr@0.6.20261010
  - @neurodesk/synthstrip@0.1.5

## 0.4.20261009

### Minor Changes

- bb10737: Add the `brain-extraction` command line: SynthStrip on ONNX Runtime Node and BET on a single-threaded WebAssembly build of the same qsm-core BET the web app runs, writing the web app's brain image and mask under the same names. It takes `--method synthstrip|bet` and BET's `--fractional-intensity`; `--method mindgrab` explains that MindGrab follows with #162. The SynthStrip model is installed with SHA-256 checks on every load, and the command line ships as portable Linux x64 and Windows x64 archives and a signed macOS arm64 installer that each bundle Node and the model. Each release must reproduce the web app's results on the pinned T1 example, as recorded in a browser: identical NIfTI headers, brain intensities and mask voxel counts, a BET mask identical bit for bit, and a SynthStrip mask Dice of 0.99995 or better. The web app now takes its download names and NIfTI writer from `@neurodesk/brain-extraction`, and its SynthStrip model pin from `@neurodesk/synthstrip/model`.
- 07f3a14: Add `--method mindgrab` to the `brain-extraction` command line. It runs `@brainchop/mindgrab`'s CPU module through the shared Node driver with the web app's options and writes the brain image and mask the web app downloads. The web app and the command line now both use `@brainchop/mindgrab` 0.1.20260925. Each release must reproduce the web app's MindGrab CPU result on the pinned T1 example bit for bit, as recorded in a browser, with identical NIfTI headers and brain intensities.

- bb10737: Add the `brain-extraction` command line: SynthStrip on ONNX Runtime Node and BET on a single-threaded WebAssembly build of the same qsm-core BET the web app runs, writing the web app's brain image and mask under the same names. It takes `--method synthstrip|bet` and BET's `--fractional-intensity`; `--method mindgrab` explains that MindGrab follows with #162. The SynthStrip model is installed with SHA-256 checks on every load, and the command line ships as portable Linux x64 and Windows x64 archives and a signed macOS arm64 installer that each bundle Node and the model. Each release must reproduce the web app's results on the pinned T1 example, as recorded in a browser: identical NIfTI headers, brain intensities and mask voxel counts, a BET mask identical bit for bit, and a SynthStrip mask Dice of 0.99995 or better. The web app now takes its download names and NIfTI writer from `@neurodesk/brain-extraction`, and its SynthStrip model pin from `@neurodesk/synthstrip/model`.

- 07f3a14: Add `--method mindgrab` to the `brain-extraction` command line. It runs `@brainchop/mindgrab`'s CPU module through the shared Node driver with the web app's options and writes the brain image and mask the web app downloads. The web app and the command line now both use `@brainchop/mindgrab` 0.1.20260925. Each release must reproduce the web app's MindGrab CPU result on the pinned T1 example bit for bit, as recorded in a browser, with identical NIfTI headers and brain intensities.

### Patch Changes

- Updated dependencies [bb10737]
- Updated dependencies [07f3a14]
- Updated dependencies [66bf9e9]
- Updated dependencies [501ea0c]
- Updated dependencies [64ffefa]

  - @neurodesk/brain-extraction@0.4.20261009
  - @neurodesk/synthstrip@0.1.4
  - @neurodesk/webapp-components@0.12.0
  - @neurodesk/runtime-support@0.3.0
  - @neurodesk/synthsr@0.6.20261009

- Updated dependencies [bb10737]

- Updated dependencies [07f3a14]

- Updated dependencies [66bf9e9]

- Updated dependencies [501ea0c]

- Updated dependencies [64ffefa]
  - @neurodesk/brain-extraction@0.4.20261009
  - @neurodesk/synthstrip@0.1.4
  - @neurodesk/webapp-components@0.12.0
  - @neurodesk/runtime-support@0.3.0
  - @neurodesk/synthsr@0.6.20261009

## 0.3.20261007

### Patch Changes

- Updated dependencies [22aa4bf]
  - @neurodesk/webapp-components@0.11.1
  - @neurodesk/runtime-support@0.2.1
  - @neurodesk/synthsr@0.6.20261007
  - @neurodesk/synthstrip@0.1.3
  - @neurodesk/brain-extraction@0.1.23
- Updated dependencies
  - @neurodesk/webapp-components@0.11.0
  - @neurodesk/runtime-support@0.2.0
  - @neurodesk/synthsr@0.6.20261007
  - @neurodesk/synthstrip@0.1.2
  - @neurodesk/brain-extraction@0.1.22
- Updated dependencies [70f2770]

  - @neurodesk/webapp-components@0.10.2
  - @neurodesk/synthsr@0.6.20261007
  - @neurodesk/brain-extraction@0.1.21

- Updated dependencies [22aa4bf]

  - @neurodesk/webapp-components@0.11.1
  - @neurodesk/runtime-support@0.2.1
  - @neurodesk/synthsr@0.6.20261007
  - @neurodesk/synthstrip@0.1.3
  - @neurodesk/brain-extraction@0.1.23

- Updated dependencies

  - @neurodesk/webapp-components@0.11.0
  - @neurodesk/runtime-support@0.2.0
  - @neurodesk/synthsr@0.6.20261007
  - @neurodesk/synthstrip@0.1.2
  - @neurodesk/brain-extraction@0.1.22

- Updated dependencies [70f2770]
  - @neurodesk/webapp-components@0.10.2
  - @neurodesk/synthsr@0.6.20261007
  - @neurodesk/brain-extraction@0.1.21

## 0.3.20261005

### Patch Changes

- Updated dependencies
  - @neurodesk/synthsr@0.6.20261005
  - @neurodesk/brain-extraction@0.1.20

## 0.3.20261004

### Patch Changes

- Updated dependencies
  - @neurodesk/synthsr@0.6.20261004
  - @neurodesk/brain-extraction@0.1.19
- Updated dependencies
  - @neurodesk/webapp-components@0.10.1
  - @neurodesk/synthsr@0.6.20261004
  - @neurodesk/brain-extraction@0.1.18
- bf52742: Correct the brain mask in the viewer before downloading it. Edit on the brain mask row shows the mask in red over the input image and opens the shared editor with Draw, Erase and Fill tools. Apply replaces the mask in the Output list, which then reads `Brain mask (edited)`, and Download returns the edited mask under the same name as a uint8 NIfTI. Cancel discards the strokes. Loading a new image or running extraction again closes an open edit. The brain image and the run report remain as extraction produced them.
- Updated dependencies [0204fe1]
- Updated dependencies [ec85a09]
  - @neurodesk/webapp-components@0.10.0
  - @neurodesk/synthsr@0.6.20261004
  - @neurodesk/brain-extraction@0.1.17
- Updated dependencies [257192b]
  - @neurodesk/synthsr@0.6.20261004
  - @neurodesk/synthstrip@0.1.1
  - @neurodesk/runtime-support@0.1.3
  - @neurodesk/brain-extraction@0.1.16
- Updated dependencies

  - @neurodesk/webapp-components@0.9.0
  - @neurodesk/synthsr@0.5.20261004
  - @neurodesk/brain-extraction@0.1.15

- Updated dependencies

  - @neurodesk/synthsr@0.6.20261004
  - @neurodesk/brain-extraction@0.1.19

  - @neurodesk/webapp-components@0.10.1
  - @neurodesk/synthsr@0.6.20261004
  - @neurodesk/brain-extraction@0.1.18

- bf52742: Correct the brain mask in the viewer before downloading it. Edit on the brain mask row shows the mask in red over the input image and opens the shared editor with Draw, Erase and Fill tools. Apply replaces the mask in the Output list, which then reads `Brain mask (edited)`, and Download returns the edited mask under the same name as a uint8 NIfTI. Cancel discards the strokes. Loading a new image or running extraction again closes an open edit. The brain image and the run report remain as extraction produced them.

- Updated dependencies [0204fe1]

- Updated dependencies [ec85a09]

  - @neurodesk/webapp-components@0.10.0
  - @neurodesk/synthsr@0.6.20261004
  - @neurodesk/brain-extraction@0.1.17

- Updated dependencies [257192b]

  - @neurodesk/synthsr@0.6.20261004
  - @neurodesk/synthstrip@0.1.1
  - @neurodesk/runtime-support@0.1.3
  - @neurodesk/brain-extraction@0.1.16

  - @neurodesk/webapp-components@0.9.0
  - @neurodesk/synthsr@0.5.20261004
  - @neurodesk/brain-extraction@0.1.15

- Updated dependencies [257192b]

  - @neurodesk/synthsr@0.6.20261004
  - @neurodesk/synthstrip@0.1.1
  - @neurodesk/runtime-support@0.1.3
  - @neurodesk/brain-extraction@0.1.16

- Updated dependencies

  - @neurodesk/synthsr@0.6.20261004
  - @neurodesk/brain-extraction@0.1.19

- Updated dependencies

  - @neurodesk/webapp-components@0.10.1
  - @neurodesk/synthsr@0.6.20261004
  - @neurodesk/brain-extraction@0.1.18

- Updated dependencies
  - @neurodesk/webapp-components@0.9.0
  - @neurodesk/synthsr@0.5.20261004
  - @neurodesk/brain-extraction@0.1.15

## 0.3.20261003

### Patch Changes

- Updated dependencies
  - @neurodesk/webapp-components@0.8.0
  - @neurodesk/synthsr@0.5.20261003
  - @neurodesk/brain-extraction@0.1.14

## 0.3.20260930

### Patch Changes

- Updated dependencies
- Updated dependencies

  - @neurodesk/webapp-components@0.7.0
  - @neurodesk/synthsr@0.5.20260930
  - @neurodesk/brain-extraction@0.1.13

- Updated dependencies

  - @neurodesk/webapp-components@0.6.2
  - @neurodesk/synthsr@0.5.20260930
  - @neurodesk/brain-extraction@0.1.12

- Updated dependencies

  - @neurodesk/webapp-components@0.7.0
  - @neurodesk/synthsr@0.5.20260930
  - @neurodesk/brain-extraction@0.1.13

  - @neurodesk/webapp-components@0.7.0
  - @neurodesk/synthsr@0.5.20260930
  - @neurodesk/brain-extraction@0.1.13

## 0.3.20260928

### Patch Changes

- Updated dependencies

  - @neurodesk/webapp-components@0.6.1
  - @neurodesk/synthsr@0.5.20260928
  - @neurodesk/brain-extraction@0.1.11

- 93381e8: Every app now opens on its workspace and shows live status only in the bottom bar: a short message, a progress bar, elapsed time and a cancel × that appears while a run can be cancelled. Start pages, landing overlays and welcome modals are gone, and their copy moved to About. Every app has a technical log below the viewer that starts collapsed. Sidebar help longer than 90 characters moved into info tooltips or About, and each sidebar has one primary action. `ProgressManager` now drives the design-system footer, including the elapsed counter and the cancel button.

  The shared example selector shows one short line once an example loads; the description and expected result moved to a tooltip beside the Example label. NiiMath gained the shared layout tabs and About dialog and no longer ships app CSS.

- Updated dependencies
- Updated dependencies [93381e8]
- Updated dependencies [93381e8]

  - @neurodesk/webapp-components@0.6.0
  - @neurodesk/synthsr@0.5.20260928
  - @neurodesk/brain-extraction@0.1.10

- Updated dependencies

- Updated dependencies [93381e8]

  - @neurodesk/webapp-components@0.6.0
  - @neurodesk/synthsr@0.5.20260928
  - @neurodesk/brain-extraction@0.1.10

  - @neurodesk/webapp-components@0.6.1
  - @neurodesk/synthsr@0.5.20260928
  - @neurodesk/brain-extraction@0.1.11

### Minor Changes

- Expose typed operations across the application catalog, including multiple inputs, DICOM series selection, variable artifacts and viewer workflows. Share awaited processing and cancellation between each app and its agent adapter. Publish verified result reports and scientific provenance.

  Add bounded desktop viewer sessions and MCP controls using public viewer APIs. Native SynthSeg now reports per-label counts and physical volumes. Include real-model CPU checks and a Mac runner for Metal, WebGPU and buffer-planning evidence without raising the validated SynthSeg limit.

## 0.2.20260928

### Minor Changes

- Publish versioned app automation contracts and checksummed run reports for brain extraction and SynthSeg. Add shared run identities, explicit completion and cancellation, and SynthSeg label-volume summaries. Generate browser jobs from the contracts and expose discovery, validation, asynchronous execution, cancellation and artifact resources through the desktop's local MCP server, with an optional native SynthSeg engine.

### Patch Changes

- Updated dependencies
  - @neurodesk/webapp-components@0.5.0
  - @neurodesk/synthsr@0.4.20260928
  - @neurodesk/brain-extraction@0.1.9

## 0.1.20260924

### Patch Changes

- Updated dependencies [39a9ea5]
  - @neurodesk/webapp-components@0.4.5
  - @neurodesk/synthsr@0.4.20260924
  - @neurodesk/brain-extraction@0.1.8

## 0.1.20260923

### Patch Changes

- 3e6b9a7: Add a Support action to the shared application bar, so every webapp offers one
  route to the maintainers. It opens a GitHub issue on the monorepo that is
  already filled in: the app and its build, the browser, the window size, whether
  WebGPU and cross-origin isolation are available, and headings that ask for
  reproduction steps or, for a feature suggestion, what the app should do instead.
  The prefilled page address keeps only origin and path, because app state in a
  query or fragment can name a user's own files.
  - @neurodesk/synthsr@0.4.20260923
  - @neurodesk/brain-extraction@0.1.7

## 0.1.20260920

### Patch Changes

- Updated dependencies [4959500]

  - @neurodesk/webapp-components@0.4.4
  - @neurodesk/synthsr@0.4.20260920
  - @neurodesk/brain-extraction@0.1.6

- Updated dependencies

  - @neurodesk/webapp-components@0.4.3
  - @neurodesk/synthsr@0.4.20260920
  - @neurodesk/brain-extraction@0.1.5

- efd8af3: Show the Example control before the file picker in every app, replace the registration apps' stale "Loading the default images" empty state, give FireANTs a CPU time budget and progress messages, ship BrowserQC's CPU MindGrab bundle with a longer segmentation budget, select CPU processing in SynthSR and brain extraction when no WebGPU adapter exists, start MuscleMap at 50 % overlap without WebGPU, and run VesselBoost's hosted example workflow in its browser tests.
- Updated dependencies

  - @neurodesk/webapp-components@0.4.2
  - @neurodesk/synthsr@0.4.20260920
  - @neurodesk/brain-extraction@0.1.4

- efd8af3: Show the Example control before the file picker in every app, replace the registration apps' stale "Loading the default images" empty state, give FireANTs a CPU time budget and progress messages, ship BrowserQC's CPU MindGrab bundle with a longer segmentation budget, select CPU processing in SynthSR and brain extraction when no WebGPU adapter exists, start MuscleMap at 50 % overlap without WebGPU, and run VesselBoost's hosted example workflow in its browser tests.

- Updated dependencies

  - @neurodesk/webapp-components@0.4.2
  - @neurodesk/synthsr@0.4.20260920
  - @neurodesk/brain-extraction@0.1.4

  - @neurodesk/webapp-components@0.4.3
  - @neurodesk/synthsr@0.4.20260920
  - @neurodesk/brain-extraction@0.1.5

## 0.1.20260918

### Patch Changes

- Include and initialize the Rayon worker helpers required by QSMbly's updated BET runtime.
- Updated dependencies
  - @neurodesk/webapp-components@0.3.1
- Updated dependencies

  - @neurodesk/webapp-components@0.4.1
  - @neurodesk/synthsr@0.4.20260918
  - @neurodesk/brain-extraction@0.1.3

- Replace shared UI builders with light-DOM custom elements for consoles, file fields, result lists, viewer toolbars and example selectors. Migrate app callers, isolate control IDs and upload scopes, and preserve state while cleaning up listeners and cancelled downloads across component removal.
- Updated dependencies

  - @neurodesk/webapp-components@0.4.0
  - @neurodesk/synthsr@0.4.20260918
  - @neurodesk/brain-extraction@0.1.2

- Include and initialize the Rayon worker helpers required by QSMbly's updated BET runtime.

- Updated dependencies

  - @neurodesk/webapp-components@0.3.1

- Replace shared UI builders with light-DOM custom elements for consoles, file fields, result lists, viewer toolbars and example selectors. Migrate app callers, isolate control IDs and upload scopes, and preserve state while cleaning up listeners and cancelled downloads across component removal.

  - @neurodesk/webapp-components@0.4.0
  - @neurodesk/synthsr@0.4.20260918
  - @neurodesk/brain-extraction@0.1.2

- Updated dependencies
  - @neurodesk/webapp-components@0.4.0
  - @neurodesk/synthsr@0.4.20260918
  - @neurodesk/brain-extraction@0.1.2

## 0.1.20260916

### Patch Changes

- Standardize example selection across the app catalog with complete scientific input bundles, shared cancellation and retry, and explicit processing. Add missing examples, curate existing datasets, fix QSMbly retry and TopoFit cancellation, and require example manifests and browser coverage for every app and the generator.
- Updated dependencies

  - @neurodesk/webapp-components@0.3.0
  - @neurodesk/synthsr@0.4.20260916
  - @neurodesk/brain-extraction@0.1.1

- Standardize example selection across the app catalog with complete scientific input bundles, shared cancellation and retry, and explicit processing. Add missing examples, curate existing datasets, fix QSMbly retry and TopoFit cancellation, and require example manifests and browser coverage for every app and the generator.

- Updated dependencies
  - @neurodesk/webapp-components@0.3.0
  - @neurodesk/synthsr@0.4.20260916
  - @neurodesk/brain-extraction@0.1.1

## 0.1.20260915

### Patch Changes

- Add T1 and T2 head MRI examples with cancellable downloads and retry. Remove the BET method description and clarify that the current browser SynthStrip adapter uses the CPU. Require declared, pinned examples and browser coverage for newly generated apps.

- Publish Brain extraction in a separately versioned offline suite.

- Include Brain extraction in the offline desktop suite with its SynthStrip model and a real BET extraction and download check. Reuse the shared MindGrab adapter in SYNcro.

### Minor Changes

- Add Brain extraction with QSMbly's Rust BET, MindGrab and SynthStrip. Load NIfTI or DICOM, view and download brain images and binary masks, and cancel processing. Offer BET's fractional intensity setting and optional MindGrab CPU processing. Share SYNcro's MindGrab adapter with the new app.
