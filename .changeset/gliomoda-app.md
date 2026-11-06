---
"gliomoda": minor
---

Add GlioMODA, a new app that segments adult gliomas on skull-stripped MRI registered to the BraTS/SRI24 atlas grid. It takes any of GlioMODA's 11 sequence combinations of T1c, FLAIR, T1 and T2 (plus the ResEncL model for all four), recognises the sequences from BraTS, BraTS Toolkit, UPENN-GBM and BIDS file names, and runs the GlioMODA v1.0.2 networks with ONNX Runtime Web on WebGPU or the CPU, repeating nnU-Net 2.5.2's normalisation, mirrored sliding-window prediction and region labels. It downloads the BraTS label map (necrotic core, oedema, enhancing tumour) and a volume table. On the UPENN-GBM example its labels match the Neurocontainers GlioMODA 0.0.4 container's for every model.
