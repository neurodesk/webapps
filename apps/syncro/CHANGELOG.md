# syncro

## 0.6.20261007

### Minor Changes

- d627aca: Add a macOS arm64 installer package for the `syncro` command line. It installs SYNcro in `/usr/local/lib/neurodesk/syncro` and the `syncro` command in `/usr/local/bin`, bundles Node and the models, and is signed with a Developer ID and notarized for release. The app no longer ships its own download dialog, which the shared bar's Standalone action had replaced, or the npm tarball that only that dialog linked.

### Patch Changes

- 6be20aa: Add the `topofit` command line: CPU reconstruction with ONNX Runtime Node, offline model installation with SHA-256 checks on every load, portable Linux x64 and Windows x64 archives, and a Developer ID signed, notarized macOS arm64 installer package that installs `/usr/local/bin/topofit`. Each bundles Node and the T1-weighted models, and each must match the OpenRecon end-to-end reference before release. SYNcro's portable archives are now built by the shared `exes/node-cli` packager; their contents and behaviour are unchanged apart from the launcher binary.
- Updated dependencies [70f2770]
  - @neurodesk/webapp-components@0.10.2
  - @neurodesk/greedy@0.4.20261007
  - @neurodesk/synthsr@0.6.20261007
  - @neurodesk/brain-extraction@0.1.21

## 0.5.20261005

### Patch Changes

- Updated dependencies
  - @neurodesk/synthsr@0.6.20261005
  - @neurodesk/brain-extraction@0.1.20

## 0.5.20261004

### Minor Changes

- 257192b: Stream SynthSR and SynthStrip CPU inference by operator to avoid oversized browser allocations while preserving the pinned models. Reject normalization with less than one percent positive brain support in the MNI template before exposing downloads. Add numerical parity, allocation, failure recovery, and cropped-head regressions.

### Patch Changes

- Updated dependencies
  - @neurodesk/synthsr@0.6.20261004
  - @neurodesk/brain-extraction@0.1.19
- Updated dependencies
  - @neurodesk/webapp-components@0.10.1
  - @neurodesk/greedy@0.4.20261004
  - @neurodesk/synthsr@0.6.20261004
  - @neurodesk/brain-extraction@0.1.18
- 979d2e9: Correct the normalized lesion in the viewer before downloading it. When a run includes a lesion map, Results offers Edit lesion, which opens the shared mask editor on the normalized primary scan with the normalized lesion as the drawing. Apply replaces the lesion in the result archive with the edited uint8 NIfTI under the same name and labels the viewer `(edited)`; Cancel discards the strokes. A new run, new input or removed input closes an open edit. Automation results stay as the pipeline computed them.
- Updated dependencies [0204fe1]
- Updated dependencies [ec85a09]
  - @neurodesk/webapp-components@0.10.0
  - @neurodesk/greedy@0.4.20261004
  - @neurodesk/synthsr@0.6.20261004
  - @neurodesk/brain-extraction@0.1.17
- Updated dependencies [257192b]
  - @neurodesk/synthsr@0.6.20261004
  - @neurodesk/synthstrip@0.1.1
  - @neurodesk/runtime-support@0.1.3
  - @neurodesk/brain-extraction@0.1.16
  - @neurodesk/greedy@0.4.20261004

## 0.4.20261004

### Patch Changes

- Updated dependencies
  - @neurodesk/webapp-components@0.9.0
  - @neurodesk/greedy@0.4.20261004
  - @neurodesk/synthsr@0.5.20261004
  - @neurodesk/brain-extraction@0.1.15

## 0.4.20261003

### Patch Changes

- Updated dependencies
  - @neurodesk/webapp-components@0.8.0
  - @neurodesk/greedy@0.4.20261003
  - @neurodesk/synthsr@0.5.20261003
  - @neurodesk/brain-extraction@0.1.14

## 0.4.20260930

### Patch Changes

- Updated dependencies
- Updated dependencies
  - @neurodesk/webapp-components@0.7.0
  - @neurodesk/greedy@0.4.20260930
  - @neurodesk/synthsr@0.5.20260930
  - @neurodesk/brain-extraction@0.1.13

### Patch Changes

- Updated dependencies
  - @neurodesk/webapp-components@0.6.2
  - @neurodesk/greedy@0.4.20260930
  - @neurodesk/synthsr@0.5.20260930
  - @neurodesk/brain-extraction@0.1.12

## 0.4.20260928

### Patch Changes

- Updated dependencies
  - @neurodesk/webapp-components@0.6.1
  - @neurodesk/greedy@0.4.20260928
  - @neurodesk/synthsr@0.5.20260928
  - @neurodesk/brain-extraction@0.1.11

### Minor Changes

- Expose typed operations across the application catalog, including multiple inputs, DICOM series selection, variable artifacts and viewer workflows. Share awaited processing and cancellation between each app and its agent adapter. Publish verified result reports and scientific provenance.

  Add bounded desktop viewer sessions and MCP controls using public viewer APIs. Native SynthSeg now reports per-label counts and physical volumes. Include real-model CPU checks and a Mac runner for Metal, WebGPU and buffer-planning evidence without raising the validated SynthSeg limit.

### Patch Changes

- 93381e8: Every app now opens on its workspace and shows live status only in the bottom bar: a short message, a progress bar, elapsed time and a cancel × that appears while a run can be cancelled. Start pages, landing overlays and welcome modals are gone, and their copy moved to About. Every app has a technical log below the viewer that starts collapsed. Sidebar help longer than 90 characters moved into info tooltips or About, and each sidebar has one primary action. `ProgressManager` now drives the design-system footer, including the elapsed counter and the cancel button.

  The shared example selector shows one short line once an example loads; the description and expected result moved to a tooltip beside the Example label. NiiMath gained the shared layout tabs and About dialog and no longer ships app CSS.

- Updated dependencies
- Updated dependencies [93381e8]
- Updated dependencies [93381e8]
  - @neurodesk/webapp-components@0.6.0
  - @neurodesk/greedy@0.4.20260928
  - @neurodesk/synthsr@0.5.20260928
  - @neurodesk/brain-extraction@0.1.10

## 0.3.20260928

### Patch Changes

- Updated dependencies
  - @neurodesk/webapp-components@0.5.0
  - @neurodesk/greedy@0.3.20260928
  - @neurodesk/synthsr@0.4.20260928
  - @neurodesk/brain-extraction@0.1.9

## 0.3.20260924

### Patch Changes

- Updated dependencies [39a9ea5]
  - @neurodesk/webapp-components@0.4.5
  - @neurodesk/greedy@0.3.20260924
  - @neurodesk/synthsr@0.4.20260924
  - @neurodesk/brain-extraction@0.1.8

## 0.3.20260923

### Patch Changes

- 3e6b9a7: Add a Support action to the shared application bar, so every webapp offers one
  route to the maintainers. It opens a GitHub issue on the monorepo that is
  already filled in: the app and its build, the browser, the window size, whether
  WebGPU and cross-origin isolation are available, and headings that ask for
  reproduction steps or, for a feature suggestion, what the app should do instead.
  The prefilled page address keeps only origin and path, because app state in a
  query or fragment can name a user's own files.
  - @neurodesk/greedy@0.3.20260923
  - @neurodesk/synthsr@0.4.20260923
  - @neurodesk/brain-extraction@0.1.7

## 0.3.20260920

### Patch Changes

- Updated dependencies [4959500]
  - @neurodesk/webapp-components@0.4.4
  - @neurodesk/greedy@0.3.20260920
  - @neurodesk/synthsr@0.4.20260920
  - @neurodesk/brain-extraction@0.1.6

### Patch Changes

- Updated dependencies
  - @neurodesk/webapp-components@0.4.3
  - @neurodesk/greedy@0.3.20260920
  - @neurodesk/synthsr@0.4.20260920
  - @neurodesk/brain-extraction@0.1.5

### Patch Changes

- Updated dependencies
  - @neurodesk/webapp-components@0.4.2
  - @neurodesk/greedy@0.3.20260920
  - @neurodesk/synthsr@0.4.20260920
  - @neurodesk/brain-extraction@0.1.4

### Patch Changes

- @neurodesk/greedy@0.3.20260920

## 0.3.20260918

### Patch Changes

- Updated dependencies

  - @neurodesk/webapp-components@0.3.1
  - @neurodesk/webapp-components@0.4.1
  - @neurodesk/greedy@0.3.20260918
  - @neurodesk/synthsr@0.4.20260918
  - @neurodesk/brain-extraction@0.1.3

- Replace shared UI builders with light-DOM custom elements for consoles, file fields, result lists, viewer toolbars and example selectors. Migrate app callers, isolate control IDs and upload scopes, and preserve state while cleaning up listeners and cancelled downloads across component removal.
- Updated dependencies
  - @neurodesk/webapp-components@0.4.0
  - @neurodesk/greedy@0.3.20260918
  - @neurodesk/synthsr@0.4.20260918
  - @neurodesk/brain-extraction@0.1.2

## 0.3.20260916

### Patch Changes

- Standardize example selection across the app catalog with complete scientific input bundles, shared cancellation and retry, and explicit processing. Add missing examples, curate existing datasets, fix QSMbly retry and TopoFit cancellation, and require example manifests and browser coverage for every app and the generator.
- Updated dependencies
  - @neurodesk/webapp-components@0.3.0
  - @neurodesk/greedy@0.3.20260916
  - @neurodesk/synthsr@0.4.20260916
  - @neurodesk/brain-extraction@0.1.1

## 0.3.20260915

### Patch Changes

- Include Brain extraction in the offline desktop suite with its SynthStrip model and a real BET extraction and download check. Reuse the shared MindGrab adapter in SYNcro.

### Patch Changes

- Updated dependencies
  - @neurodesk/webapp-components@0.2.2
  - @neurodesk/greedy@0.3.20260915
  - @neurodesk/synthsr@0.4.20260915

### Patch Changes

- Updated dependencies
  - @neurodesk/webapp-components@0.2.1
  - @neurodesk/greedy@0.3.20260915
  - @neurodesk/synthsr@0.4.20260915

### Patch Changes

- Reject out-of-field registration trial coordinates before integer conversion, preventing a threaded WebAssembly crash during SYNcro normalization. Include complete desktop and HPC release packaging with offline workflow gates.
  - @neurodesk/greedy@0.3.20260915

### Minor Changes

- Add a shared Standalone action and offline desktop packaging with included, checksum-verified models and runtime dependencies. Remove the lightNIIng topbar link while retaining its About statement.

### Patch Changes

- Updated dependencies
  - @neurodesk/webapp-components@0.2.0
  - @neurodesk/greedy@0.3.20260915
  - @neurodesk/synthsr@0.4.20260915

## 0.2.20260914

### Patch Changes

- Updated dependencies
  - @neurodesk/greedy@0.2.20260914

### Patch Changes

- 3cd773f: Greedy and EdgeReg show all three viewer panels on phones. TopoFit conforms axis-aligned and oblique scans through the pinned npm niimath WebAssembly worker. SYNcro now matches the native three-input workflow, offers four checksum-pinned tutorials, defaults to MindGrab and Greedy with SynthStrip and ANTs alternatives, uses niimath for lesion and masking operations, and switches one NiiVue viewer between images with automatic lesion overlays. SynthSR lets adapter limits govern its largest activation buffer, so validated 256×256×192 scans and larger volumes on capable GPUs are attempted while other shared U-Net callers retain their existing limit. Add the standalone ANTS registration demo.
- Updated dependencies [3cd773f]
- Updated dependencies [4add8da]
  - @neurodesk/greedy@0.1.20260914
  - @neurodesk/webapp-components@0.1.5
  - @neurodesk/runtime-support@0.1.2
  - @neurodesk/synthsr@0.3.20260914

### Patch Changes

- Updated dependencies
  - @neurodesk/webapp-components@0.1.4
  - @neurodesk/synthsr@0.3.20260914

## 0.2.20260910

### Minor Changes

- Release the complete application catalog after integrating BrowserQC, dwi2trx and SynthSeg. Preserve shared interface behavior and publish bundles with synchronized date versions.

### Patch Changes

- Updated dependencies [3fe15c3]
  - @neurodesk/runtime-support@0.1.1
  - @neurodesk/synthsr@0.3.20260910

## 0.1.20260910

### Changes

- Adopt MAJOR.MINOR.YYYYMMDD versioning, link every app to the lightNIIng ecosystem (lightniing.org) from the app bar and About dialog, and keep build scratch files off the shared /tmp volume.

## 0.1.5

### Patch Changes

- Apply the shared design system and the registry-driven About and Cite dialogs. Every app now states that it is developed and hosted by the Neurodesk team, lists the packages under the hood, names the lightning.org ecosystem, and cites one paper per implemented method plus the Neurodesk platform paper. SynthSR, SYNcro, Deface, BrowserQC and NiiMath use the shared workspace vocabulary (compact sections, one scan picker, shared toolbar, status bar and dialogs).
- Updated dependencies
  - @neurodesk/webapp-components@0.1.3
