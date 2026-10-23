# syncro

## 0.7.20261023

### Patch Changes

- Updated dependencies [3fc9cf2]
  - @neurodesk/webapp-components@0.19.1
  - @neurodesk/runtime-support@0.9.9
  - @neurodesk/synthsr@0.6.20261023
  - @neurodesk/synthstrip@0.2.0
  - @neurodesk/brain-extraction@0.5.20261023
  - @neurodesk/greedy@0.6.20261023
  - @neurodesk/syncro@0.7.20261023

## 0.7.20261022

### Patch Changes

- Updated dependencies [8e4e37d]
  - @neurodesk/syncro@0.7.20261022
- Updated dependencies [d32b485]
  - @neurodesk/webapp-components@0.19.0
  - @neurodesk/runtime-support@0.9.8
  - @neurodesk/synthsr@0.6.20261022
  - @neurodesk/synthstrip@0.2.0
  - @neurodesk/brain-extraction@0.5.20261022
  - @neurodesk/greedy@0.6.20261022
  - @neurodesk/syncro@0.7.20261022

## 0.7.20261020

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
  - @neurodesk/synthsr@0.6.20261020
  - @neurodesk/synthstrip@0.2.0
  - @neurodesk/brain-extraction@0.5.20261020
  - @neurodesk/greedy@0.6.20261020
  - @neurodesk/syncro@0.7.20261020
- Updated dependencies [c865c0c]
  - @neurodesk/webapp-components@0.17.1
  - @neurodesk/runtime-support@0.8.2
  - @neurodesk/synthsr@0.6.20261020
  - @neurodesk/synthstrip@0.1.5
  - @neurodesk/brain-extraction@0.4.20261020
  - @neurodesk/greedy@0.6.20261020
  - @neurodesk/syncro@0.7.20261020
- Record the injected MindGrab runtime's actual version in brain extraction provenance, including SYNcro's separately pinned build.
- Updated dependencies [a36fde4]
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
  - @neurodesk/webapp-components@0.17.0
  - @neurodesk/brain-extraction@0.4.20261020
  - @neurodesk/runtime-support@0.8.1
  - @neurodesk/synthsr@0.6.20261020
  - @neurodesk/synthstrip@0.1.5
  - @neurodesk/greedy@0.6.20261020
  - @neurodesk/syncro@0.7.20261020
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
  - @neurodesk/syncro@0.7.20261020
  - @neurodesk/synthsr@0.6.20261020
  - @neurodesk/synthstrip@0.1.5
  - @neurodesk/brain-extraction@0.4.20261020
  - @neurodesk/greedy@0.6.20261020

- @neurodesk/synthsr@0.6.20261020

- @neurodesk/brain-extraction@0.4.20261020

- @neurodesk/syncro@0.7.20261020

- 657c330: Record the injected MindGrab runtime's actual version in brain extraction provenance, including SYNcro's separately pinned build.

- Updated dependencies [a36fde4]

- Updated dependencies [657c330]

  - @neurodesk/webapp-components@0.18.0
  - @neurodesk/brain-extraction@0.4.20261020
  - @neurodesk/runtime-support@0.9.5
  - @neurodesk/synthsr@0.6.20261020
  - @neurodesk/synthstrip@0.1.5
  - @neurodesk/greedy@0.6.20261020
  - @neurodesk/syncro@0.7.20261020

- Updated dependencies [14db080]

- Updated dependencies [03261d0]

- Updated dependencies [c865c0c]

  - @neurodesk/webapp-components@0.17.0
  - @neurodesk/runtime-support@0.9.4
  - @neurodesk/synthsr@0.6.20261020
  - @neurodesk/synthstrip@0.1.5
  - @neurodesk/brain-extraction@0.4.20261020
  - @neurodesk/greedy@0.6.20261020
  - @neurodesk/syncro@0.7.20261020

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
  - @neurodesk/syncro@0.7.20261020
  - @neurodesk/synthsr@0.6.20261020
  - @neurodesk/synthstrip@0.1.5
  - @neurodesk/brain-extraction@0.4.20261020
  - @neurodesk/greedy@0.6.20261020

- Updated dependencies [d1fa022]

  - @neurodesk/webapp-components@0.16.3
  - @neurodesk/runtime-support@0.9.3
  - @neurodesk/synthsr@0.6.20261020
  - @neurodesk/synthstrip@0.1.5
  - @neurodesk/brain-extraction@0.4.20261020
  - @neurodesk/syncro@0.7.20261020
  - @neurodesk/greedy@0.6.20261020

- Updated dependencies [d1fa022]

  - @neurodesk/webapp-components@0.16.0
  - @neurodesk/runtime-support@0.8.0
  - @neurodesk/syncro@0.7.20261020
  - @neurodesk/synthsr@0.6.20261020
  - @neurodesk/synthstrip@0.1.5
  - @neurodesk/brain-extraction@0.4.20261020
  - @neurodesk/greedy@0.6.20261020

- Updated dependencies [657c330]

  - @neurodesk/brain-extraction@0.4.20261020
  - @neurodesk/syncro@0.7.20261020

- Updated dependencies [4b40da1]

  - @neurodesk/webapp-components@0.17.0
  - @neurodesk/runtime-support@0.9.4
  - @neurodesk/synthsr@0.6.20261020
  - @neurodesk/synthstrip@0.1.5
  - @neurodesk/brain-extraction@0.4.20261020
  - @neurodesk/greedy@0.6.20261020
  - @neurodesk/syncro@0.7.20261020

- Updated dependencies [657c330]

  - @neurodesk/brain-extraction@0.4.20261020
  - @neurodesk/syncro@0.7.20261020

  - @neurodesk/webapp-components@0.16.3
  - @neurodesk/runtime-support@0.9.3
  - @neurodesk/synthsr@0.6.20261020
  - @neurodesk/synthstrip@0.1.5
  - @neurodesk/brain-extraction@0.4.20261020
  - @neurodesk/syncro@0.7.20261020
  - @neurodesk/greedy@0.6.20261020

- Record the injected MindGrab runtime's actual version in brain extraction provenance, including SYNcro's separately pinned build.

- Updated dependencies

- Updated dependencies

  - @neurodesk/webapp-components@0.17.0
  - @neurodesk/brain-extraction@0.4.20261020
  - @neurodesk/runtime-support@0.8.1
  - @neurodesk/synthsr@0.6.20261020
  - @neurodesk/synthstrip@0.1.5
  - @neurodesk/greedy@0.6.20261020
  - @neurodesk/syncro@0.7.20261020

- Updated dependencies

  - @neurodesk/webapp-components@0.17.0
  - @neurodesk/runtime-support@0.8.1
  - @neurodesk/synthsr@0.6.20261020
  - @neurodesk/synthstrip@0.1.5
  - @neurodesk/brain-extraction@0.4.20261020
  - @neurodesk/greedy@0.6.20261020
  - @neurodesk/syncro@0.7.20261020

- Updated dependencies

  - @neurodesk/brain-extraction@0.4.20261020
  - @neurodesk/syncro@0.7.20261020

- Updated dependencies

  - @neurodesk/webapp-components@0.18.0
  - @neurodesk/runtime-support@0.8.2
  - @neurodesk/synthsr@0.6.20261020
  - @neurodesk/synthstrip@0.1.5
  - @neurodesk/brain-extraction@0.4.20261020
  - @neurodesk/greedy@0.6.20261020
  - @neurodesk/syncro@0.7.20261020

- Updated dependencies

  - @neurodesk/brain-extraction@0.4.20261020
  - @neurodesk/webapp-components@0.17.0
  - @neurodesk/runtime-support@0.8.1
  - @neurodesk/synthsr@0.6.20261020
  - @neurodesk/synthstrip@0.1.5
  - @neurodesk/greedy@0.6.20261020
  - @neurodesk/syncro@0.7.20261020

- Updated dependencies
  - @neurodesk/runtime-support@0.9.5
  - @neurodesk/webapp-components@0.17.1
  - @neurodesk/synthsr@0.6.20261020
  - @neurodesk/synthstrip@0.1.5
  - @neurodesk/brain-extraction@0.4.20261020
  - @neurodesk/greedy@0.6.20261020
  - @neurodesk/syncro@0.7.20261020
- Updated dependencies [14db080]

- Updated dependencies [4b40da1]

- NiiVue moves to 1.0.0-rc.26 in Brain Extraction, Carotid Flow, SYNcro, SynthSeg, White Matter Lesions, and, through the shared FreeBrowse viewer, Spinal Cord Toolbox, DICOM View and TopoFit. From rc.25, NiiVue places a loaded drawing on the right voxels of a sagittal or otherwise permuted image (niivue/mono#251), so the mask editor no longer probes and reverses NiiVue's load on opening a mask. Opening a mask for editing now takes one load instead of up to five on such images. MuscleMap, SeedSeg and VesselBoost run NiiVue 0.68, which already loaded drawings correctly; they pick up the simpler editor.

  From rc.22 NiiVue renders with WebGL2 by default, so the five apps that pinned rc.11 or rc.14 draw their viewer with WebGL2 even where WebGPU is available; segmentation and other processing keep their own WebGPU backends.

- Updated dependencies
  - @neurodesk/webapp-components@0.17.2
  - @neurodesk/runtime-support@0.9.6
  - @neurodesk/synthsr@0.6.20261020
  - @neurodesk/synthstrip@0.1.5
  - @neurodesk/brain-extraction@0.4.20261020
  - @neurodesk/greedy@0.6.20261020
  - @neurodesk/syncro@0.7.20261020
- Updated dependencies
  - @neurodesk/runtime-support@0.9.5
  - @neurodesk/webapp-components@0.17.1
  - @neurodesk/synthsr@0.6.20261020
  - @neurodesk/synthstrip@0.2.0
  - @neurodesk/brain-extraction@0.5.20261020
  - @neurodesk/greedy@0.6.20261020
  - @neurodesk/syncro@0.7.20261020
- Updated dependencies [14db080]

## 0.7.20261019

### Patch Changes

- Updated dependencies [af2e8db]

- Updated dependencies [b3404ec]

  - @neurodesk/webapp-components@0.16.3
  - @neurodesk/runtime-support@0.9.3
  - @neurodesk/synthsr@0.6.20261019
  - @neurodesk/synthstrip@0.1.5
  - @neurodesk/brain-extraction@0.4.20261019
  - @neurodesk/greedy@0.6.20261019
  - @neurodesk/syncro@0.7.20261019

- Updated dependencies [5ad652c]

  - @neurodesk/brain-extraction@0.4.20261019
  - @neurodesk/syncro@0.7.20261019

- Updated dependencies [da2584b]
  - @neurodesk/synthsr@0.6.20261019
  - @neurodesk/runtime-support@0.9.2
  - @neurodesk/brain-extraction@0.4.20261019
  - @neurodesk/syncro@0.7.20261019
  - @neurodesk/synthstrip@0.1.5
  - @neurodesk/greedy@0.6.20261019

## 0.7.20261018

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
  - @neurodesk/runtime-support@0.9.1
  - @neurodesk/synthsr@0.6.20261018
  - @neurodesk/synthstrip@0.1.5
  - @neurodesk/brain-extraction@0.4.20261018
  - @neurodesk/greedy@0.6.20261018
  - @neurodesk/syncro@0.7.20261018

- @neurodesk/greedy@0.6.20261018

- @neurodesk/syncro@0.7.20261018

- Updated dependencies

- Updated dependencies [46935f7]

  - @neurodesk/runtime-support@0.9.0
  - @neurodesk/webapp-components@0.16.1
  - @neurodesk/synthsr@0.6.20261018
  - @neurodesk/synthstrip@0.1.5
  - @neurodesk/brain-extraction@0.4.20261018
  - @neurodesk/greedy@0.6.20261018
  - @neurodesk/syncro@0.7.20261018

- Updated dependencies [ea2a6d2]

- Updated dependencies [0511cd7]

- Updated dependencies [a07f659]

- Updated dependencies [3329c39]

  - @neurodesk/webapp-components@0.16.0
  - @neurodesk/runtime-support@0.8.0
  - @neurodesk/syncro@0.7.20261018
  - @neurodesk/synthsr@0.6.20261018
  - @neurodesk/synthstrip@0.1.5
  - @neurodesk/brain-extraction@0.4.20261018
  - @neurodesk/greedy@0.6.20261018

- Updated dependencies [7c0d201]

  - @neurodesk/webapp-components@0.16.2
  - @neurodesk/runtime-support@0.9.1
  - @neurodesk/synthsr@0.6.20261018
  - @neurodesk/synthstrip@0.1.5
  - @neurodesk/brain-extraction@0.4.20261018
  - @neurodesk/greedy@0.6.20261018
  - @neurodesk/syncro@0.7.20261018

- Updated dependencies [46935f7]

  - @neurodesk/runtime-support@0.9.0
  - @neurodesk/webapp-components@0.16.1
  - @neurodesk/synthsr@0.6.20261018
  - @neurodesk/synthstrip@0.1.5
  - @neurodesk/brain-extraction@0.4.20261018
  - @neurodesk/greedy@0.6.20261018
  - @neurodesk/syncro@0.7.20261018

- Updated dependencies [3329c39]

  - @neurodesk/webapp-components@0.16.0
  - @neurodesk/runtime-support@0.8.0
  - @neurodesk/syncro@0.7.20261018
  - @neurodesk/synthsr@0.6.20261018
  - @neurodesk/synthstrip@0.1.5
  - @neurodesk/brain-extraction@0.4.20261018
  - @neurodesk/greedy@0.6.20261018

## 0.6.20261018

### Patch Changes

- Updated dependencies [b68209b]
  - @neurodesk/webapp-components@0.15.0
  - @neurodesk/runtime-support@0.7.1
  - @neurodesk/synthsr@0.6.20261018
  - @neurodesk/synthstrip@0.1.5
  - @neurodesk/brain-extraction@0.4.20261018
  - @neurodesk/greedy@0.5.20261018
  - @neurodesk/syncro@0.6.20261018
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
  - @neurodesk/greedy@0.5.20261018
  - @neurodesk/syncro@0.6.20261018

- Updated dependencies [b67e4e9]

  - @neurodesk/runtime-support@0.7.2
  - @neurodesk/webapp-components@0.15.1
  - @neurodesk/synthsr@0.6.20261018
  - @neurodesk/synthstrip@0.1.5
  - @neurodesk/brain-extraction@0.4.20261018
  - @neurodesk/greedy@0.5.20261018
  - @neurodesk/syncro@0.6.20261018

- Updated dependencies [b68209b]

  - @neurodesk/webapp-components@0.15.0
  - @neurodesk/runtime-support@0.7.1
  - @neurodesk/synthsr@0.6.20261018
  - @neurodesk/synthstrip@0.1.5
  - @neurodesk/brain-extraction@0.4.20261018
  - @neurodesk/greedy@0.5.20261018
  - @neurodesk/syncro@0.6.20261018

- Updated dependencies [67a5a8f]

- Updated dependencies [b8b37d6]

- Updated dependencies [2ae93ae]

- Updated dependencies [ccb2970]

  - @neurodesk/runtime-support@0.7.0
  - @neurodesk/webapp-components@0.14.4
  - @neurodesk/synthsr@0.6.20261018
  - @neurodesk/synthstrip@0.1.5
  - @neurodesk/brain-extraction@0.4.20261018
  - @neurodesk/greedy@0.5.20261018
  - @neurodesk/syncro@0.6.20261018

- Updated dependencies [b68209b]

  - @neurodesk/webapp-components@0.15.0
  - @neurodesk/runtime-support@0.7.1
  - @neurodesk/synthsr@0.6.20261018
  - @neurodesk/synthstrip@0.1.5
  - @neurodesk/brain-extraction@0.4.20261018
  - @neurodesk/greedy@0.5.20261018
  - @neurodesk/syncro@0.6.20261018

- Updated dependencies [67a5a8f]

  - @neurodesk/runtime-support@0.7.0
  - @neurodesk/webapp-components@0.14.4
  - @neurodesk/synthsr@0.6.20261018
  - @neurodesk/synthstrip@0.1.5
  - @neurodesk/brain-extraction@0.4.20261018
  - @neurodesk/greedy@0.5.20261018
  - @neurodesk/syncro@0.6.20261018

- Updated dependencies [b67e4e9]
  - @neurodesk/runtime-support@0.7.2
  - @neurodesk/webapp-components@0.15.1
  - @neurodesk/synthsr@0.6.20261018
  - @neurodesk/synthstrip@0.1.5
  - @neurodesk/brain-extraction@0.4.20261018
  - @neurodesk/greedy@0.5.20261018
  - @neurodesk/syncro@0.6.20261018

## 0.6.20261017

### Patch Changes

- Updated dependencies [b547d52]
  - @neurodesk/webapp-components@0.14.3
  - @neurodesk/runtime-support@0.6.4
  - @neurodesk/synthsr@0.6.20261017
  - @neurodesk/synthstrip@0.1.5
  - @neurodesk/brain-extraction@0.4.20261017
  - @neurodesk/greedy@0.5.20261017
  - @neurodesk/syncro@0.6.20261017

## 0.6.20261016

### Patch Changes

- Persist checksum-verified model and example caches across browser restarts. Bind runtime caches to each document’s checksum manifest to avoid reusing bytes from a different deployment.
- Updated dependencies
  - @neurodesk/webapp-components@0.14.2
  - @neurodesk/runtime-support@0.6.3
  - @neurodesk/synthsr@0.6.20261016
  - @neurodesk/synthstrip@0.1.5
  - @neurodesk/brain-extraction@0.4.20261016
  - @neurodesk/greedy@0.5.20261016
  - @neurodesk/syncro@0.6.20261016
- Updated dependencies [7443048]

  - @neurodesk/webapp-components@0.14.1
  - @neurodesk/runtime-support@0.6.2
  - @neurodesk/synthsr@0.6.20261016
  - @neurodesk/synthstrip@0.1.5
  - @neurodesk/brain-extraction@0.4.20261016
  - @neurodesk/greedy@0.5.20261016
  - @neurodesk/syncro@0.6.20261016

- Persist checksum-verified model and example caches across browser restarts. Bind runtime caches to each document’s checksum manifest to avoid reusing bytes from a different deployment.

- Updated dependencies

  - @neurodesk/webapp-components@0.14.2
  - @neurodesk/runtime-support@0.6.3
  - @neurodesk/synthsr@0.6.20261016
  - @neurodesk/synthstrip@0.1.5
  - @neurodesk/brain-extraction@0.4.20261016
  - @neurodesk/greedy@0.5.20261016
  - @neurodesk/syncro@0.6.20261016

- Updated dependencies [7443048]

  - @neurodesk/webapp-components@0.14.1
  - @neurodesk/runtime-support@0.6.2
  - @neurodesk/synthsr@0.6.20261016
  - @neurodesk/synthstrip@0.1.5
  - @neurodesk/brain-extraction@0.4.20261016
  - @neurodesk/greedy@0.5.20261016
  - @neurodesk/syncro@0.6.20261016

- Updated dependencies

  - @neurodesk/webapp-components@0.14.2
  - @neurodesk/runtime-support@0.6.3
  - @neurodesk/synthsr@0.6.20261016
  - @neurodesk/synthstrip@0.1.5
  - @neurodesk/brain-extraction@0.4.20261016
  - @neurodesk/greedy@0.5.20261016
  - @neurodesk/syncro@0.6.20261016

- Updated dependencies [7443048]
  - @neurodesk/webapp-components@0.14.1
  - @neurodesk/runtime-support@0.6.2
  - @neurodesk/synthsr@0.6.20261016
  - @neurodesk/synthstrip@0.1.5
  - @neurodesk/brain-extraction@0.4.20261016
  - @neurodesk/greedy@0.5.20261016
  - @neurodesk/syncro@0.6.20261016

## 0.6.20261015

### Patch Changes

- Updated dependencies [c74b26f]
  - @neurodesk/runtime-support@0.6.1
  - @neurodesk/synthsr@0.6.20261015
  - @neurodesk/synthstrip@0.1.5
  - @neurodesk/brain-extraction@0.4.20261015
  - @neurodesk/greedy@0.5.20261015
  - @neurodesk/syncro@0.6.20261015
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
  - @neurodesk/greedy@0.5.20261015
  - @neurodesk/syncro@0.6.20261015
- Updated dependencies [84d192a]

  - @neurodesk/synthsr@0.6.20261015
  - @neurodesk/brain-extraction@0.4.20261015
  - @neurodesk/syncro@0.6.20261015

- Updated dependencies [c74b26f]

  - @neurodesk/runtime-support@0.6.1
  - @neurodesk/synthsr@0.6.20261015
  - @neurodesk/synthstrip@0.1.5
  - @neurodesk/brain-extraction@0.4.20261015
  - @neurodesk/greedy@0.5.20261015
  - @neurodesk/syncro@0.6.20261015

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
  - @neurodesk/greedy@0.5.20261015
  - @neurodesk/syncro@0.6.20261015

- Updated dependencies [84d192a]

  - @neurodesk/synthsr@0.6.20261015
  - @neurodesk/brain-extraction@0.4.20261015
  - @neurodesk/syncro@0.6.20261015

- Updated dependencies [dcc74e7]

  - @neurodesk/runtime-support@0.6.0
  - @neurodesk/webapp-components@0.14.0
  - @neurodesk/synthsr@0.6.20261015
  - @neurodesk/synthstrip@0.1.5
  - @neurodesk/brain-extraction@0.4.20261015
  - @neurodesk/greedy@0.5.20261015
  - @neurodesk/syncro@0.6.20261015

- Updated dependencies [c74b26f]

  - @neurodesk/runtime-support@0.6.1
  - @neurodesk/synthsr@0.6.20261015
  - @neurodesk/synthstrip@0.1.5
  - @neurodesk/brain-extraction@0.4.20261015
  - @neurodesk/greedy@0.5.20261015
  - @neurodesk/syncro@0.6.20261015

- Updated dependencies [84d192a]
  - @neurodesk/synthsr@0.6.20261015
  - @neurodesk/brain-extraction@0.4.20261015
  - @neurodesk/syncro@0.6.20261015

## 0.6.20261014

### Patch Changes

- Updated dependencies [27c9549]
- Updated dependencies [850e642]
- Updated dependencies [ad92e2f]

  - @neurodesk/runtime-support@0.5.0
  - @neurodesk/webapp-components@0.13.0
  - @neurodesk/synthsr@0.6.20261014
  - @neurodesk/synthstrip@0.1.5
  - @neurodesk/brain-extraction@0.4.20261014
  - @neurodesk/syncro@0.6.20261014
  - @neurodesk/greedy@0.5.20261014

- Updated dependencies [27c9549]

- Updated dependencies [850e642]

- Updated dependencies [ad92e2f]
  - @neurodesk/runtime-support@0.5.0
  - @neurodesk/webapp-components@0.13.0
  - @neurodesk/synthsr@0.6.20261014
  - @neurodesk/synthstrip@0.1.5
  - @neurodesk/brain-extraction@0.4.20261014
  - @neurodesk/syncro@0.6.20261014
  - @neurodesk/greedy@0.5.20261014

## 0.6.20261012

### Patch Changes

- Updated dependencies
  - @neurodesk/webapp-components@0.12.3
  - @neurodesk/runtime-support@0.4.3
  - @neurodesk/synthsr@0.6.20261012
  - @neurodesk/synthstrip@0.1.5
  - @neurodesk/brain-extraction@0.4.20261012
  - @neurodesk/greedy@0.5.20261012
  - @neurodesk/syncro@0.6.20261012
- @neurodesk/greedy@0.5.20261012
- @neurodesk/syncro@0.6.20261012

- Updated dependencies

  - @neurodesk/webapp-components@0.12.3
  - @neurodesk/runtime-support@0.4.3
  - @neurodesk/synthsr@0.6.20261012
  - @neurodesk/synthstrip@0.1.5
  - @neurodesk/brain-extraction@0.4.20261012
  - @neurodesk/greedy@0.5.20261012
  - @neurodesk/syncro@0.6.20261012

- @neurodesk/greedy@0.5.20261012

- @neurodesk/syncro@0.6.20261012

- Updated dependencies
  - @neurodesk/webapp-components@0.12.3
  - @neurodesk/runtime-support@0.4.3
  - @neurodesk/synthsr@0.6.20261012
  - @neurodesk/synthstrip@0.1.5
  - @neurodesk/brain-extraction@0.4.20261012
  - @neurodesk/greedy@0.5.20261012
  - @neurodesk/syncro@0.6.20261012

## 0.6.20261010

### Patch Changes

- Preserve original operation failures while draining GPU error scopes and reject failed DICOM field fallback tasks without hanging. Resolve correctness findings with switch scopes, safe own-property checks, equivalent regular expressions and documented optional cleanup/cache behavior. Surface actionable release, filesystem and schema preload failures; retain scientific literals and arithmetic.
- Updated dependencies
  - @neurodesk/webapp-components@0.12.2
  - @neurodesk/registration@0.1.1
  - @neurodesk/runtime-support@0.4.2
  - @neurodesk/synthsr@0.6.20261010
  - @neurodesk/synthstrip@0.1.5
  - @neurodesk/brain-extraction@0.4.20261010
  - @neurodesk/greedy@0.4.20261010
- Declare workspace dependencies without expanding SYNcro portable runtime installations. Mark dicompare type imports explicitly and separate the unchanged NeSVoR reference validator from worker orchestration to remove dependency cycles.
- Updated dependencies
  - @neurodesk/syncro@0.6.20261010
- Updated dependencies

  - @neurodesk/runtime-support@0.4.1
  - @neurodesk/webapp-components@0.12.1
  - @neurodesk/brain-extraction@0.4.20261010
  - @neurodesk/synthsr@0.6.20261010
  - @neurodesk/synthstrip@0.1.5
  - @neurodesk/greedy@0.4.20261010

- Preserve original operation failures while draining GPU error scopes and reject failed DICOM field fallback tasks without hanging. Resolve correctness findings with switch scopes, safe own-property checks, equivalent regular expressions and documented optional cleanup/cache behavior. Surface actionable release, filesystem and schema preload failures; retain scientific literals and arithmetic.

- Updated dependencies

  - @neurodesk/webapp-components@0.12.2
  - @neurodesk/registration@0.1.1
  - @neurodesk/runtime-support@0.4.2
  - @neurodesk/synthsr@0.6.20261010
  - @neurodesk/synthstrip@0.1.5
  - @neurodesk/brain-extraction@0.4.20261010
  - @neurodesk/greedy@0.4.20261010

- Declare workspace dependencies without expanding SYNcro portable runtime installations. Mark dicompare type imports explicitly and separate the unchanged NeSVoR reference validator from worker orchestration to remove dependency cycles.

  - @neurodesk/syncro@0.6.20261010

  - @neurodesk/runtime-support@0.4.1
  - @neurodesk/webapp-components@0.12.1
  - @neurodesk/brain-extraction@0.4.20261010
  - @neurodesk/synthsr@0.6.20261010
  - @neurodesk/synthstrip@0.1.5
  - @neurodesk/greedy@0.4.20261010

- Updated dependencies

  - @neurodesk/syncro@0.6.20261010

- Updated dependencies

  - @neurodesk/webapp-components@0.12.2
  - @neurodesk/registration@0.1.1
  - @neurodesk/runtime-support@0.4.2
  - @neurodesk/synthsr@0.6.20261010
  - @neurodesk/synthstrip@0.1.5
  - @neurodesk/brain-extraction@0.4.20261010
  - @neurodesk/greedy@0.4.20261010

- Updated dependencies
  - @neurodesk/runtime-support@0.4.1
  - @neurodesk/webapp-components@0.12.1
  - @neurodesk/brain-extraction@0.4.20261010
  - @neurodesk/synthsr@0.6.20261010
  - @neurodesk/synthstrip@0.1.5
  - @neurodesk/greedy@0.4.20261010

## 0.6.20261009

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
  - @neurodesk/greedy@0.4.20261009

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
  - @neurodesk/greedy@0.4.20261009

## 0.6.20261007

### Minor Changes

- d627aca: Add a macOS arm64 installer package for the `syncro` command line. It installs SYNcro in `/usr/local/lib/neurodesk/syncro` and the `syncro` command in `/usr/local/bin`, bundles Node and the models, and is signed with a Developer ID and notarized for release. The app no longer ships its own download dialog, which the shared bar's Standalone action had replaced, or the npm tarball that only that dialog linked.

### Patch Changes

- Updated dependencies [22aa4bf]
  - @neurodesk/webapp-components@0.11.1
  - @neurodesk/runtime-support@0.2.1
  - @neurodesk/synthsr@0.6.20261007
  - @neurodesk/synthstrip@0.1.3
  - @neurodesk/brain-extraction@0.1.23
  - @neurodesk/greedy@0.4.20261007
- Updated dependencies
  - @neurodesk/webapp-components@0.11.0
  - @neurodesk/runtime-support@0.2.0
  - @neurodesk/synthsr@0.6.20261007
  - @neurodesk/synthstrip@0.1.2
  - @neurodesk/brain-extraction@0.1.22
  - @neurodesk/greedy@0.4.20261007
- 6be20aa: Add the `topofit` command line: CPU reconstruction with ONNX Runtime Node, offline model installation with SHA-256 checks on every load, portable Linux x64 and Windows x64 archives, and a Developer ID signed, notarized macOS arm64 installer package that installs `/usr/local/bin/topofit`. Each bundles Node and the T1-weighted models, and each must match the OpenRecon end-to-end reference before release. SYNcro's portable archives are now built by the shared `exes/node-cli` packager; their contents and behaviour are unchanged apart from the launcher binary.
- Updated dependencies [70f2770]

  - @neurodesk/webapp-components@0.10.2
  - @neurodesk/greedy@0.4.20261007
  - @neurodesk/synthsr@0.6.20261007
  - @neurodesk/brain-extraction@0.1.21

- Updated dependencies [22aa4bf]

  - @neurodesk/webapp-components@0.11.1
  - @neurodesk/runtime-support@0.2.1
  - @neurodesk/synthsr@0.6.20261007
  - @neurodesk/synthstrip@0.1.3
  - @neurodesk/brain-extraction@0.1.23
  - @neurodesk/greedy@0.4.20261007

- Updated dependencies

  - @neurodesk/webapp-components@0.11.0
  - @neurodesk/runtime-support@0.2.0
  - @neurodesk/synthsr@0.6.20261007
  - @neurodesk/synthstrip@0.1.2
  - @neurodesk/brain-extraction@0.1.22
  - @neurodesk/greedy@0.4.20261007

- 6be20aa: Add the `topofit` command line: CPU reconstruction with ONNX Runtime Node, offline model installation with SHA-256 checks on every load, portable Linux x64 and Windows x64 archives, and a Developer ID signed, notarized macOS arm64 installer package that installs `/usr/local/bin/topofit`. Each bundles Node and the T1-weighted models, and each must match the OpenRecon end-to-end reference before release. SYNcro's portable archives are now built by the shared `exes/node-cli` packager; their contents and behaviour are unchanged apart from the launcher binary.

- Updated dependencies [70f2770]

  - @neurodesk/webapp-components@0.10.2
  - @neurodesk/greedy@0.4.20261007
  - @neurodesk/synthsr@0.6.20261007
  - @neurodesk/brain-extraction@0.1.21

- Updated dependencies

  - @neurodesk/webapp-components@0.11.0
  - @neurodesk/runtime-support@0.2.0
  - @neurodesk/synthsr@0.6.20261007
  - @neurodesk/synthstrip@0.1.2
  - @neurodesk/brain-extraction@0.1.22
  - @neurodesk/greedy@0.4.20261007

- Updated dependencies [22aa4bf]

  - @neurodesk/webapp-components@0.11.1
  - @neurodesk/runtime-support@0.2.1
  - @neurodesk/synthsr@0.6.20261007
  - @neurodesk/synthstrip@0.1.3
  - @neurodesk/brain-extraction@0.1.23
  - @neurodesk/greedy@0.4.20261007

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

- Updated dependencies

  - @neurodesk/synthsr@0.6.20261004
  - @neurodesk/brain-extraction@0.1.19

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

- Updated dependencies [ec85a09]

  - @neurodesk/webapp-components@0.10.0
  - @neurodesk/greedy@0.4.20261004
  - @neurodesk/synthsr@0.6.20261004
  - @neurodesk/brain-extraction@0.1.17

- Updated dependencies

  - @neurodesk/synthsr@0.6.20261004
  - @neurodesk/brain-extraction@0.1.19

- Updated dependencies

  - @neurodesk/webapp-components@0.10.1
  - @neurodesk/greedy@0.4.20261004
  - @neurodesk/synthsr@0.6.20261004
  - @neurodesk/brain-extraction@0.1.18

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

- Updated dependencies

  - @neurodesk/webapp-components@0.6.2
  - @neurodesk/greedy@0.4.20260930
  - @neurodesk/synthsr@0.5.20260930
  - @neurodesk/brain-extraction@0.1.12

- Updated dependencies

  - @neurodesk/webapp-components@0.6.2
  - @neurodesk/greedy@0.4.20260930
  - @neurodesk/synthsr@0.5.20260930
  - @neurodesk/brain-extraction@0.1.12

- Updated dependencies

  - @neurodesk/webapp-components@0.7.0
  - @neurodesk/greedy@0.4.20260930
  - @neurodesk/synthsr@0.5.20260930
  - @neurodesk/brain-extraction@0.1.13

  - @neurodesk/webapp-components@0.7.0
  - @neurodesk/greedy@0.4.20260930
  - @neurodesk/synthsr@0.5.20260930
  - @neurodesk/brain-extraction@0.1.13

## 0.4.20260928

### Patch Changes

- Updated dependencies

  - @neurodesk/webapp-components@0.6.1
  - @neurodesk/greedy@0.4.20260928
  - @neurodesk/synthsr@0.5.20260928
  - @neurodesk/brain-extraction@0.1.11

- 93381e8: Every app now opens on its workspace and shows live status only in the bottom bar: a short message, a progress bar, elapsed time and a cancel × that appears while a run can be cancelled. Start pages, landing overlays and welcome modals are gone, and their copy moved to About. Every app has a technical log below the viewer that starts collapsed. Sidebar help longer than 90 characters moved into info tooltips or About, and each sidebar has one primary action. `ProgressManager` now drives the design-system footer, including the elapsed counter and the cancel button.

  The shared example selector shows one short line once an example loads; the description and expected result moved to a tooltip beside the Example label. NiiMath gained the shared layout tabs and About dialog and no longer ships app CSS.

- Updated dependencies
- Updated dependencies [93381e8]
- Updated dependencies [93381e8]

  - @neurodesk/webapp-components@0.6.0
  - @neurodesk/greedy@0.4.20260928
  - @neurodesk/synthsr@0.5.20260928
  - @neurodesk/brain-extraction@0.1.10

- Updated dependencies

- Updated dependencies [93381e8]

  - @neurodesk/webapp-components@0.6.0
  - @neurodesk/greedy@0.4.20260928
  - @neurodesk/synthsr@0.5.20260928
  - @neurodesk/brain-extraction@0.1.10

- Updated dependencies [93381e8]

  - @neurodesk/webapp-components@0.6.0
  - @neurodesk/greedy@0.4.20260928
  - @neurodesk/synthsr@0.5.20260928
  - @neurodesk/brain-extraction@0.1.10

  - @neurodesk/webapp-components@0.6.1
  - @neurodesk/greedy@0.4.20260928
  - @neurodesk/synthsr@0.5.20260928
  - @neurodesk/brain-extraction@0.1.11

### Minor Changes

- Expose typed operations across the application catalog, including multiple inputs, DICOM series selection, variable artifacts and viewer workflows. Share awaited processing and cancellation between each app and its agent adapter. Publish verified result reports and scientific provenance.

  Add bounded desktop viewer sessions and MCP controls using public viewer APIs. Native SynthSeg now reports per-label counts and physical volumes. Include real-model CPU checks and a Mac runner for Metal, WebGPU and buffer-planning evidence without raising the validated SynthSeg limit.

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

- Updated dependencies

  - @neurodesk/webapp-components@0.4.3
  - @neurodesk/greedy@0.3.20260920
  - @neurodesk/synthsr@0.4.20260920
  - @neurodesk/brain-extraction@0.1.5

- Updated dependencies

  - @neurodesk/webapp-components@0.4.2
  - @neurodesk/greedy@0.3.20260920
  - @neurodesk/synthsr@0.4.20260920
  - @neurodesk/brain-extraction@0.1.4

- @neurodesk/greedy@0.3.20260920

- Updated dependencies [4959500]

  - @neurodesk/webapp-components@0.4.4
  - @neurodesk/greedy@0.3.20260920
  - @neurodesk/synthsr@0.4.20260920
  - @neurodesk/brain-extraction@0.1.6

- Updated dependencies

  - @neurodesk/webapp-components@0.4.3
  - @neurodesk/greedy@0.3.20260920
  - @neurodesk/synthsr@0.4.20260920
  - @neurodesk/brain-extraction@0.1.5

  - @neurodesk/webapp-components@0.4.2
  - @neurodesk/greedy@0.3.20260920
  - @neurodesk/synthsr@0.4.20260920
  - @neurodesk/brain-extraction@0.1.4

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

- Standardize example selection across the app catalog with complete scientific input bundles, shared cancellation and retry, and explicit processing. Add missing examples, curate existing datasets, fix QSMbly retry and TopoFit cancellation, and require example manifests and browser coverage for every app and the generator.

- Updated dependencies
  - @neurodesk/webapp-components@0.3.0
  - @neurodesk/greedy@0.3.20260916
  - @neurodesk/synthsr@0.4.20260916
  - @neurodesk/brain-extraction@0.1.1

## 0.3.20260915

### Patch Changes

- Include Brain extraction in the offline desktop suite with its SynthStrip model and a real BET extraction and download check. Reuse the shared MindGrab adapter in SYNcro.

- Updated dependencies

  - @neurodesk/webapp-components@0.2.2
  - @neurodesk/greedy@0.3.20260915
  - @neurodesk/synthsr@0.4.20260915

- Updated dependencies

  - @neurodesk/webapp-components@0.2.1
  - @neurodesk/greedy@0.3.20260915
  - @neurodesk/synthsr@0.4.20260915

- Reject out-of-field registration trial coordinates before integer conversion, preventing a threaded WebAssembly crash during SYNcro normalization. Include complete desktop and HPC release packaging with offline workflow gates.

  - @neurodesk/greedy@0.3.20260915

- Updated dependencies

  - @neurodesk/webapp-components@0.2.0
  - @neurodesk/greedy@0.3.20260915
  - @neurodesk/synthsr@0.4.20260915

- Updated dependencies

  - @neurodesk/webapp-components@0.2.0
  - @neurodesk/greedy@0.3.20260915
  - @neurodesk/synthsr@0.4.20260915

  - @neurodesk/webapp-components@0.2.2
  - @neurodesk/greedy@0.3.20260915
  - @neurodesk/synthsr@0.4.20260915

  - @neurodesk/webapp-components@0.2.1
  - @neurodesk/greedy@0.3.20260915
  - @neurodesk/synthsr@0.4.20260915

- Reject out-of-field registration trial coordinates before integer conversion, preventing a threaded WebAssembly crash during SYNcro normalization. Include complete desktop and HPC release packaging with offline workflow gates.

  - @neurodesk/greedy@0.3.20260915

### Minor Changes

- Add a shared Standalone action and offline desktop packaging with included, checksum-verified models and runtime dependencies. Remove the lightNIIng topbar link while retaining its About statement.

## 0.2.20260914

### Patch Changes

- Updated dependencies

  - @neurodesk/greedy@0.2.20260914

- 3cd773f: Greedy and EdgeReg show all three viewer panels on phones. TopoFit conforms axis-aligned and oblique scans through the pinned npm niimath WebAssembly worker. SYNcro now matches the native three-input workflow, offers four checksum-pinned tutorials, defaults to MindGrab and Greedy with SynthStrip and ANTs alternatives, uses niimath for lesion and masking operations, and switches one NiiVue viewer between images with automatic lesion overlays. SynthSR lets adapter limits govern its largest activation buffer, so validated 256×256×192 scans and larger volumes on capable GPUs are attempted while other shared U-Net callers retain their existing limit. Add the standalone ANTS registration demo.
- Updated dependencies [3cd773f]
- Updated dependencies [4add8da]

  - @neurodesk/greedy@0.1.20260914
  - @neurodesk/webapp-components@0.1.5
  - @neurodesk/runtime-support@0.1.2
  - @neurodesk/synthsr@0.3.20260914

- Updated dependencies

  - @neurodesk/webapp-components@0.1.4
  - @neurodesk/synthsr@0.3.20260914

- Updated dependencies

  - @neurodesk/webapp-components@0.1.4
  - @neurodesk/synthsr@0.3.20260914

  - @neurodesk/greedy@0.2.20260914

- 3cd773f: Greedy and EdgeReg show all three viewer panels on phones. TopoFit conforms axis-aligned and oblique scans through the pinned npm niimath WebAssembly worker. SYNcro now matches the native three-input workflow, offers four checksum-pinned tutorials, defaults to MindGrab and Greedy with SynthStrip and ANTs alternatives, uses niimath for lesion and masking operations, and switches one NiiVue viewer between images with automatic lesion overlays. SynthSR lets adapter limits govern its largest activation buffer, so validated 256×256×192 scans and larger volumes on capable GPUs are attempted while other shared U-Net callers retain their existing limit. Add the standalone ANTS registration demo.

- Updated dependencies [3cd773f]

- Updated dependencies [4add8da]

  - @neurodesk/greedy@0.1.20260914
  - @neurodesk/webapp-components@0.1.5
  - @neurodesk/runtime-support@0.1.2
  - @neurodesk/synthsr@0.3.20260914

- Updated dependencies [4add8da]

  - @neurodesk/greedy@0.1.20260914
  - @neurodesk/webapp-components@0.1.5
  - @neurodesk/runtime-support@0.1.2
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

- Apply the shared design system and the registry-driven About and Cite dialogs. Every app now states that it is developed and hosted by the Neurodesk team, lists the packages under the hood, names the lightning.org ecosystem, and cites one paper per implemented method plus the Neurodesk platform paper. SynthSR, SYNcro, Deface, BrowserQC and NiiMath use the shared workspace vocabulary (compact sections, one scan picker, shared toolbar, status bar and dialogs).

- Updated dependencies
  - @neurodesk/webapp-components@0.1.3
