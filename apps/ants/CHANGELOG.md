# ants

## 0.5.20261024

### Patch Changes

- Updated dependencies [0066f60]
  - @neurodesk/webapp-components@0.21.1
  - @neurodesk/ants@0.5.20261024
  - @neurodesk/runtime-support@0.9.12
- Updated dependencies [941884c]
- Updated dependencies [a028e96]
- Updated dependencies [650ce5f]
- Updated dependencies [343c256]
- Updated dependencies [941884c]
  - @neurodesk/webapp-components@0.21.0
  - @neurodesk/ants@0.5.20261024
  - @neurodesk/runtime-support@0.9.11
- Updated dependencies [3a7e5bb]
- Updated dependencies [72cbb8d]
  - @neurodesk/webapp-components@0.20.0
  - @neurodesk/ants@0.5.20261024
  - @neurodesk/runtime-support@0.9.10
- Updated dependencies [3fc9cf2]
  - @neurodesk/webapp-components@0.19.1
  - @neurodesk/ants@0.5.20261024
  - @neurodesk/runtime-support@0.9.9
- Updated dependencies
  - @neurodesk/webapp-components@0.21.1
  - @neurodesk/ants@0.5.20261024
  - @neurodesk/runtime-support@0.9.14
- Updated dependencies [328cb77]
  - @neurodesk/webapp-components@0.20.1
  - @neurodesk/ants@0.5.20261024
  - @neurodesk/runtime-support@0.9.13
- Updated dependencies [14a8b29]
- Updated dependencies [941884c]
  - @neurodesk/webapp-components@0.20.0
  - @neurodesk/ants@0.5.20261024
  - @neurodesk/runtime-support@0.9.12
- Updated dependencies
  - @neurodesk/webapp-components@0.19.3
  - @neurodesk/ants@0.5.20261024
  - @neurodesk/runtime-support@0.9.11
- Updated dependencies
- Updated dependencies
  - @neurodesk/webapp-components@0.19.2
  - @neurodesk/registration@0.1.2
  - @neurodesk/ants@0.5.20261024
  - @neurodesk/runtime-support@0.9.10

## 0.5.20261022

### Patch Changes

- Updated dependencies [d32b485]
  - @neurodesk/webapp-components@0.19.0
  - @neurodesk/ants@0.5.20261022
  - @neurodesk/runtime-support@0.9.8

## 0.5.20261020

### Minor Changes

- 3329c39: The registration apps load their images through one shared fixed/moving pair
  (`nd-image-pair`, `createImagePair`). Each app now says fixed and moving, never
  stationary. The fixed card comes first. Each card has explicit "Load fixed
  image…" / "Load moving image…" and "Folder…" pickers, a drop zone, a summary
  of size and spacing, a series select and a clear ×, and Swap exchanges the two.
  Examples fill the slots by role through the same path as a user's file, and a
  failed load keeps the previous image. The fixed card offers built-in templates from
  the new `registry/templates.json`: FSL MNI152 1 mm brain and head and the ICBM152
  avg152 2 mm head, downloaded and checked with `fetchModel`, and cited in each app.
  elastix offers them for 3D images only. SYNcro shows its MNI152 template as a
  locked fixed image, its scan is the moving image, and it fetches the template from
  the catalogue address. Brain extraction in ANTs, Greedy and FireANTs has its own
  Fixed and Moving buttons below the pair.

  Cancelling an example preserves the previous image even when the app supplies
  its own cancellation signal. Image summaries convert NIfTI spatial units to
  millimetres before showing voxel spacing.

### Patch Changes

- Updated dependencies
  - @neurodesk/runtime-support@0.9.7
  - @neurodesk/ants@0.5.20261020
- Updated dependencies [c865c0c]
  - @neurodesk/webapp-components@0.17.1
  - @neurodesk/ants@0.5.20261020
  - @neurodesk/runtime-support@0.8.2
- Updated dependencies [a36fde4]

  - @neurodesk/webapp-components@0.18.0
  - @neurodesk/ants@0.5.20261020
  - @neurodesk/runtime-support@0.9.5

- Updated dependencies [14db080]

- Updated dependencies [03261d0]

- Updated dependencies [c865c0c]

  - @neurodesk/webapp-components@0.17.0
  - @neurodesk/ants@0.5.20261020
  - @neurodesk/runtime-support@0.9.4

- ac01831: These apps no longer refuse to start in a browser without WebGPU. NiiVue falls back to WebGL2 when WebGPU is absent, and MindGrab falls back to WebGL2 or the threaded CPU, so the viewers, defacing, registration, brain extraction, quality control and meshing now run in browsers such as Firefox on Linux. When the browser offers neither WebGPU nor WebGL2, the app says that the image viewer cannot start.

- 14b8248: MindGrab's automatic backend no longer runs WebGL2 on a software renderer (SwiftShader, llvmpipe), which returned a blank brain mask without WebGPU; the threaded CPU module runs instead. The choice and MindGrab's own output appear in the technical log.

- 46935f7: Serialize example imports and file replacements so a cancelled image rollback finishes before the next load. Restore the primary picker when file actions are disabled and stream compressed NIfTI headers for image summaries. Tighten the ANTs example checks so "not brain extracted" cannot pass as "brain extracted".

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
  - @neurodesk/ants@0.5.20261020

- Updated dependencies [d1fa022]

  - @neurodesk/webapp-components@0.16.3
  - @neurodesk/runtime-support@0.9.3
  - @neurodesk/ants@0.5.20261020

- Updated dependencies [4b40da1]

  - @neurodesk/webapp-components@0.17.0
  - @neurodesk/ants@0.5.20261020
  - @neurodesk/runtime-support@0.9.4

  - @neurodesk/webapp-components@0.16.3
  - @neurodesk/runtime-support@0.9.3
  - @neurodesk/ants@0.5.20261020

- Updated dependencies [a36fde4]

- Updated dependencies

- Updated dependencies

  - @neurodesk/webapp-components@0.17.0
  - @neurodesk/ants@0.5.20261020
  - @neurodesk/runtime-support@0.8.1

- Updated dependencies

  - @neurodesk/webapp-components@0.18.0
  - @neurodesk/ants@0.5.20261020
  - @neurodesk/runtime-support@0.8.2

- Updated dependencies
  - @neurodesk/runtime-support@0.9.5
  - @neurodesk/webapp-components@0.17.1
  - @neurodesk/ants@0.5.20261020
- Updated dependencies [4b40da1]

- Updated dependencies
  - @neurodesk/webapp-components@0.17.2
  - @neurodesk/runtime-support@0.9.6
  - @neurodesk/ants@0.5.20261020
- Updated dependencies [14db080]

## 0.5.20261019

### Patch Changes

- Updated dependencies [af2e8db]

- Updated dependencies [b3404ec]

  - @neurodesk/webapp-components@0.16.3
  - @neurodesk/ants@0.5.20261019
  - @neurodesk/runtime-support@0.9.3

- Updated dependencies [da2584b]
  - @neurodesk/runtime-support@0.9.2
  - @neurodesk/ants@0.5.20261019

## 0.5.20261018

### Minor Changes

- 3329c39: The registration apps load their images through one shared fixed/moving pair
  (`nd-image-pair`, `createImagePair`). Each app now says fixed and moving, never
  stationary. The fixed card comes first. Each card has explicit "Load fixed
  image…" / "Load moving image…" and "Folder…" pickers, a drop zone, a summary
  of size and spacing, a series select and a clear ×, and Swap exchanges the two.
  Examples fill the slots by role through the same path as a user's file, and a
  failed load keeps the previous image. The fixed card offers built-in templates from
  the new `registry/templates.json`: FSL MNI152 1 mm brain and head and the ICBM152
  avg152 2 mm head, downloaded and checked with `fetchModel`, and cited in each app.
  elastix offers them for 3D images only. SYNcro shows its MNI152 template as a
  locked fixed image, its scan is the moving image, and it fetches the template from
  the catalogue address. Brain extraction in ANTs, Greedy and FireANTs has its own
  Fixed and Moving buttons below the pair.

  Cancelling an example preserves the previous image even when the app supplies
  its own cancellation signal. Image summaries convert NIfTI spatial units to
  millimetres before showing voxel spacing.

### Patch Changes

- Updated dependencies [7c0d201]

  - @neurodesk/webapp-components@0.16.2
  - @neurodesk/ants@0.5.20261018
  - @neurodesk/runtime-support@0.9.1

- ac01831: These apps no longer refuse to start in a browser without WebGPU. NiiVue falls back to WebGL2 when WebGPU is absent, and MindGrab falls back to WebGL2 or the threaded CPU, so the viewers, defacing, registration, brain extraction, quality control and meshing now run in browsers such as Firefox on Linux. When the browser offers neither WebGPU nor WebGL2, the app says that the image viewer cannot start.

  - @neurodesk/ants@0.5.20261018

- 46935f7: Serialize example imports and file replacements so a cancelled image rollback finishes before the next load. Restore the primary picker when file actions are disabled and stream compressed NIfTI headers for image summaries. Tighten the ANTs example checks so "not brain extracted" cannot pass as "brain extracted".

- Updated dependencies

- Updated dependencies [46935f7]

  - @neurodesk/runtime-support@0.9.0
  - @neurodesk/webapp-components@0.16.1
  - @neurodesk/ants@0.5.20261018

- Updated dependencies [ea2a6d2]

- Updated dependencies [0511cd7]

- Updated dependencies [a07f659]

- Updated dependencies [3329c39]

  - @neurodesk/webapp-components@0.16.0
  - @neurodesk/runtime-support@0.8.0
  - @neurodesk/ants@0.5.20261018

- Updated dependencies [3329c39]

  - @neurodesk/webapp-components@0.16.0
  - @neurodesk/runtime-support@0.8.0
  - @neurodesk/ants@0.5.20261018

## 0.4.20261018

### Patch Changes

- Updated dependencies [b67e4e9]

  - @neurodesk/runtime-support@0.7.2
  - @neurodesk/webapp-components@0.15.1
  - @neurodesk/ants@0.4.20261018

- Updated dependencies [b68209b]

  - @neurodesk/webapp-components@0.15.0
  - @neurodesk/runtime-support@0.7.1
  - @neurodesk/ants@0.4.20261018

- Updated dependencies [67a5a8f]

- Updated dependencies [b8b37d6]

- Updated dependencies [2ae93ae]

- Updated dependencies [ccb2970]

  - @neurodesk/runtime-support@0.7.0
  - @neurodesk/webapp-components@0.14.4
  - @neurodesk/ants@0.4.20261018

- Updated dependencies [67a5a8f]

  - @neurodesk/runtime-support@0.7.0
  - @neurodesk/webapp-components@0.14.4
  - @neurodesk/ants@0.4.20261018

- Updated dependencies [b67e4e9]
  - @neurodesk/runtime-support@0.7.2
  - @neurodesk/webapp-components@0.15.1
  - @neurodesk/ants@0.4.20261018

## 0.4.20261017

### Patch Changes

- Updated dependencies [b547d52]
  - @neurodesk/webapp-components@0.14.3
  - @neurodesk/ants@0.4.20261017
  - @neurodesk/runtime-support@0.6.4

## 0.4.20261016

### Patch Changes

- Updated dependencies

  - @neurodesk/webapp-components@0.14.2
  - @neurodesk/runtime-support@0.6.3
  - @neurodesk/ants@0.4.20261016

- Updated dependencies [7443048]

  - @neurodesk/webapp-components@0.14.1
  - @neurodesk/ants@0.4.20261016
  - @neurodesk/runtime-support@0.6.2

- Updated dependencies [7443048]
  - @neurodesk/webapp-components@0.14.1
  - @neurodesk/ants@0.4.20261016
  - @neurodesk/runtime-support@0.6.2

## 0.4.20261015

### Patch Changes

- Updated dependencies [c74b26f]

  - @neurodesk/runtime-support@0.6.1
  - @neurodesk/ants@0.4.20261015

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
  - @neurodesk/ants@0.4.20261015

- Updated dependencies [dcc74e7]
  - @neurodesk/runtime-support@0.6.0
  - @neurodesk/webapp-components@0.14.0
  - @neurodesk/ants@0.4.20261015

## 0.4.20261014

### Patch Changes

- 850e642: Remove code that nothing calls, found by the unused-code report and checked by
  repository-wide reference searches. The shared preview module no longer carries
  a second NIfTI parser and writer; NiftiUtils remains the only one. Outputs and
  behaviour are unchanged.

- Updated dependencies [27c9549]

- Updated dependencies [850e642]

- Updated dependencies [ad92e2f]
  - @neurodesk/runtime-support@0.5.0
  - @neurodesk/webapp-components@0.13.0
  - @neurodesk/ants@0.4.20261014

## 0.4.20261012

### Patch Changes

- Updated dependencies
  - @neurodesk/webapp-components@0.12.3
  - @neurodesk/ants@0.4.20261012
  - @neurodesk/runtime-support@0.4.3

## 0.4.20261010

### Patch Changes

- Updated dependencies

  - @neurodesk/webapp-components@0.12.2
  - @neurodesk/registration@0.1.1
  - @neurodesk/runtime-support@0.4.2
  - @neurodesk/ants@0.4.20261010

  - @neurodesk/runtime-support@0.4.1
  - @neurodesk/ants@0.4.20261010
  - @neurodesk/webapp-components@0.12.1

- Updated dependencies

  - @neurodesk/webapp-components@0.12.2
  - @neurodesk/registration@0.1.1
  - @neurodesk/runtime-support@0.4.2
  - @neurodesk/ants@0.4.20261010

- Updated dependencies
  - @neurodesk/runtime-support@0.4.1
  - @neurodesk/ants@0.4.20261010
  - @neurodesk/webapp-components@0.12.1

## 0.4.20261009

### Minor Changes

- b4d7594: Add the `ants` command line: `ants MOVING FIXED OUTPUT_DIR` runs the web app's `register` operation in Node with the same ANTs 2.6.2 WebAssembly kernel and ANTsPy `SyN` schedule, and writes the web app's four downloads under the same names. Portable archives for Linux x64 and Windows x64 and a signed macOS installer run offline. Their release check registers the pinned 1 mm example and requires every output to match the web app's own downloads voxel for voxel. MindGrab brain extraction is not included until #162.

### Patch Changes

- Updated dependencies [b4d7594]

- Updated dependencies [66bf9e9]

- Updated dependencies [501ea0c]

- Updated dependencies [64ffefa]
  - @neurodesk/ants@0.4.20261009
  - @neurodesk/webapp-components@0.12.0
  - @neurodesk/runtime-support@0.3.0

## 0.3.20261007

### Patch Changes

- Updated dependencies [22aa4bf]

  - @neurodesk/webapp-components@0.11.1
  - @neurodesk/runtime-support@0.2.1

- Updated dependencies

  - @neurodesk/webapp-components@0.11.0
  - @neurodesk/runtime-support@0.2.0

- Updated dependencies [70f2770]

  - @neurodesk/webapp-components@0.10.2

- Updated dependencies [70f2770]
  - @neurodesk/webapp-components@0.10.2

## 0.3.20261004

### Patch Changes

- Updated dependencies

  - @neurodesk/webapp-components@0.10.1

- Updated dependencies [0204fe1]

- Updated dependencies [ec85a09]

  - @neurodesk/webapp-components@0.10.0

- Updated dependencies [257192b]

  - @neurodesk/runtime-support@0.1.3

  - @neurodesk/webapp-components@0.9.0

- Updated dependencies [257192b]

  - @neurodesk/runtime-support@0.1.3

- Updated dependencies
  - @neurodesk/webapp-components@0.9.0

## 0.3.20261003

### Patch Changes

- Updated dependencies
  - @neurodesk/webapp-components@0.8.0

## 0.3.20260930

### Patch Changes

- Updated dependencies

  - @neurodesk/webapp-components@0.6.2

- Updated dependencies

  - @neurodesk/webapp-components@0.7.0

- Updated dependencies

  - @neurodesk/webapp-components@0.6.2

  - @neurodesk/webapp-components@0.7.0

## 0.3.20260928

### Patch Changes

- 93381e8: Every app now opens on its workspace and shows live status only in the bottom bar: a short message, a progress bar, elapsed time and a cancel × that appears while a run can be cancelled. Start pages, landing overlays and welcome modals are gone, and their copy moved to About. Every app has a technical log below the viewer that starts collapsed. Sidebar help longer than 90 characters moved into info tooltips or About, and each sidebar has one primary action. `ProgressManager` now drives the design-system footer, including the elapsed counter and the cancel button.

  The shared example selector shows one short line once an example loads; the description and expected result moved to a tooltip beside the Example label. NiiMath gained the shared layout tabs and About dialog and no longer ships app CSS.

- Updated dependencies

- Updated dependencies [93381e8]

  - @neurodesk/webapp-components@0.6.0

- Updated dependencies

  - @neurodesk/webapp-components@0.6.1

- Updated dependencies [93381e8]

  - @neurodesk/webapp-components@0.6.0

  - @neurodesk/webapp-components@0.6.1

### Minor Changes

- Expose typed operations across the application catalog, including multiple inputs, DICOM series selection, variable artifacts and viewer workflows. Share awaited processing and cancellation between each app and its agent adapter. Publish verified result reports and scientific provenance.

  Add bounded desktop viewer sessions and MCP controls using public viewer APIs. Native SynthSeg now reports per-label counts and physical volumes. Include real-model CPU checks and a Mac runner for Metal, WebGPU and buffer-planning evidence without raising the validated SynthSeg limit.

## 0.2.20260928

### Patch Changes

- Updated dependencies
  - @neurodesk/webapp-components@0.5.0

## 0.2.20260924

### Patch Changes

- Updated dependencies [39a9ea5]
  - @neurodesk/webapp-components@0.4.5

## 0.2.20260923

### Patch Changes

- 3e6b9a7: Add a Support action to the shared application bar, so every webapp offers one
  route to the maintainers. It opens a GitHub issue on the monorepo that is
  already filled in: the app and its build, the browser, the window size, whether
  WebGPU and cross-origin isolation are available, and headings that ask for
  reproduction steps or, for a feature suggestion, what the app should do instead.
  The prefilled page address keeps only origin and path, because app state in a
  query or fragment can name a user's own files.

## 0.2.20260920

### Patch Changes

- efd8af3: Show the Example control before the file picker in every app, replace the registration apps' stale "Loading the default images" empty state, give FireANTs a CPU time budget and progress messages, ship BrowserQC's CPU MindGrab bundle with a longer segmentation budget, select CPU processing in SynthSR and brain extraction when no WebGPU adapter exists, start MuscleMap at 50 % overlap without WebGPU, and run VesselBoost's hosted example workflow in its browser tests.

- Updated dependencies

  - @neurodesk/webapp-components@0.4.2

- Updated dependencies [4959500]

  - @neurodesk/webapp-components@0.4.4

- Updated dependencies

  - @neurodesk/webapp-components@0.4.3

- Updated dependencies

  - @neurodesk/webapp-components@0.4.2

  - @neurodesk/webapp-components@0.4.3

## 0.2.20260918

### Patch Changes

- Updated dependencies

  - @neurodesk/webapp-components@0.3.1
  - @neurodesk/webapp-components@0.4.1

- Replace shared UI builders with light-DOM custom elements for consoles, file fields, result lists, viewer toolbars and example selectors. Migrate app callers, isolate control IDs and upload scopes, and preserve state while cleaning up listeners and cancelled downloads across component removal.

- Updated dependencies
  - @neurodesk/webapp-components@0.4.0

## 0.2.20260916

### Patch Changes

- Standardize example selection across the app catalog with complete scientific input bundles, shared cancellation and retry, and explicit processing. Add missing examples, curate existing datasets, fix QSMbly retry and TopoFit cancellation, and require example manifests and browser coverage for every app and the generator.

- Updated dependencies
  - @neurodesk/webapp-components@0.3.0

## 0.2.20260915

### Patch Changes

- Updated dependencies

  - @neurodesk/webapp-components@0.2.0

  - @neurodesk/webapp-components@0.2.2

- Updated dependencies

  - @neurodesk/webapp-components@0.2.1

- Updated dependencies

  - @neurodesk/webapp-components@0.2.2

- Updated dependencies

  - @neurodesk/webapp-components@0.2.0

  - @neurodesk/webapp-components@0.2.1

### Minor Changes

- Add a shared Standalone action and offline desktop packaging with included, checksum-verified models and runtime dependencies. Remove the lightNIIng topbar link while retaining its About statement.

## 0.1.20260914

### Patch Changes

- 3cd773f: Greedy and EdgeReg show all three viewer panels on phones. TopoFit conforms axis-aligned and oblique scans through the pinned npm niimath WebAssembly worker. SYNcro now matches the native three-input workflow, offers four checksum-pinned tutorials, defaults to MindGrab and Greedy with SynthStrip and ANTs alternatives, uses niimath for lesion and masking operations, and switches one NiiVue viewer between images with automatic lesion overlays. SynthSR lets adapter limits govern its largest activation buffer, so validated 256×256×192 scans and larger volumes on capable GPUs are attempted while other shared U-Net callers retain their existing limit. Add the standalone ANTS registration demo.

- Updated dependencies [3cd773f]

- Updated dependencies [4add8da]
  - @neurodesk/webapp-components@0.1.5
  - @neurodesk/runtime-support@0.1.2
