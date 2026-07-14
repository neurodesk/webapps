# BrowserQC

Automated MRI quality control, **entirely in your browser** — no upload, no server. Drag in a NIfTI image (or a folder of DICOM files) and BrowserQC runs on its own: it segments the brain, shows the parcellation over your scan, and reports MRIQC-style image-quality metrics.

Live demo: `https://webapps.neurodesk.org/browserqc/`.

## How it works

Everything runs in WebAssembly + WebGPU/WebGL2 on your machine, so your images are never shared with the cloud. When an image loads (on startup and on every drag-and-drop):

1. **Conform** — the scan is resampled to the model's canonical 256³ 1 mm space ([@niivue/nv-ext-image-processing](https://www.npmjs.com/package/@niivue/nv-ext-image-processing)).
2. **Segment** — a [brainchop](https://github.com/neuroneural/brainchop) deep-learning model (`model16chan18cls`, "Subcortical + GWM") running in [TensorFlow.js](https://www.tensorflow.org/js) parcellates the brain into 17 gray/white-matter and subcortical regions.
3. **Back-project** — the labels are resliced onto the native input grid and drawn as a colour overlay on the original scan (adjust with the **Opacity** slider).
4. **Quality control** — [niimath](https://github.com/rordenlab/niimath) computes MRIQC-style anatomical image-quality metrics from the scan and its segmentation, shown in the side panel:
   - **CJV** — coefficient of joint variation (noise + intensity non-uniformity); lower is better
   - **CNR** — contrast-to-noise (no-air variant); higher is better
   - **SNR** — signal-to-noise, averaged over tissues; higher is better
   - **WM2MAX** — white-matter median ÷ P99.95 intensity
   - **EFC** — entropy focus criterion (ghosting / blur); lower is better
   - **Tissue composition** — CSF / GM / WM as % of intracranial volume and absolute volume

Rendering uses [NiiVue](https://niivue.com/); DICOM import uses [dcm2niix](https://github.com/rordenlab/dcm2niix).

> The QC is a hard-segmentation MRIQC variant: with a masked background it omits the air-noise term, so CNR is a *relative* contrast measure, not comparable to MRIQC normative values. See [src/niimath/](src/niimath/) / niimath's `--qc`.

## Develop

```bash
npm install
npm run dev      # vite dev server (http://localhost:8091)
npm run build    # typecheck + production build to dist/
npm run preview  # serve the production build
npm run test:e2e # build, then a headless-Chromium smoke of the full auto-run path
```

Requires a browser with WebGPU (recent desktop Chrome, Edge, or Safari).

The sample scan and brainchop model are fetched from the immutable Hugging Face
revision recorded in `../../models/browserqc.manifest.json`; they are not embedded
in the application bundle.

## License

**BSD-2-Clause.** niimath is vendored as local source under [src/niimath/](src/niimath/) (its `--qc` metrics and `-conform` are newer than the current npm release); this goes away once niimath republishes to npm. The brainchop tfjs inference engine is vendored under [src/brainchop/](src/brainchop/).

## Links

This live demo already provides several of the core measures used by MRIQC (with more to come).

 - [MRIQC documentation](https://mriqc.readthedocs.io/en/latest/)
 - Esteban et al. (2017) MRIQC: Advancing the automatic prediction of image quality in MRI from unseen sites. PLoS One [PMID: 28945803](https://pubmed.ncbi.nlm.nih.gov/28945803/)
