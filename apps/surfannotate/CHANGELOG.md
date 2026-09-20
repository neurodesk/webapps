# surfannotate

## 0.5.20260920

### Patch Changes

- Updated dependencies
  - @neurodesk/webapp-components@0.4.3


### Patch Changes

- Updated dependencies
  - @neurodesk/webapp-components@0.4.2

## 0.5.20260918

### Patch Changes

- Updated dependencies

  - @neurodesk/webapp-components@0.3.1
  - @neurodesk/webapp-components@0.4.1

- Replace shared UI builders with light-DOM custom elements for consoles, file fields, result lists, viewer toolbars and example selectors. Migrate app callers, isolate control IDs and upload scopes, and preserve state while cleaning up listeners and cancelled downloads across component removal.
- Updated dependencies
  - @neurodesk/webapp-components@0.4.0

## 0.5.20260917

### Minor Changes

- Add retinotopy palettes and hemisphere flipping, editable ROI sessions, whole-parcellation exports, and overlays shared across matching surfaces. Preserve ROI boundaries on GIfTI reimport, keep shared overlays consistent when switching surfaces, and improve export selection and touch controls. Update desktop validation to save the filled ROI before exporting it.

## 0.4.20260916

### Patch Changes

- Standardize example selection across the app catalog with complete scientific input bundles, shared cancellation and retry, and explicit processing. Add missing examples, curate existing datasets, fix QSMbly retry and TopoFit cancellation, and require example manifests and browser coverage for every app and the generator.
- Updated dependencies
  - @neurodesk/webapp-components@0.3.0

## 0.4.20260915

### Patch Changes

- Updated dependencies
  - @neurodesk/webapp-components@0.2.2

### Patch Changes

- Updated dependencies
  - @neurodesk/webapp-components@0.2.1

### Minor Changes

- Add a shared Standalone action and offline desktop packaging with included, checksum-verified models and runtime dependencies. Remove the lightNIIng topbar link while retaining its About statement.

### Patch Changes

- Updated dependencies
  - @neurodesk/webapp-components@0.2.0

## 0.3.20260914

### Patch Changes

- Updated dependencies [3cd773f]
- Updated dependencies [4add8da]
  - @neurodesk/webapp-components@0.1.5

### Patch Changes

- Updated dependencies
  - @neurodesk/webapp-components@0.1.4

## 0.3.20260910

### Minor Changes

- Release the complete application catalog after integrating BrowserQC, dwi2trx and SynthSeg. Preserve shared interface behavior and publish bundles with synchronized date versions.

## 0.2.20260910

### Changes

- Adopt MAJOR.MINOR.YYYYMMDD versioning, link every app to the lightNIIng ecosystem (lightniing.org) from the app bar and About dialog, and keep build scratch files off the shared /tmp volume.

## 0.2.4

### Patch Changes

- Apply the shared design system and the registry-driven About and Cite dialogs. Every app now states that it is developed and hosted by the Neurodesk team, lists the packages under the hood, names the lightning.org ecosystem, and cites one paper per implemented method plus the Neurodesk platform paper. SynthSR, SYNcro, Deface, BrowserQC and NiiMath use the shared workspace vocabulary (compact sections, one scan picker, shared toolbar, status bar and dialogs).
- Updated dependencies
  - @neurodesk/webapp-components@0.1.3

## 0.2.3

### Patch Changes

- Promote SurfAnnotate and ZARRo from experimental to active support.

## 0.2.2

### Patch Changes

- cd790d5: Finish shared imaging convergence by centralizing worker sessions, input handling, app-specific controllers, workspace styles, and runtime clients. Strengthen shell contracts and regression coverage.

## 0.2.1

### Patch Changes

- 5560336: Consolidate imaging workers, pipeline execution, viewer behavior, NIfTI serialization, runtime wrappers, shared styling, and hosted shell controls. Fix CALMaR analysis startup and layout, and remove horizontal overflow from Deface controls.

## 0.2.0

### Minor Changes

- 3fd72ca: Load a dropped file as the vertex mask when its name contains "mask". A mask is stored in the same formats as any overlay, so nothing in the bytes distinguishes the two and a dropped mask previously arrived as an overlay painted across the whole surface — it had to go through the "Choose a mask" picker instead. Names like `lh.V1.mask`, `lh.cortex_mask.gii` and `sub-01_desc-brainmask.nii.gz` are now routed to the mask; `lh.thickness.masked.gii` still loads as the overlay it is, and a surface keeps loading as a surface whatever it is called. The overlay picker is unchanged, so it remains the way to view a mask as data.
- 0ba88e9: Draw the active overlay's colour scale on the view: a colour wheel for eccentricity and polar angle, a ticked bar for every other colour map.
- 05b4035: Add a binary vertex mask that limits every overlay to the vertices it marks, leaving the curvature underneath visible. Curvature overlays are exempt by default and any overlay can be exempted by hand.
- dba196d: Remove the "Fill style" control. Solid, hatched and outline-only were purely cosmetic — the region, the exports and the saved ROI were identical whichever was chosen — and in practice the difference was not legible on a folded surface. The filled region is always drawn solid now, at the opacity the slider sets.
- d2bb9f3: Add eccentricity and polar-angle colour maps (contributed by DL), each with the display window its scale requires.
- dba196d: Name the edge-closure button after the edge that exists. A finished ROI's rim already closed a region exactly as a flat patch's cut does, but the button and its hint only ever described the flat-patch case — so on a whole hemisphere, where there is no visible edge, the feature read as inapplicable at the moment it was the right tool. It now reads "Close on ROI edge" when a saved ROI is what you can close against, and clicking inside a saved ROI leads with that option instead of only offering to reorder or reopen the list.
- dba196d: Draw border points and landmarks as sharp screen-space markers instead of blurred patches of mesh colour. They were painted as vertex labels over the clicked vertex and its 1-ring, which meant they were interpolated across the triangles, sized by the mesh rather than the screen, and wider than the vertex they marked — the reason they had to disappear once a region was filled. They are now projected onto their own canvas at a fixed size, each with a contrasting outline so it stays visible over any surface, overlay or ROI fill, and they stay put when the region is filled. Choose between a circle, a dot and a cross, in white, black, magenta or yellow; landmarks take the other shape. Markers on the far side of a closed surface are hidden rather than showing through it.

## 0.1.5

### Patch Changes

- Improve dark-theme contrast for upload controls and informational dialogs.

## 0.1.4

### Patch Changes

- 46be48e: Add a persistent light and dark theme switch to the webapp catalog and every hosted or standalone webapp bundle.

## 0.1.3

### Patch Changes

- Standardize the Neurodesk app shell and add DNT/GPC-respecting page-view analytics with aggregate per-app usage statistics.

## 0.1.2

### Patch Changes

- Align the application interfaces with the Neurodesk design system and point app source links at the webapps monorepo.

## 0.1.1

### Patch Changes

- 4a4dd72: Apply the Neurodesk designer-guide theme to hosted and standalone webapp bundles.
