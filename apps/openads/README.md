# OpenADS (web)

Acute ischemic stroke DWI core segmentation, 4D PWI hypoperfusion & core–penumbra mismatch analysis, automated radiological reporting (JHU-ICBM arterial territories, lobes, MCA-ASPECTS, pcASPECTS, hydrocephalus), exact TreeSHAP attributions, and StrokeView 1,861-patient UMAP cohort matching — all running locally in the browser.

Built in collaboration with Andreia V. Faria and the Faria Lab (Johns Hopkins University, [StrokeFAIR](https://strokefair.org)), integrating [ADSWeb / OpenADS](https://github.com/farialab/OpenADS) and [StrokeView](https://strokeview.strokefair.org/) onto the Neurodesk Webapps imaging workspace.

## Workflows

1. **Pre-registered MNI152 reporting (StrokeView mode):** Drop an MNI152 1 mm (`182×218×182`) stroke mask (with optional MNI ADC and brain mask) or select the first StrokeFAIR example for instant atlas overlap, 29 Random Forest classifiers, exact TreeSHAP attributions, and 1,861-patient StrokeView UMAP cohort matching.
2. **Full native-space DWI pipeline:** Drop raw DWI + b0 (or DWI + ADC, NIfTI or DICOM). Computes ADC if needed, strips the skull with `@neurodesk/synthstrip`, registers to MNI152 with `@neurodesk/registration` (ANTs WASM affine, optional SyN), segments acute core with DAGMNet DWI ONNX, restores the mask to native space, and generates the full radiological report and cohort placement.
3. **Full DWI + 4D PWI pipeline:** Add a 4D PWI series (and optional BIDS JSON sidecar) to compute slice-time-corrected TTP maps, coregister to DWI/MNI152, segment hypoperfusion with DAGMNet PWI ONNX, and measure core–penumbra mismatch.

## Development

```bash
pnpm --filter openads dev
pnpm --filter openads test
pnpm --filter openads lint
pnpm --filter openads build
pnpm --filter openads test:e2e
```
