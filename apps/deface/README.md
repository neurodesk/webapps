# deface

Remove facial features from a brain MRI for anonymization, **entirely in your browser** — no upload, no server. Drag in a NIfTI image (or a folder of DICOM files), pick a method, click Apply, and save the defaced result.

Live demo: deploys as a GitHub Project Page at `https://<org>.github.io/deface/`.

## How it works

All processing runs in WebAssembly + WebGPU on your machine so your images are not shared with the cloud:

- **[niimath](https://github.com/rordenlab/niimath)** does the registration-based defacing. It fits a bundled MNI template ([3dAllineate](https://afni.nimh.nih.gov/)-style affine registration, RW Cox / AFNI) to your scan and zeros the voxels over the face. Four variants combine two knobs — the registration engine and an optional **robustfov** crop of the neck/inferior slices for a tighter face mask:
  - **allineate (fast)** — the fast registration engine (Hellinger mutual information with a robust fallback), the default, ~5 s
  - **allineate (fast, robustfov)** — the fast engine after a `-robustfov` crop
  - **allineate (Hellinger)** — the exhaustive Hellinger engine (`-cost hel`): a reference-quality fit, but single-threaded in WebAssembly it can take a few minutes on a full-head scan (native niimath is ~6× faster via OpenMP threads that WASM lacks)
  - **allineate (Hellinger, robustfov)** — the Hellinger engine after a `-robustfov` crop
- **[brainchop mindgrab](https://github.com/neuroneural/brainchop)** — an edge-based AI model for omnimodal brain extraction, run entirely on the GPU. It masks out everything but the brain, so it removes the face along with the skull and scalp. Variants combine two knobs — a tight skull-strip vs. an **8mm** tissue margin around the brain, and optional **robustfov** neck/inferior-slice cropping: **mindgrab**, **mindgrab robustfov**, **mindgrab 8mm border**, and **mindgrab robustfov + 8mm**. Requires **WebGPU with `shader-f16`** (recent desktop Chrome, Edge, or Safari).
- **[NiiVue](https://niivue.com/)** renders the image.
- **[dcm2niix](https://github.com/rordenlab/dcm2niix)** converts dropped DICOM folders to NIfTI.

The core operation is a single niimath chain, e.g.:

```
niimath input -gz 0 -robustfov -deface avg152T1 avg152T1mask defaced.nii
```

All niimath I/O is uncompressed (`-gz 0`) for speed; NiiVue re-gzips when you Save.

## License

**BSD-2-Clause.** Defacing uses the BSD-2 build of niimath — the fast affine `-deface` engine, no GPL `spm_coreg`/SPM code — so the whole app is BSD-2-Clause. (The fast-deface engine is newer than the current npm release, so the built BSD artifacts are vendored as local source under [src/niimath/](src/niimath/); this goes away once niimath republishes to npm.)

## Develop

```bash
npm install      # or: bun install
npm run dev      # vite dev server (http://localhost:8091)
npm run build    # typecheck + production build to dist/
npm run preview  # serve the production build
```

Requires a browser with WebGPU (recent desktop Chrome, Edge, or Safari).
