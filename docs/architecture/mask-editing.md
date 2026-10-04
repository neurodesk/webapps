# Manual mask and label editing

Every app that produces a binary mask or a label map lets the user correct it
in the viewer before downloading it. The editor is one shared element,
`nd-mask-editor`, driven by NiiVue's own drawing layer. Apps never write draw
code; they mark a result as editable and accept the corrected file back.

## What the user sees

1. An editable result row in the Output section shows **Edit** next to View and
   Download. Pressing it opens the editor: the input image stays as the base,
   the result overlay is hidden, and the same voxels appear as NiiVue's
   drawing layer at the result's colours.
2. A second toolbar row appears under the viewer toolbar:
   `Editing <result>` · Draw | Erase | Fill · Label (label maps only) · Brush
   size · Undo · Apply · Cancel. The footer status reads
   `Editing <result>. Left-drag paints; Apply keeps the changes.` The element
   supplies that text as the `message` of its `nd-mask-edit-start` event; the
   app shows it through `ProgressManager`, which owns the footer.
3. **Draw** paints the active label with the brush. **Erase** paints 0.
   **Fill** is NiiVue's filled pen: outline a region and it fills when the
   pointer is released. Edits are per slice in any 2D view. Undo steps back
   one stroke (Ctrl+Z). Keys D, E, F pick tools; `[` and `]` change the brush.
4. **Apply** writes the drawing back onto the result's own grid as an
   uncompressed uint8 NIfTI (gzipped if the result name ends in `.gz`),
   replaces the result in the Output list, which now says `edited`, and
   reloads the overlay. Download then returns the edited file. **Cancel**
   discards the strokes and restores the overlay. Editing again starts from
   the edited file.

Only one result can be edited at a time; other Edit buttons are disabled while
a session is open. Running the pipeline again closes an open session and
discards unapplied strokes.

## Data shape

```
MaskEditSession = { state: 'idle' }
                | { state: 'opening', stage }
                | { state: 'editing', stage, file, label, labelValues, choices,
                    tool, value, brush, overlay: { index, opacity } | null }
                | { state: 'applying', stage }
EditTool = 'draw' | 'erase' | 'fill'
EditedResult = StageResult & { editable: true, edited?: true, original?: File }
```

The session is a small state machine in the element; the toolbar is rendered
from it, never the other way round. `label` is the result's display name,
`value` the label value being painted, and `choices` the values the Label
select offers: those in the mask plus any named in `labelNames`. `opening`
covers the asynchronous load; the toolbar stays hidden, and a `cancel()`
while opening returns `start()` `false` once the load finishes.

## Code

- `packages/components/src/viewer/drawing.js`. `createDrawingAdapter(nv)` hides
  the two NiiVue API generations the apps use (0.x: `setDrawingEnabled`,
  `setPenValue`, `opts.penSize`, `loadDrawingFromUrl`, `saveImage`; 1.0:
  `drawIsEnabled`, `drawPenValue`, `drawPenSize`, `drawPenFilled`,
  `loadDrawing(File)`, `saveDrawing('')`). It also sets the hidden overlay's
  opacity: 0.x has `setOpacity(index, value)`, 1.0 only
  `setVolume(index, { opacity })`. The async `maskToUint8Nifti(source)`
  converts any NIfTI datatype to the uint8 image both generations require
  (values rounded and clamped to 0..255, scaling applied and reset, header and
  affine kept), and `distinctLabels(source)` lists the non-zero values for the
  Label select. `editedFileName(name)` keeps a NIfTI name and appends `.nii`
  to any other.
- Both generations' save returns the drawing on the base image's native grid,
  uncompressed; 0.x reorients in `toUint8Array`, so the adapter needs no
  `drawBitmap` arithmetic. NiiVue 1.0 rc.11 to rc.14 `loadDrawing`, however,
  reorders the drawing with the base's RAS extents instead of its native ones.
  On an image whose axes are permuted and of unequal size, such as a sagittal
  acquisition, the mask lands on the wrong voxels. `open()` therefore checks
  that the loaded mask saves back unchanged. If it does not, `open()` measures
  where the round trip sends each voxel, with one probe load per byte of the
  voxel index. It then loads the layout that undoes the round trip and checks
  again. A NiiVue that loads correctly passes the first check, so a fixed
  release needs no change here. A mask whose dimensions differ from the base
  image is refused before loading.
- `packages/components/src/elements/mask-editor.js`. `createMaskEditor({ nv,
  onApply, onCancel, onError, labelNames })` returns the element;
  `start({ stage, file, label, overlayIndex, colormap })`, `apply()` and
  `cancel()` drive it. `start()` rejects when NiiVue refuses the mask. Failures
  of the toolbar's own Apply and Cancel buttons go to `onError(stage, error)`
  and an `nd-mask-edit-error` event. The element also dispatches
  `nd-mask-edit-start` (`{ stage, message }`), `nd-mask-edit-apply` and
  `nd-mask-edit-cancel` (`{ stage }`). Mount it after `createViewerToolbar`
  in `#viewer`.
- `createResultList` accepts `onEdit(stage, result)` and renders
  `.nd-edit-btn` for results with `editable: true`; a result with `edited: true`
  is labelled `… (edited)`. `setEditingEnabled(false)` disables every Edit
  button, including those of rows rendered later, until it is called with
  `true`.
- Styles are vocabulary in `imaging-workspace.css`: `.nd-mask-editor`,
  `.nd-tool-group`, `.nd-tool-btn`, `.nd-brush-control`, `.nd-edit-btn`.

Apps with their own editors before this element existed (calmar's lesion
review, QSMbly's mask brush) keep them; they offer more than draw, erase and
fill and are covered by their own tests.
