# elastix

elastix registers a moving image to a stationary image entirely in the browser
with [`@itk-wasm/elastix`](https://github.com/InsightSoftwareConsortium/ITKElastix),
the WebAssembly build of [elastix](https://github.com/SuperElastix/elastix). The
interface follows the registration family: moving, stationary and registered
images in linked NiiVue panels, one Register action, and downloads in the output
section. It is based on ITKElastix's TypeScript demo app.

## Methods

Each preset chains elastix's default parameter maps (`defaultParameterMap`):
Rigid is translation then rigid, Affine adds affine, and Affine + B-spline adds a
B-spline deformation with the chosen final grid spacing. Advanced settings set
the number of resolutions. Elastix parameter files (`.txt` or `.toml`) replace the
preset; they run in file-name order.

Both images are cast to float32 before registration, so any pair of pixel types
registers and the result is never wrapped into an integer range. The transform
maps stationary points to moving points, as ITK and elastix define it. The
TransformParameters downloads name their predecessors, so transformix given the
last file applies every stage.

## Inputs

| Source | Reader |
| --- | --- |
| NIfTI, DICOM | dcm2niix (DICOM), then `@itk-wasm/image-io` |
| NRRD, MetaImage, MGH, MINC and other ITK formats | `@itk-wasm/image-io` |
| OME-Zarr `.ozx`, a dropped `.zarr` folder, an OME-Zarr URL | `@fideus-labs/ngff-zarr` (zip archives through `@zarrita/storage`) |
| TIFF and OME-TIFF, local or by URL | `@fideus-labs/fiff` over geotiff, by range request for a URL |

Pyramids register at the finest level of at most 2^24 voxels. A single-slice
volume becomes a 2D image; color, channel and time axes reduce to the first
scalar volume.

## Build and test

`scripts/copy-pipelines.mjs` stages the ITK-Wasm pipelines the app calls into the
ignored `public/pipelines/` before `dev` and `build`; `src/pipelines.js` points
every ITK-Wasm package there, so nothing is fetched from a CDN.

```bash
pnpm --filter elastix build
pnpm --filter elastix test
pnpm --filter elastix test:e2e
```

The browser tests register the example pair at 2 mm and the hosted 1 mm pair, a
known rigid displacement through the automation contract, and a synthetic 2D pair
with a known shift as local OME-Zarr, local OME-TIFF, a remote OME-Zarr folder
and a remote TIFF served by range request, plus a two-level pyramidal OME-TIFF.
