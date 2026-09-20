# TopoFit mid-surface and patch inspection

TopoFit displays bilateral mid-surfaces and exposes each detected flat patch's
representative point and fitted normal in scanner RAS coordinates.

## Usage and ownership

`runTopofit(options).files` includes `lh-mid` and `rh-mid` even when optional
surface analysis is disabled. Their FreeSurfer files use `.mid.white` names so
NiiVue recognizes the mesh format. The existing result-list checkboxes view them
in 3-Plane or 3D, and Download saves the complete meshes.

Selecting a flat patch centers the crosshair on `center_ras_mm` and displays that
point with `normal_ras`. The readout remains the selected patch's measurement
when the user moves the crosshair. Copy preserves full precision; the patch CSV
exports every detected patch. New scans and replacement analysis clear stale
selections.

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

`mountViewer(element, options)` in `apps/topofit/src/freebrowse-viewer.js` returns
`{ nv, ready, destroy }`. FreeBrowse owns the React UI and canvas attachment;
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

Two design candidates compared the public mount API with the public React
component. The independent comparison favored mount because React exposes the
same complete viewer without additional composition slots and would duplicate
mount configuration and cleanup. Both candidates identified event-driven mesh
state as necessary. Scientific geometry and detected-patch measurements remain
in their existing modules; arbitrary surface-point inspection is outside scope.
