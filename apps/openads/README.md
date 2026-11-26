# OpenADS (web)

Acute ischemic stroke DWI core segmentation, 4D PWI hypoperfusion & core–penumbra mismatch analysis, automated radiological reporting (JHU-ICBM arterial territories, lobes, MCA-ASPECTS, pcASPECTS, hydrocephalus), exact TreeSHAP attributions, and StrokeView 1,861-patient UMAP cohort matching — all running locally in the browser.

Built in collaboration with Andreia V. Faria and the Faria Lab (Johns Hopkins University, [StrokeFAIR](https://strokefair.org)), integrating [ADSWeb / OpenADS](https://github.com/farialab/OpenADS) and [StrokeView](https://strokeview.strokefair.org/) onto the Neurodesk Webapps imaging workspace.

## Workflows

1. **Pre-registered MNI152 reporting (StrokeView mode):** Drop an MNI152 1 mm (`182×218×182`) stroke mask (with optional MNI ADC and brain mask) or select the first StrokeFAIR example for instant atlas overlap, 29 Random Forest classifiers, exact TreeSHAP attributions, and 1,861-patient StrokeView UMAP cohort matching.
2. **Full native-space DWI pipeline:** Drop raw DWI + b0 (or DWI + ADC, NIfTI or DICOM). Computes ADC if needed, strips the skull with `@neurodesk/synthstrip`, registers to MNI152 with `@neurodesk/registration` (ANTs WASM affine, optional SyN), segments acute core with DAGMNet DWI ONNX, restores the mask to native space, and generates the full radiological report and cohort placement.
3. **Full DWI + 4D PWI pipeline:** Add a 4D PWI series (and optional BIDS JSON sidecar) to compute slice-time-corrected TTP maps, coregister to DWI/MNI152, segment hypoperfusion with DAGMNet PWI ONNX, and measure core–penumbra mismatch.

## Upstream Parity & Validation Benchmark (`sub-02e8eb42`)

To stay lightweight for client-side browser execution, OpenADS Web adopts ADSWeb's browser DWI variant (zero-filled `Prob_IS` channel 3 and 1st–99th percentile + z-score normalization, avoiding ~48 MB of extra normal-population templates) and defaults to fast ANTs MNI152 affine registration (with optional ANTs SyN deformable warp for upstream `MNI152 affsyn` reporting).

Measured end-to-end on upstream Faria Lab example `sub-02e8eb42` against the upstream manual masks (`farialab/OpenADS/assets/examples/pwi/sub-02e8eb42/`):

| Stage | Reference mask | Dice | Precision | Recall | Predicted / Reference volume |
|---|---|---:|---:|---:|---:|
| DWI core (native space) | `02e8eb42_stroke.nii.gz` | **0.8836** | 0.9755 | 0.8074 | 94.50 mL / 114.17 mL |
| DWI core (MNI152 affine) | `sub-02e8eb42_space-MNI152_desc-lesion_mask.nii.gz` | **0.8029** | 0.6967 | 0.9473 | 141.39 mL / 103.99 mL |
| PWI hypoperfusion (native PWI, JS `symClassic` prior) | `02e8eb42_HP_manual2.nii.gz` | **0.5191** | 0.9980 | 0.3507 | 136.83 mL (MNI) |
| PWI hypoperfusion (native PWI, upstream `HP_symClassic`) | `02e8eb42_HP_manual2.nii.gz` | **0.5282** | 0.9993 | 0.3589 | 139.93 mL (MNI) |

## Attribution, Citations & License

© The Johns Hopkins University. Derived from [OpenADS (ADSWeb)](https://github.com/farialab/OpenADS) and [StrokeView / StrokeFAIR](https://strokefair.org) by **Andreia V. Faria, Chin-Fu Liu, and the Faria Lab** (Johns Hopkins University School of Medicine).

Licensed under the **JHU Non-Profit Research Software License Agreement** — see [LICENSE](./LICENSE) and [NOTICE](./NOTICE) for full terms and required citations. Non-commercial academic and non-profit research use only; not a clinical diagnostic tool.

## Development

```bash
pnpm --filter openads dev
pnpm --filter openads test
pnpm --filter openads lint
pnpm --filter openads build
pnpm --filter openads test:e2e
```
