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
   `Editing <result>. Left-drag paints; Apply keeps the changes.`
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
                | { state: 'editing', stage, file, labelValues, tool, label, brush }
                | { state: 'applying', stage }
EditTool = 'draw' | 'erase' | 'fill'
EditedResult = StageResult & { editable: true, edited?: true, original?: File }
```

The session is a small state machine in the element; the toolbar is rendered
from it, never the other way round.

## Code

- `packages/components/src/viewer/drawing.js`. `createDrawingAdapter(nv)` hides
  the two NiiVue API generations the apps use (0.x: `setDrawingEnabled`,
  `setPenValue`, `opts.penSize`, `loadDrawingFromUrl`, `saveImage`; 1.0:
  `drawIsEnabled`, `drawPenValue`, `drawPenSize`, `drawPenFilled`,
  `loadDrawing(File)`, `saveDrawing('')`). `maskToUint8Nifti(file)` converts any
  NIfTI datatype to the uint8 image both generations require, and
  `distinctLabels(file)` lists the non-zero values for the Label select.
- `packages/components/src/elements/mask-editor.js`. `createMaskEditor({ nv,
  onApply, onCancel, labelNames })` returns the element; `start({ stage, file,
  label, overlayIndex })` and `cancel()` drive it. Mount it after
  `createViewerToolbar` in `#viewer`.
- `createResultList` accepts `onEdit(stage, result)` and renders
  `.nd-edit-btn` for results with `editable: true`; a result with `edited: true`
  is labelled `… (edited)`.
- Styles are vocabulary in `imaging-workspace.css`: `.nd-mask-editor`,
  `.nd-tool-group`, `.nd-tool-btn`, `.nd-brush-control`, `.nd-edit-btn`.

Apps with their own editors before this element existed (calmar's lesion
review, QSMbly's mask brush) keep them; they offer more than draw, erase and
fill and are covered by their own tests.
