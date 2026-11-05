---
"calcium-imaging": minor
"@neurodesk/webapp-components": minor
---

Add Calcium imaging, a browser app for two-photon calcium imaging preprocessing. It loads a multi-page or OME-TIFF movie, corrects motion rigidly or piecewise rigidly (NoRMCorre-style patches) with sub-pixel Fourier cross-correlation or phase correlation, computes mean, max and local-correlation images, detects active cells from the correlation image (users can add or remove ROIs at the cursor), extracts neuropil-corrected ΔF/F and deconvolves spikes with OASIS AR(1), all in web workers. On the DANDI 000249 example its rigid shifts equal CaImAn's for every frame given the same template, and its OASIS matches the reference implementation on test traces.

`@neurodesk/webapp-components/file-io/tiff` reads greyscale TIFF, ImageJ and OME-TIFF stacks with geotiff (refusing multi-sample and palette pages and over-budget stacks before decoding) and writes uncompressed ImageJ-compatible TIFF stacks.
