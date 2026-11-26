# Brain Tumour Report

Browser-native contrast-enhancing brain tumour segmentation (Raidionics v1.3 `MRI_Brain` and `MRI_TumorCore/t1c`) and standardized native-space morphometry + MNI ICBM152 2009a RADS anatomical reporting.

## Capabilities

- **Single-scan native-space input:** Post-contrast T1-weighted MRI (NIfTI or DICOM series), plus an optional native-space binary tumour mask bypass and an explicit skull-stripped toggle.
- **Native-space morphometry:** 26-connected per-lesion table (volumes, clickable physical RAS centroids, 3D diameter, surface area, IBSI sphericity, automated axial bidimensional diameters and `≥ 10 × 10 mm` flag, multifocality).
- **MNI RADS anatomical report:** Brain-cropped 1 mm RAS alignment to MNI ICBM152 2009a via `@neurodesk/greedy` (affine NMI default; optional lesion-masked deformable SVF), hemispheric laterality, MNI lobe and Schaefer 7/17 overlap, exact 3D Euclidean distance and overlap across 64 BCB subcortical white-matter tracts, and the Kommers et al. (2021) resectability index for glioblastoma.

## Development & checks

```bash
pnpm --filter @neurodesk/tumour-report test
pnpm --filter tumour-report test
pnpm --filter tumour-report build
pnpm --filter tumour-report test:e2e
```
