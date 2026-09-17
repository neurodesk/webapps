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

The browser offers four anatomical FreeSurfer triangular surface files, a source-grid QC
NIfTI, and a JSON processing manifest. White and pial surface checkboxes can be
combined over the anatomical slices or in 3D. The X-ray control appears while a
cortical surface is visible and defaults to 10%. Registration spheres are retained
internally for atlas mapping and excluded from the browser output list. DICOM
import uses the shared dcm2niix worker. Images and results are not uploaded to a processing service.

Open **Surface analysis** before reconstruction to export mid-surface normals
or find flat cortical patches. Patch radius, count and hemisphere are available
when the search is enabled; quality thresholds and a native-grid ROI are under
**Patch quality and region**. Closing a section preserves its settings.

Results include individual patch surfaces, patch-and-normal QC, measurements
and paired ribbon geometry. Patches are labeled "Left flat patch 1", "Right flat patch 1", and so on.
Numbers follow flatness within each hemisphere, not area; the ranking is
described in `packages/topofit/README.md`.
Select one to center the 3-Plane viewer on it. Meshes are clipped to a 1 mm
band around each slice so scrolling away does not project the patch onto other regions.
Selected patches use yellow, two-sided slice intersections so the brain image
and surface orientation do not hide the patch.
Download the normals CSV or geometry JSON for local analysis. The output schema
and OpenRecon comparison command are documented in `packages/topofit/README.md`.

After reconstruction, edit **Surface analysis** and select **Run surface analysis**
to run or repeat normals and patch analysis on the existing cortex. The action
becomes available after a successful reconstruction. It uses a separate worker
and does not run the neural models again. New analysis results replace previous
analysis results and update the processing manifest; cancellation or failure
keeps the previous outputs. Loading another scan clears the saved reconstruction.
