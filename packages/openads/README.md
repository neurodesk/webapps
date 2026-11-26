# `@neurodesk/openads`

Runtime-independent acute ischemic stroke DWI/PWI processing, JHU-ICBM atlas quantification, Lundberg TreeSHAP evaluation, and StrokeView UMAP cohort analysis for Neurodesk Webapps.

Developed in collaboration with Andreia V. Faria and the Faria Lab (Johns Hopkins University, [StrokeFAIR](https://strokefair.org)).

## Modules

- `@neurodesk/openads/volume` — NIfTI-1 3D/4D I/O, RAS canonical reorientation, DWI + b0 ADC calculation with 4D order swap detection, masking, padding, percentile-clip/z-score normalization, and binary morphology.
- `@neurodesk/openads/dagmnet` — 16-pass strided sliding-window inference drivers for DAGMNet DWI (ch3) and DAGMNet PWI (ch4).
- `@neurodesk/openads/ttp` — 4D PWI slice-time correction, 4D separable Gaussian filtering, baseline/Gd concentration mapping, peak detection, neighbor NaN fill, and TTP denoising.
- `@neurodesk/openads/atlases` — JHU-ICBM MNI152 1 mm (`182×218×182`) arterial, lobar, MCA-ASPECTS, pcASPECTS, BPM Type-I and ventricle LVOR/LVIR overlap, QFV vectors, core–penumbra mismatch, CSV exports, and Automatic Radiological Report formatting.
- `@neurodesk/openads/treeshap` — Exact Lundberg TreeSHAP binary forest decoder and evaluator (`models/aa-shap/*.bin`).
- `@neurodesk/openads/cohort` — StrokeView 1,861-patient UMAP projection via inverse-distance-weighted k-NN in scaled QFV space and nearest-neighbor clinical phenotype summaries.
- `@neurodesk/openads/assets` — Commit-pinned Hugging Face URLs and SHA-256 checksums (`model.manifest.json`).
