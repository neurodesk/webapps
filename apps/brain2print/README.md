# Brain2Print (web)

Turns a brain scan into a 3D-printable mesh in the browser. Load a NIfTI or
DICOM image, segment it with MindGrab (`16chan18cls`, WebGPU), build a mesh
from the segmentation with niimath, inspect it in NiiVue, and download STL or
OBJ.

WebGPU is required — there is no fallback. Without it the app says so at
startup.

## Controls

- **Input image** — NIfTI or DICOM (drag-drop supported), or the example T1
  fetched from Hugging Face at startup.
- **Segment** — runs MindGrab brain segmentation on the loaded image.
- **Mesh** — niimath builds a mesh from the segmentation; **largest component
  only**, **fill bubbles**, and **simplify %** control the result. The app
  checks that the mesh is a closed, consistently wound manifold and, since
  niimath writes vertices in world millimetres, flips the winding when the
  signed volume is negative so normals face outward regardless of the input
  affine's handedness.
- **Format / Download** — STL or OBJ, saved via NiiVue.

## Develop

```sh
pnpm --filter brain2print dev
pnpm --filter brain2print test
pnpm --filter brain2print lint
pnpm --filter brain2print build
pnpm --filter brain2print test:e2e # needs a WebGPU-capable Chromium
```

`dev` and `build` first run `scripts/copy-brainchop.mjs`, which stages
MindGrab's WebGPU assets into `public/brainchop/` (gitignored, regenerated
each run).
