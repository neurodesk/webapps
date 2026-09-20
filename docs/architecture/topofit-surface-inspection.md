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

## Design comparison

The native design keeps scientific geometry in `packages/topofit` and selection
and display in `apps/topofit`. The existing NiiVue `locationChange` event continues
to report cursor position separately from patch measurements.

The alternative was the [FreeBrowse migration integration](https://github.com/freesurfer/freebrowse/issues/38#issuecomment-5688546796).
Its [`mountFreeBrowse` API](https://github.com/pwighton/freebrowse/blob/20260707-niivue-mono-migration/frontend/src/mount.tsx)
mounts a complete React viewer and owns canvas attachment. The header is always
rendered; hiding its sidebar/footer does not supply a headless API. Its footer
shows cursor RAS, not patch normals. Published `freebrowse@2.5.0-next.1` pins
NiiVue rc.13 while TopoFit uses patched rc.11. Two independent design candidates
and a comparison favored native integration: FreeBrowse would still need the
same geometry/readout work and add a viewer upgrade and UI ownership changes.

The chosen scope inspects detected patches. It does not implement arbitrary
surface-point picking or editing. Geometry unit tests and browser tests cover
midpoint export, RAS measurement accuracy, selection, downloads and reset.
