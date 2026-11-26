---
"@neurodesk/openads": minor
"openads": minor
"@neurodesk/registration": minor
---

Add the OpenADS + StrokeView acute stroke MRI webapp (`apps/openads`) and reusable `@neurodesk/openads` core package, integrating Faria Lab's ADSWeb and StrokeView workflows directly into the Neurodesk imaging workspace:

- **Full client-side DWI/PWI pipeline:** Supports pre-registered MNI152 lesion reporting, native DWI + b0/ADC segmentation (SynthStrip skull stripping, ANTs MNI152 affine/optional SyN registration, 16-pass DAGMNet DWI core segmentation, native-space restoration), and 4D PWI time-to-peak (TTP) + DAGMNet PWI hypoperfusion and core–penumbra mismatch quantification.
- **Radiological reporting, TreeSHAP & StrokeView cohort:** Runs all 29 OpenADS Random Forest ONNX classifiers (arterial territories, anatomical lobes, MCA ASPECTS, hydrocephalus), exact Lundberg TreeSHAP feature attributions, and interactive 1,861-patient StrokeFAIR UMAP projection with k-NN clinical phenotype summaries and CSV/report exports.
- **Pinned assets & shared engines:** Pins all 91 OpenADS/StrokeView models, atlases, SHAP forests, cohort datasets, and StrokeFAIR examples to Hugging Face (`neurodeskorg/webapps@63149f27d8461edff52e92ea18d52f69671433bb`), deduplicates `syncro-registration.wasm` via `runtime-assets/manifest.json`, and extends `@neurodesk/registration` with `registerWithArgs` and `applyTransforms` (including inverse transforms).
