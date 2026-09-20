# TopoFit web app

TopoFit reconstructs left and right white, pial, and spherical-registration surfaces from a T1-weighted brain MRI. Processing stays in a browser worker. The app downloads hash-verified, revision-pinned BrainNet 0.2 models in ONNX format from the Neurodesk Hugging Face dataset.

Use a desktop browser with cross-origin isolation and several gigabytes of available memory. The complete order-6 reconstruction contains 245,762 vertices and 491,520 faces per hemisphere.

The browser uses the pinned npm `@niivue/niimath` WebAssembly worker to apply
`-conform -ras`, resampling axis-aligned and oblique NIfTI geometry onto a
centred 256³ 1 mm RAS grid. The original image and affine remain available for
the source-grid QC volume.

```bash
pnpm --filter topofit dev
pnpm --filter topofit build
pnpm --filter topofit test
pnpm --filter topofit test:e2e
```

For offline model development, set `TOPOFIT_ASSET_DIR` to the exported release directory and `VITE_TOPOFIT_ASSET_BASE=/model-assets/`. See [`packages/topofit/validation/README.md`](../../packages/topofit/validation/README.md) for the pinned-container comparison.

The browser offers six anatomical FreeSurfer triangular surface files, a source-grid QC
NIfTI. The processing manifest is recorded in the technical log. Each surface's View button selects it alone
without changing the current layout. Slice views show its boundaries, while Render
shows it in 3D with the MRI clipped away so the skull cannot obscure it. White,
mid-surface and pial checkboxes combine surfaces for comparison or STL export.
The 2D slices show thin surface boundaries. FreeBrowse provides axial, coronal,
sagittal, ACS, ACSR and Render views. ACSR shows all three slices with the 3D
render; Render shows the surface in 3D. Its sidebar offers volume and surface
visibility, contrast, color and opacity controls. The X-ray control appears while a
cortical surface is visible and defaults to 0%. Registration spheres are retained
internally for atlas mapping and excluded from the browser output list. DICOM
import uses the shared dcm2niix worker. Images and results are not uploaded to a processing service.

Explicitly enabling the source volume in FreeBrowse also reveals the anatomy in
3D. That choice persists across surface selections; loading a new scan restores
the default of hiding anatomy in 3D surface scenes.

Under Output, open **Normal arrows** and enable **Plot mid-surface normals**.
Arrows appear on visible mid-surfaces without requiring a separate analysis run.
Choose Sparse, Medium or Dense spacing and an arrow length from 0.5 to 10 mm.
Arrows use the exported area-weighted vertex normals, oriented white-to-pial,
with their bases at scanner-RAS mid-surface vertices. Spatial sampling separates
the bases by at least 12, 8 or 5 mm, including across neighboring folds.
The display follows surface visibility and preserves the selected layout.
Slice views show only arrow geometry intersecting the slice slab; 3D shows the
complete arrows. Display settings do not change the exported normals or STL.

**Save printable STL…** in Output converts surfaces for 3D printing: FreeSurfer
surface files are not a printing format. niimath simplifies each mesh to a
chosen fraction of its triangles (10 to 100%, default 25) and optionally
smooths it (0 to 20 Humphrey iterations, default 0); TopoFit writes a binary
STL in millimetres per white or pial surface. Ticked white and pial surfaces are
exported, or all four when none of those is ticked. A 245,762-vertex hemisphere reduces in under a second.

Because the published `@niivue/niimath` WebAssembly build compiles mesh support
without `HAVE_FORMATS`, it can only write mz3, and its fluent JavaScript API
appends `-odt` where niimath's mesh mode expects the output name. The app
therefore drives the same WebAssembly module directly and writes the STL
itself; both limits are fixed upstream for the release after 1.4.20260909.

Use **Surface analysis** before reconstruction to export mid-surface normals
or find flat cortical patches. Patch radius, count and hemisphere are available
when the search is enabled; quality thresholds and a native-grid ROI are under
**Patch quality and region**. Advanced settings and Surface analysis stay visible.

Results include individual patch surfaces, patch-and-normal QC and paired ribbon
geometry. Analysis measurements are recorded in the technical log. Patches are
labeled "Left flat patch 1", "Right flat patch 1", and so on.
Numbers follow flatness within each hemisphere, not area; the ranking is
described in `packages/topofit/README.md`.
Select one to center the 3-Plane viewer on it and show its RAS point in millimetres
and outward unit plane normal. The point is a mid-surface member vertex nearest
the patch centroid. The readout stays fixed when the crosshair moves. **Copy patch
RAS measurements** copies full precision, and **Patch coordinates and normals
(RAS)** downloads all patches as CSV.

Patch meshes are clipped to a 1 mm
band around each slice so scrolling away does not project the patch onto other regions.
Selected patches use yellow, two-sided slice intersections so the brain image
and surface orientation do not hide the patch.
The complete mid-surfaces are the corresponding white/pial vertex midpoints;
they are available without running surface analysis. Their downloads are
`lh.mid.white` and `rh.mid.white`, using FreeSurfer triangular mesh format.

Download the per-vertex normals CSV or geometry JSON for local analysis. The output schema
and OpenRecon comparison command are documented in `packages/topofit/README.md`.

After reconstruction, edit **Surface analysis** and select **Run surface analysis**
to run or repeat normals and patch analysis on the existing cortex. The action
becomes available after a successful reconstruction. It uses a separate worker
and does not run the neural models again. New analysis results replace previous
analysis results and update the processing manifest; cancellation or failure
keeps the previous outputs. Loading another scan clears the saved reconstruction.
