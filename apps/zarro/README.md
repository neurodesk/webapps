# ZARRo

ZARRo streams multiscale microscopy and medical-imaging volumes from
public object storage directly into NiiVue. The browser fetches only the Zarr
chunks needed for the current field of view; it does not download or upload the
complete dataset.

## Features

- The source menu keeps DANDI Archive search and direct OME-Zarr URLs as
  separate workflows.
- Public OME-Zarr assets can be searched by path directly from any Dandiset and
  selected without copying S3 identifiers by hand. The browser defaults to
  dandiset `000108`, version `draft`.
- Matching DANDI assets are grouped as subject, sample session, stain, and
  numerically ordered chunks. A complete stain group can be added in one click,
  while its individual chunks remain available for selective loading.
- Custom OME-Zarr v2 and v3 stores can be opened from `https://`, `http://`, or
  `s3://` store-root URLs when the host permits browser CORS requests.
- Multiple stores can be added to one viewer. ZARRo composes them on a shared
  voxel grid using their OME-NGFF translation coordinates and preserves the
  resulting physical world origin in the rendered volume and NIfTI export.
- Zoom selections are applied explicitly, avoiding expensive pyramid replanning
  while the slider is still moving; pan retains coarser context automatically.
- The Zarr level menu can keep zoom-adaptive detail on Auto or lock the visible
  field of view to an explicit pyramid level.
- Multiplanar, single-slice, and cropped 3D rendering layouts are available.
- Window level/width and a synchronized dual-thumb visible min/max control,
  colour maps, physical scale bars, crosshairs, and distance measurements are
  handled in the browser.
- The current field of view can be exported as NIfTI.
- Share links reopen the selected store or translated store collection and
  restore layout, camera, crosshair, pan, zoom, Zarr level, scroll zoom speed,
  contrast, colour map, and overlay visibility.

## Opening data by URL

The **Copy share link** button is the recommended way to generate a link. Store
roots use repeatable `url` parameters, so a minimal direct link also works:

```text
https://webapps.neurodesk.org/zarro/?source=custom&url=https%3A%2F%2Fdandiarchive.s3.amazonaws.com%2Fzarr%2F<zarr-id>%2F
```

Repeat `url` to open translated stores together. Optional viewer parameters are
added automatically by **Copy share link** and remain human-inspectable in the
query string.

## Development

From the repository root:

```bash
pnpm install
pnpm --filter zarro dev
pnpm --filter zarro test
pnpm --filter zarro build
pnpm --filter zarro preview
```

Open <http://127.0.0.1:5173/zarro/> for the live Vite development server.
The dev server injects the same shared green Neurodesk palette as the deployed
app. To verify the exact standalone artifact—including the Neurodesk app bar,
theme switcher, analytics adapter, and source links—run `build` followed by
`preview` and open <http://127.0.0.1:4173/zarro/>. Do not use a bare `vite`
command from the repository root; it does not select ZARRo's app configuration.

The app uses the shared `@neurodesk/webapp-components` imaging workspace and
theme tokens. OME-Zarr metadata, chunk selection, caching, and export logic stay
app-owned because they are specific to cloud-native multiscale volumes.

## Data flow

`zarrita.FetchStore` reads OME-NGFF metadata and fetches native Zarr chunks.
NiiVue's chunked-volume API requests visible viewer bricks and uploads completed
bricks to the GPU under bounded cache and residency budgets. Spatial Z/Y/X axes
are mapped to viewer X/Y/Z, and source units are converted to millimetres.
