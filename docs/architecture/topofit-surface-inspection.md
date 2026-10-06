# TopoFit mid-surface and patch inspection

TopoFit displays bilateral mid-surfaces and exposes each detected flat patch's
representative point and fitted normal in scanner RAS coordinates.

## Usage and ownership

`runTopofit(options).files` includes `lh-mid` and `rh-mid` even when optional
surface analysis is disabled. Their FreeSurfer files use `.mid.white` names so
NiiVue recognizes the mesh format. Each result's View button selects that surface
alone in the current layout. Checkboxes combine surfaces for comparison or STL export, and
Download saves the complete meshes.

Selecting a flat patch centers the crosshair on `center_ras_mm` and displays that
point with `normal_ras`. The readout remains the selected patch's measurement
when the user moves the crosshair. Copy preserves full precision; the patch CSV
exports every detected patch. New scans and replacement analysis clear stale
selections.

The technical log records surface analysis measurements and the processing
manifest. Neither appears as a View or Download row. Patch coordinates and
geometry remain downloadable scientific outputs.

Optional normal arrows use the same `surfaceNormals` implementation as the CSV
export. A separate display worker caches each hemisphere's normals, spatially
samples vertices in scanner RAS, and returns an MZ3 glyph mesh. Arrow tips are
`midpoint + length * outward_unit_normal`; spacing and length are in millimetres.
Glyph meshes follow visible mid-surfaces and never enter scientific outputs or
STL selection. The worker and its cache are discarded on replacement input or
reconstruction. FreeBrowse hiding or removing a glyph mesh disables the option.

## Scientific contract

`midSurface(white, pial)` returns corresponding vertex midpoints in Float64.
`writeSurfaceFiles(vertices, faces)` serializes the reconstructed surfaces and
both complete mid-surfaces. Reconstruction and reanalysis preserve their hashes.

The existing patch search chooses the member vertex nearest the area-weighted
patch centroid as its representative center. `center_vertex_index` identifies
that vertex in the hemisphere's full mesh. `normal_ras` is the unit fitted-plane
normal, oriented white-to-pial, not necessarily the local vertex normal.
Coordinates are source/scanner RAS millimetres; normals are dimensionless RAS
components. Neither is FreeSurfer registration-sphere or voxel coordinates.
The patch geometry JSON separately exports per-vertex positions and normals.

## Viewer integration

TopoFit mounts the published `freebrowse@2.5.0-next.1` from the
[niivue-mono migration branch](https://github.com/pwighton/freebrowse/tree/20260707-niivue-mono-migration)
at commit `1e6c35ca5d529f999d9537f2b220573f038c84e6`. Its NiiVue peer is pinned
to `1.0.0-rc.13`; other apps retain their existing versions.

`mountViewer(element, options, embed)` in
`packages/runtime-support/src/freebrowse-viewer/index.js`
(`@neurodesk/runtime-support/freebrowse-viewer`) returns
`{ nv, ready, setDrawingLocked, destroy }`. `setDrawingLocked(true)` makes
FreeBrowse's Drawing tab and Edit as drawing buttons inert (still visible,
dimmed) while a host edits the drawing layer with its own tools; Spinal Cord
Toolbox does so while the shared `nd-mask-editor` is open. The helper is shared: Spinal Cord Toolbox mounts the
same viewer, and bundler-less apps receive it as a prebuilt ES module (see
"Sharing the viewer" below). FreeBrowse owns the React UI and canvas attachment;
TopoFit owns the source image, reconstruction outputs and selected patch.
Callers await `ready` before loading files into the same NiiVue instance. A small
NiiVue subclass observes the actual attachment promise because FreeBrowse's
public mount handle does not expose readiness. Attachment failures reach the
normal input error path. Teardown releases React listeners and NiiVue resources;
back-forward cached pages retain the mounted viewer.

FreeBrowse supplies view selection, volume and surface controls, and viewer
settings. TopoFit retains its X-ray control and scientific output list. NiiVue
mesh and volume events synchronize the output controls and clear measurements
when the selected patch or QC overlay is hidden or removed. Removal events fire
before model mutation in rc.13, so readers use a microtask, matching FreeBrowse's
own event adapter. Surface lookup uses output filenames rather than mutable
array indices.

Surface scenes use the `crosscut` slice shader with a 1 mm thickness, while 3D
uses the normal shaded mesh. A volume clip plane at depth -1 removes the entire
MRI ray march without removing slice images or clipping meshes. Explicit source
volume opacity changes in FreeBrowse show or hide the 3D anatomy and retain that
choice across surface selections. A new input resets to hidden. Original-image
and QC scenes reset the plane to the disabled depth 2. X-ray defaults to zero so
hidden folds do not show through the surface. The View action replaces the mesh
scene without changing the selected layout. ACS retains boundary-only slices,
ACSR shows them beside the 3D mesh, and Render keeps the standalone 3D view.

The embedding uses an open shadow root because FreeBrowse's published Tailwind
utilities are global and marked important. Both its stylesheet and the shared
imaging-workspace stylesheet are installed inside that root. Shared embedding
rules map colors to Neurodesk tokens, adapt the toolbar/sidebar to narrow
viewers, and hide FreeBrowse's duplicate branding and private theme switch.
The shell controls the theme. A small DOM adapter supplies labels for icon-only
tabs and visibility buttons. These selectors are a pinned-package compatibility
contract covered by browser tests. No FreeBrowse bundle or internal store is
patched or imported. Backend access, URL loading and canvas drop imports are
disabled; TopoFit's input flow remains responsible for reconstruction inputs.
The renderer retains WebGL2 for the verified two-sided patch intersections.

### Sharing the viewer

FreeBrowse is React and ESM, and NiiVue 1.0 ships bare-specifier ESM, so an app
without a bundler cannot import either. `packages/runtime-support/scripts/build-freebrowse-viewer.mjs`
builds `src/freebrowse-viewer/static.js` into one self-contained ES module
(FreeBrowse, NiiVue, both stylesheets). An app that sets
`neurodeskWebapp.static.freebrowseViewer` in its `package.json` gets that module
in `web/freebrowse-viewer/` from `pnpm runtime-support`, beside dcm2niix and
nifti-js. The bundle is generated, ignored by version control, cached on a hash
of its inputs, and served from the app's origin; the static build copies it into
`dist/`, so the deployed site and the offline desktop package need no CDN. It
also exports `NiiVue`, `SLICE_TYPE`, `SHOW_RENDER` and `DRAG_MODE`, so a static
app's extra canvases use the NiiVue build FreeBrowse is pinned to.

NiiVue 1.0.0-rc.13 tracks one pointer, so a phone could neither zoom nor pan.
`touch-gestures.js` maps a two-finger gesture onto NiiVue's own zoom and pan:
a pinch sets `pan2Dxyzmm[3]` on a slice or `scaleMultiplier` on the render,
and a two-finger drag is replayed to NiiVue as a pan drag at the midpoint. It
uses public properties and DOM pointer events only; remove it when NiiVue
handles multi-touch. In draw mode the first finger has already started a pen
stroke when the second lands, so the adapter undoes that stroke (when
`currentDrawUndoBitmap` moved) and a pinch leaves no dot.

Two design candidates compared the public mount API with the public React
component. The independent comparison favored mount because React exposes the
same complete viewer without additional composition slots and would duplicate
mount configuration and cleanup. Both candidates identified event-driven mesh
state as necessary. Scientific geometry and detected-patch measurements remain
in their existing modules; arbitrary surface-point inspection is outside scope.
