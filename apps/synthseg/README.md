# SynthSeg (web)

Segments a 3D brain scan into FreeSurfer labels in the browser. Preprocessing,
post-processing and NIfTI I/O are the native CLI's Rust compiled to WASM
(`@neurodesk/synthseg`); the U-Net runs on WebGPU through the shared
`@neurodesk/runtime-support/gpu-unet` executor.

WebGPU is required — there is no WASM fallback. Without it the app says so and
Run stays disabled.

Labels use the shared `@neurodesk/webapp-components/automation/freesurfer-lut`
mapping, also used by native automation reports. Regenerate its 33 SynthSeg label
entries with `node scripts/freesurfer-lut.mjs <FreeSurferColorLUT.txt>`.

## Controls

- **Input image** — NIfTI or DICOM (drag-drop supported), or the `T1_head` example.
- **Age and Sex** — the subject for the volume report. A DICOM series fills them from
  its dcm2niix sidecar (`PatientAge`, or whole years from `PatientBirthDate` to the
  acquisition date, and `PatientSex`); the sidecar stays in memory. The run report
  records age, sex and scanner field strength. A new image resets them. Blank means unknown: no percentile, and the
  pooled female and male reference.
- **Reference** — the norms the volume report compares against: IXI (1.5 T and 3 T) or
  AHEAD (7 T). **Auto**, the default and what a new image resets to, reads
  `MagneticFieldStrength` from the same sidecar and uses AHEAD from 5 T upward, like the
  container's `select_norms`. Below 5 T, and for NIfTI input, which has no field
  strength, it uses IXI. Each reference has fast-mode and default-mode norms, and the
  report uses the ones that match the run's Mode. The report names the reference and why
  it was chosen.
- **Mode** — `fast` (the default) is a single pass; `default` adds flip averaging and
  topological correction. Each mode is compared with norms segmented in that mode,
  because default mode measures cortex, ventricles and hippocampus several percent
  differently.
- **CT** — auto-checked when the loaded image contains negative intensities.
- **Image preparation** — scans that exceed the GPU buffer limit first use niimath's
  robust FOV to keep 170 mm below the top of the head and remove excess neck. You can
  turn this off. Scans that already fit keep their original field of view.
  If cropping is insufficient, the app offers the smallest fitting processing voxel
  size in 0.1 mm increments, up to 3 mm. Selecting **Use … mm and segment** reruns
  preprocessing and inference on that coarser grid. You can also set the processing
  voxel size directly. Inspect the labels after either adjustment.
  Coarser grids reduce anatomical detail and can affect segmentation and volume
  estimates. The Volumes view notes that its 1 mm reference norms have not been
  validated for these grids. The input remains unchanged; label downloads use the
  processed grid, with its physical affine, and the JSON records the crop, original
  and cropped dimensions, and processing voxel size.
- **Output** — label-overlay opacity, `<stem>_synthseg.nii.gz`, `<stem>_synthseg_vol.csv`
  (mri_synthseg `--vol` soft volumes in mm³), `<stem>_synthseg.json`, and the GM, WM and
  CSF probability maps `<stem>_synthseg_gm/_wm/_csf.nii.gz` (float32 on the label grid;
  the grouping is in `exes/synthseg/README.md`). View shows a map over the input. Label
  edits do not change the maps.
- **Volumes** — a viewer tab after a run. It charts each structure's
  head-size-adjusted volume against age over the chosen reference's percentile bands, with a
  table below (`src/volume-report.js`, a port of the neurocontainers SynthSeg recipe's
  `brainquant.py` in `@neurodesk/synthseg/brainquant`). Each reference's norms come from
  `manifest.norms`, keyed `<cohort>-<mode>` (`ixi-fast`, `ixi-normal`, `ahead-fast`,
  `ahead-normal`), commit-pinned neurocontainers URLs,
  each fetched once when first needed and checked against its SHA-256. The data version
  is the first 12 characters of the source commit, shown above the charts and saved with
  the reference id, URL, checksum, Reference choice and reason in the JSON report. Without them the labels and the CSV still work and the view
  says why. Research use only.
- **Edit** — corrects the labels in the viewer with the shared mask editor. Download then
  saves the edited labels (uint8, same name and grid); the JSON report keeps the pipeline's.
  An input off SynthSeg's 1 mm grid is shown resampled to that grid while editing.

## Automation limits

`automation.json` declares the browser's limit under
`operations.segment.limits.browser.inputs.image`. Desktop `apps_validate` and
`apps_run` read the NIfTI header before starting a run. They derive SynthSeg's
resampled, RAS-aligned grid and pad each axis to a multiple of 32, at least 128.
The current GPU graph needs 288 bytes per padded voxel in its largest activation
buffer. Its validated cap remains 2,147,483,647 bytes (7,456,540 padded voxels).

The 192×256×256 case therefore fails preflight with the required buffer size and
the native-engine alternative. A 96×128×128 source with 2 mm spacing reaches the
same limit after resampling; compressed file size and source voxel count cannot
predict this limit. The check uses the existing preprocessing rule: absolute
`pixdim` outside 0.95–1.05 triggers resampling using affine column lengths. It
preserves the runtime's numeric-spacing treatment of spatial units.

Uncompressed reads need only the 352-byte header. Compressed reads stop once that
header is available and accept at most 1 MiB of compressed prefix. This preflight
does not validate voxel data or guarantee that a particular adapter has enough
memory. Runtime adapter checks still apply. DICOM geometry is unavailable until
conversion, so its check remains deferred to that runtime guard. The native
engine is exempt from this browser limit.

The interactive browser checks the adapter's buffer limits before loading the
model, crops oversized scans if enabled, and offers downsampling if needed.
The desktop's header-only automation preflight remains conservative: it cannot
estimate a robust FOV without reading intensities and retains the 1 mm limit.
Downsampling the source file alone still does not reduce SynthSeg's usual 1 mm
tensor. The interactive fallback changes the processing grid itself, using the
same Rust interpolation and antialiasing code as the 1 mm path.

## Develop

```sh
pnpm --filter synthseg dev      # SYNTHSEG_ASSET_DIR=<dir with synthseg-2.0.onnx> to serve the model locally
pnpm --filter synthseg test
pnpm --filter synthseg lint
pnpm --filter synthseg build
pnpm --filter synthseg test:e2e # real model on SwiftShader WebGPU; downloads the 53 MB weights
```

The model is fetched from Hugging Face and cached (Cache API) after a SHA-256
check against `@neurodesk/synthseg/manifest` (`packages/synthseg/model.manifest.json`);
it is never bundled.

## Validation

`pnpm --filter synthseg test:e2e` always runs the real model on the small fixture, in both modes,
and gates the labels against FreeSurfer's (mismatch ≤ 5e-6). It needs no GPU: Chromium's software
WebGPU adapter (SwiftShader) is enough, at a few minutes per mode.

`NEURODESK_HARDWARE_GPU=1 SYNTHSEG_ASSET_DIR=../../exes/synthseg/models SYNTHSEG_REFERENCE_DIR=~/src/synthseg-references pnpm --filter synthseg test:e2e`
adds both benchmark volumes on the real GPU (SwiftShader cannot hold their buffers) and
gates them like the native CLI (mismatch ≤ 2e-6, identical geometry). The last run is in
`validation/report.json`: 0–1 of 5.6 M voxels differ from FreeSurfer, 6–10 s per volume on an
M4 Pro.

## Standalone

The native CLI is `exes/synthseg` in this repository.
