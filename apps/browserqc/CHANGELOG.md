# browserqc

## 1.6.20261031

### Patch Changes

- Updated dependencies [d8ac48c]
- Updated dependencies [b84a269]
  - @neurodesk/runtime-support@0.9.19
  - @neurodesk/webapp-components@0.22.3
  - @neurodesk/browserqc@1.6.20261031

## 1.6.20261027

### Patch Changes

- Updated dependencies
  - @neurodesk/webapp-components@0.22.2
  - @neurodesk/browserqc@1.6.20261027
  - @neurodesk/runtime-support@0.9.18
- Updated dependencies
  - @neurodesk/webapp-components@0.22.1
  - @neurodesk/browserqc@1.6.20261027
  - @neurodesk/runtime-support@0.9.17

## 1.6.20261025

### Patch Changes

- Updated dependencies [74b9c63]
  - @neurodesk/runtime-support@0.9.16
  - @neurodesk/browserqc@1.6.20261025
- Updated dependencies [99037b6]
  - @neurodesk/runtime-support@0.9.15
  - @neurodesk/browserqc@1.6.20261025

## 1.6.20261024

### Patch Changes

- Updated dependencies [bd5f3a8, 0066f60]
  - @neurodesk/webapp-components@0.22.0
  - @neurodesk/browserqc@1.6.20261024
  - @neurodesk/runtime-support@0.9.12
- Updated dependencies [941884c]
- Updated dependencies [a028e96]
- Updated dependencies [650ce5f]
- Updated dependencies [343c256]
- Updated dependencies [941884c]
  - @neurodesk/webapp-components@0.21.0
  - @neurodesk/browserqc@1.6.20261024
  - @neurodesk/runtime-support@0.9.11
- Updated dependencies [3a7e5bb]
- Updated dependencies [72cbb8d]
  - @neurodesk/webapp-components@0.20.0
  - @neurodesk/browserqc@1.6.20261024
  - @neurodesk/runtime-support@0.9.10
- Updated dependencies [3fc9cf2]
  - @neurodesk/webapp-components@0.19.1
  - @neurodesk/browserqc@1.6.20261024
  - @neurodesk/runtime-support@0.9.9
- Updated dependencies
  - @neurodesk/webapp-components@0.21.1
  - @neurodesk/browserqc@1.6.20261024
  - @neurodesk/runtime-support@0.9.14
- Updated dependencies [328cb77]
  - @neurodesk/webapp-components@0.20.1
  - @neurodesk/browserqc@1.6.20261024
  - @neurodesk/runtime-support@0.9.13
- Updated dependencies [14a8b29]
- Updated dependencies [941884c]
  - @neurodesk/webapp-components@0.20.0
  - @neurodesk/browserqc@1.6.20261024
  - @neurodesk/runtime-support@0.9.12
- Updated dependencies
  - @neurodesk/webapp-components@0.19.3
  - @neurodesk/browserqc@1.6.20261024
  - @neurodesk/runtime-support@0.9.11
- Updated dependencies
  - @neurodesk/webapp-components@0.19.2
  - @neurodesk/browserqc@1.6.20261024
  - @neurodesk/runtime-support@0.9.10

## 1.6.20261022

### Patch Changes

- Updated dependencies [d32b485]
  - @neurodesk/webapp-components@0.19.0
  - @neurodesk/browserqc@1.6.20261022
  - @neurodesk/runtime-support@0.9.8

## 1.6.20261020

### Patch Changes

- Updated dependencies
  - @neurodesk/runtime-support@0.9.7
  - @neurodesk/browserqc@1.6.20261020
- Updated dependencies [c865c0c]
  - @neurodesk/webapp-components@0.17.1
  - @neurodesk/browserqc@1.6.20261020
  - @neurodesk/runtime-support@0.8.2
- Updated dependencies [a36fde4]

  - @neurodesk/webapp-components@0.18.0
  - @neurodesk/browserqc@1.6.20261020
  - @neurodesk/runtime-support@0.9.5

- Updated dependencies [14db080]

- Updated dependencies [03261d0]

- Updated dependencies [c865c0c]

  - @neurodesk/webapp-components@0.17.0
  - @neurodesk/browserqc@1.6.20261020
  - @neurodesk/runtime-support@0.9.4

- ea2a6d2: Deface and BrowserQC take the avg152 T1 2 mm template from the shared template
  catalogue (`registry/templates.json`) and download it with `fetchTemplateFile`,
  which checks its size and SHA-256 and caches it. Before, Deface fetched the template
  and its face mask with no checksum; the face mask now goes through `fetchModel` with
  its manifest checksum too. BrowserQC's air template, its manifest and Deface's
  manifest name the catalogue URL, so the offline bundle carries one copy of the file
  instead of three. BrowserQC cites the ICBM152 template paper. `fetchTemplateFile`
  names the template when its bytes do not match the pin.

- ac01831: These apps no longer refuse to start in a browser without WebGPU. NiiVue falls back to WebGL2 when WebGPU is absent, and MindGrab falls back to WebGL2 or the threaded CPU, so the viewers, defacing, registration, brain extraction, quality control and meshing now run in browsers such as Firefox on Linux. When the browser offers neither WebGPU nor WebGL2, the app says that the image viewer cannot start.

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

  - @neurodesk/browserqc@1.6.20261020
  - @neurodesk/webapp-components@0.16.0
  - @neurodesk/runtime-support@0.8.0

- Updated dependencies [d1fa022]

  - @neurodesk/webapp-components@0.16.3
  - @neurodesk/runtime-support@0.9.3
  - @neurodesk/browserqc@1.6.20261020

- Updated dependencies [4b40da1]

  - @neurodesk/webapp-components@0.17.0
  - @neurodesk/browserqc@1.6.20261020
  - @neurodesk/runtime-support@0.9.4

  - @neurodesk/webapp-components@0.16.3
  - @neurodesk/runtime-support@0.9.3
  - @neurodesk/browserqc@1.6.20261020

- Updated dependencies [a36fde4]

- Updated dependencies

- Updated dependencies

  - @neurodesk/webapp-components@0.17.0
  - @neurodesk/browserqc@1.6.20261020
  - @neurodesk/runtime-support@0.8.1

- Updated dependencies

  - @neurodesk/webapp-components@0.18.0
  - @neurodesk/browserqc@1.6.20261020
  - @neurodesk/runtime-support@0.8.2

- Updated dependencies
  - @neurodesk/runtime-support@0.9.5
  - @neurodesk/webapp-components@0.17.1
  - @neurodesk/browserqc@1.6.20261020
- Updated dependencies [4b40da1]

- Updated dependencies
  - @neurodesk/webapp-components@0.17.2
  - @neurodesk/runtime-support@0.9.6
  - @neurodesk/browserqc@1.6.20261020
- Updated dependencies [14db080]

## 1.6.20261019

### Patch Changes

- Updated dependencies [af2e8db]

- Updated dependencies [b3404ec]

  - @neurodesk/webapp-components@0.16.3
  - @neurodesk/browserqc@1.6.20261019
  - @neurodesk/runtime-support@0.9.3

- Updated dependencies [da2584b]
  - @neurodesk/runtime-support@0.9.2
  - @neurodesk/browserqc@1.6.20261019

## 1.6.20261018

### Patch Changes

- Updated dependencies [7c0d201]

  - @neurodesk/webapp-components@0.16.2
  - @neurodesk/browserqc@1.6.20261018
  - @neurodesk/runtime-support@0.9.1

- ac01831: These apps no longer refuse to start in a browser without WebGPU. NiiVue falls back to WebGL2 when WebGPU is absent, and MindGrab falls back to WebGL2 or the threaded CPU, so the viewers, defacing, registration, brain extraction, quality control and meshing now run in browsers such as Firefox on Linux. When the browser offers neither WebGPU nor WebGL2, the app says that the image viewer cannot start.

  - @neurodesk/browserqc@1.6.20261018

- Updated dependencies

- Updated dependencies [46935f7]

  - @neurodesk/runtime-support@0.9.0
  - @neurodesk/webapp-components@0.16.1
  - @neurodesk/browserqc@1.6.20261018

- ea2a6d2: Deface and BrowserQC take the avg152 T1 2 mm template from the shared template
  catalogue (`registry/templates.json`) and download it with `fetchTemplateFile`,
  which checks its size and SHA-256 and caches it. Before, Deface fetched the template
  and its face mask with no checksum; the face mask now goes through `fetchModel` with
  its manifest checksum too. BrowserQC's air template, its manifest and Deface's
  manifest name the catalogue URL, so the offline bundle carries one copy of the file
  instead of three. BrowserQC cites the ICBM152 template paper. `fetchTemplateFile`
  names the template when its bytes do not match the pin.

- Updated dependencies [ea2a6d2]

- Updated dependencies [0511cd7]

- Updated dependencies [a07f659]

- Updated dependencies [3329c39]

  - @neurodesk/browserqc@1.6.20261018
  - @neurodesk/webapp-components@0.16.0
  - @neurodesk/runtime-support@0.8.0

- Updated dependencies [b67e4e9]

  - @neurodesk/runtime-support@0.7.2
  - @neurodesk/webapp-components@0.15.1
  - @neurodesk/browserqc@1.6.20261018

- Updated dependencies [b68209b]

  - @neurodesk/webapp-components@0.15.0
  - @neurodesk/runtime-support@0.7.1
  - @neurodesk/browserqc@1.6.20261018

- Updated dependencies [67a5a8f]

- Updated dependencies [b8b37d6]

- Updated dependencies [2ae93ae]

- Updated dependencies [ccb2970]

  - @neurodesk/runtime-support@0.7.0
  - @neurodesk/webapp-components@0.14.4
  - @neurodesk/browserqc@1.6.20261018

- Updated dependencies [67a5a8f]

  - @neurodesk/runtime-support@0.7.0
  - @neurodesk/webapp-components@0.14.4
  - @neurodesk/browserqc@1.6.20261018

- Updated dependencies [b67e4e9]
  - @neurodesk/runtime-support@0.7.2
  - @neurodesk/webapp-components@0.15.1
  - @neurodesk/browserqc@1.6.20261018

## 1.6.20261017

### Patch Changes

- f6f0eeb: Preserve teardown failures after an aborted manual quality-control run settles.

  - @neurodesk/browserqc@1.6.20261017

- Queue opacity updates and report teardown failures after releasing every workspace resource.

- Updated dependencies [b547d52]

  - @neurodesk/webapp-components@0.14.3
  - @neurodesk/browserqc@1.6.20261017
  - @neurodesk/runtime-support@0.6.4

- Queue opacity updates and report teardown failures after releasing every workspace resource.

  - @neurodesk/browserqc@1.6.20261017

- Updated dependencies [b547d52]
  - @neurodesk/webapp-components@0.14.3
  - @neurodesk/browserqc@1.6.20261017
  - @neurodesk/runtime-support@0.6.4

## 1.6.20261016

### Patch Changes

- Updated dependencies

  - @neurodesk/webapp-components@0.14.2
  - @neurodesk/runtime-support@0.6.3
  - @neurodesk/browserqc@1.6.20261016

- Updated dependencies [7443048]

  - @neurodesk/webapp-components@0.14.1
  - @neurodesk/browserqc@1.6.20261016
  - @neurodesk/runtime-support@0.6.2

- Updated dependencies [7443048]
  - @neurodesk/webapp-components@0.14.1
  - @neurodesk/browserqc@1.6.20261016
  - @neurodesk/runtime-support@0.6.2

## 1.6.20261015

### Minor Changes

- 5e230a9: BrowserQC offers the brain mask and the GM, WM and CSF fraction maps (or the label map) as downloads under Image quality. The file names start with the input name. About states that the CSF map covers the ventricles only and that the three maps are separate fractions. The package README gives the correct data type of the fraction maps: uint8 with `scl_slope`, not float32.

### Patch Changes

- Updated dependencies [c74b26f]

  - @neurodesk/runtime-support@0.6.1
  - @neurodesk/browserqc@1.6.20261015

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

- Updated dependencies [5e230a9]

- Updated dependencies [0569da8]

- Updated dependencies [dd65e6a]

- Updated dependencies [dcc74e7]

  - @neurodesk/browserqc@1.6.20261015
  - @neurodesk/runtime-support@0.6.0
  - @neurodesk/webapp-components@0.14.0

- Updated dependencies [dcc74e7]
  - @neurodesk/browserqc@1.6.20261015
  - @neurodesk/runtime-support@0.6.0
  - @neurodesk/webapp-components@0.14.0

## 1.5.20261014

### Patch Changes

- Updated dependencies [27c9549]

- Updated dependencies [850e642]

- Updated dependencies [ad92e2f]
  - @neurodesk/runtime-support@0.5.0
  - @neurodesk/webapp-components@0.13.0
  - @neurodesk/browserqc@1.5.20261014

## 1.5.20261012

### Patch Changes

- Updated dependencies
  - @neurodesk/webapp-components@0.12.3
  - @neurodesk/browserqc@1.5.20261012
  - @neurodesk/runtime-support@0.4.3

## 1.5.20261010

### Patch Changes

- Updated dependencies

  - @neurodesk/webapp-components@0.12.2
  - @neurodesk/runtime-support@0.4.2
  - @neurodesk/browserqc@1.5.20261010

  - @neurodesk/runtime-support@0.4.1
  - @neurodesk/browserqc@1.5.20261010
  - @neurodesk/webapp-components@0.12.1

- Updated dependencies

  - @neurodesk/webapp-components@0.12.2
  - @neurodesk/runtime-support@0.4.2
  - @neurodesk/browserqc@1.5.20261010

- Updated dependencies
  - @neurodesk/runtime-support@0.4.1
  - @neurodesk/browserqc@1.5.20261010
  - @neurodesk/webapp-components@0.12.1

## 1.5.20261009

### Minor Changes

- 9dd8eb1: Add the `browserqc` command line: `browserqc T1w.nii.gz OUTPUT_DIR` runs the web app's quality control in Node, with the same MindGrab segmentation on the CPU and the same niimath `--qc` WebAssembly, and writes the web app's downloads (`qc.json`, the brain mask and the tissue fractions or labels) under the same names. `--model` chooses any of the app's four models and `--bids` embeds a sidecar. Portable archives for Linux x64 and Windows x64 and a signed macOS installer include the MindGrab models and the MNI air template, and run offline. Their release check runs the pinned example with all four models, and a plain `.nii` copy without a sidecar, and requires every download to match the web app's CPU downloads byte for byte.

  The app and the command line share the pipeline in `@neurodesk/browserqc`. The app now passes a NIfTI file's own bytes to MindGrab and niimath instead of NiiVue's re-serialised copy, and checks the air template's SHA-256 after download.

### Patch Changes

- Updated dependencies [66bf9e9]

- Updated dependencies [9dd8eb1]

- Updated dependencies [501ea0c]

- Updated dependencies [64ffefa]
  - @neurodesk/webapp-components@0.12.0
  - @neurodesk/browserqc@1.5.20261009
  - @neurodesk/runtime-support@0.3.0

## 1.4.20261007

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

## 1.4.20261006

### Minor Changes

- Update BrowserQC to upstream 30f385f. Use an independent brain mask with the default MindMap tissue fractions or three label models, update the QC engine and viewer, and add background-noise viewing, manual ratings and the native Python launcher. Preserve shared examples, local DICOM import and cancellable processing. Register BrowserQC in the weekly upstream pull-request workflow.

## 1.3.20261004

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

## 1.3.20261003

### Patch Changes

- Updated dependencies
  - @neurodesk/webapp-components@0.8.0

## 1.3.20260930

### Patch Changes

- Updated dependencies

  - @neurodesk/webapp-components@0.6.2

- Updated dependencies

  - @neurodesk/webapp-components@0.7.0

- Updated dependencies

  - @neurodesk/webapp-components@0.6.2

  - @neurodesk/webapp-components@0.7.0

## 1.3.20260928

### Patch Changes

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

## 1.2.20260928

### Patch Changes

- Updated dependencies
  - @neurodesk/webapp-components@0.5.0

## 1.2.20260924

### Patch Changes

- Updated dependencies [39a9ea5]
  - @neurodesk/webapp-components@0.4.5

## 1.2.20260923

### Patch Changes

- 3e6b9a7: Add a Support action to the shared application bar, so every webapp offers one
  route to the maintainers. It opens a GitHub issue on the monorepo that is
  already filled in: the app and its build, the browser, the window size, whether
  WebGPU and cross-origin isolation are available, and headings that ask for
  reproduction steps or, for a feature suggestion, what the app should do instead.
  The prefilled page address keeps only origin and path, because app state in a
  query or fragment can name a user's own files.

## 1.2.20260920

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

## 1.2.20260918

### Patch Changes

- Updated dependencies

  - @neurodesk/webapp-components@0.3.1
  - @neurodesk/webapp-components@0.4.1

- Replace shared UI builders with light-DOM custom elements for consoles, file fields, result lists, viewer toolbars and example selectors. Migrate app callers, isolate control IDs and upload scopes, and preserve state while cleaning up listeners and cancelled downloads across component removal.

- Updated dependencies
  - @neurodesk/webapp-components@0.4.0

## 1.2.20260916

### Patch Changes

- Standardize example selection across the app catalog with complete scientific input bundles, shared cancellation and retry, and explicit processing. Add missing examples, curate existing datasets, fix QSMbly retry and TopoFit cancellation, and require example manifests and browser coverage for every app and the generator.

- Updated dependencies
  - @neurodesk/webapp-components@0.3.0

## 1.2.20260915

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

## 1.1.20260914

### Patch Changes

- Updated dependencies

  - @neurodesk/webapp-components@0.1.4

- Updated dependencies [3cd773f]

- Updated dependencies [4add8da]

  - @neurodesk/webapp-components@0.1.5
  - @neurodesk/runtime-support@0.1.2

- Updated dependencies [4add8da]

  - @neurodesk/webapp-components@0.1.5
  - @neurodesk/runtime-support@0.1.2

## 1.1.20260910

### Minor Changes

- Release the complete application catalog after integrating BrowserQC, dwi2trx and SynthSeg. Preserve shared interface behavior and publish bundles with synchronized date versions.

- 8a8499b: Add diffusion tensor fitting and tractography, update BrowserQC segmentation, and unify development and production interfaces. Reject malformed QC reports and keep DICOM sidecars attached to their scans.

### Patch Changes

- Updated dependencies [3fe15c3]
  - @neurodesk/runtime-support@0.1.1

## 1.0.20260910

### Changes

- Adopt MAJOR.MINOR.YYYYMMDD versioning, link every app to the lightNIIng ecosystem (lightniing.org) from the app bar and About dialog, and keep build scratch files off the shared /tmp volume.

## 1.0.8

### Patch Changes

- Apply the shared design system and the registry-driven About and Cite dialogs. Every app now states that it is developed and hosted by the Neurodesk team, lists the packages under the hood, names the lightning.org ecosystem, and cites one paper per implemented method plus the Neurodesk platform paper. SynthSR, SYNcro, Deface, BrowserQC and NiiMath use the shared workspace vocabulary (compact sections, one scan picker, shared toolbar, status bar and dialogs).

- Updated dependencies
  - @neurodesk/webapp-components@0.1.3

## 1.0.7

### Patch Changes

- Add clear NIfTI and DICOM upload controls, numbered sidebar steps, and explanations for each app's processing options.

## 1.0.6

### Patch Changes

- cd790d5: Finish shared imaging convergence by centralizing worker sessions, input handling, app-specific controllers, workspace styles, and runtime clients. Strengthen shell contracts and regression coverage.

## 1.0.5

### Patch Changes

- 5560336: Consolidate imaging workers, pipeline execution, viewer behavior, NIfTI serialization, runtime wrappers, shared styling, and hosted shell controls. Fix CALMaR analysis startup and layout, and remove horizontal overflow from Deface controls.

## 1.0.4

### Patch Changes

- 46be48e: Add a persistent light and dark theme switch to the webapp catalog and every hosted or standalone webapp bundle.

## 1.0.3

### Patch Changes

- Standardize the Neurodesk app shell and add DNT/GPC-respecting page-view analytics with aggregate per-app usage statistics.

## 1.0.2

### Patch Changes

- 4a4dd72: Apply the Neurodesk designer-guide theme to hosted and standalone webapp bundles.
