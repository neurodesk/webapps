# surfannotate

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
