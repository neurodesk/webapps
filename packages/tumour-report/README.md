# @neurodesk/tumour-report

Native-space contrast-enhancing brain tumour segmentation and standardized anatomical
characterization for browsers and Node.js, porting
[Raidionics v1.3](https://github.com/raidionics/Raidionics) (`raidionics_seg_lib` and
`raidionics_rads_lib`, BSD-2-Clause).

## Method

`src/preprocess.js` and `src/pipeline.js` reproduce `raidionics_seg_lib` around injected
ONNX Runtime inference runners (no DOM or runtime dependency inside `src/`):

1. **Background crop:** threshold at `trunc((max - min) * 0.2)`, 6-connected hole fill,
   tight bounding box.
2. **1 mm canonical RAS resample:** linear (`order=1`) equivalent of
   `nibabel.processing.resample_to_output(..., (1, 1, 1), order=1)`.
3. **Brain mask (`MRI_Brain`):** linear resize to `128 × 128 × 144`, clip `< 0` and
   `[0, 99.5]` percentile, `zeromean_nonzero` (`ddof=1`), single full-volume ONNX pass,
   sigmoid, back-resample to native grid, threshold `0.9`. Skipped when
   `skullStripped: true` (using `data > 0` as brain mask); warns if `< 600 mL`.
4. **Tumour core (`MRI_TumorCore/t1c`):** clip & `zeromean_nonzero` on 1 mm RAS volume,
   edge-snapped `160³` patches with element-wise `max` aggregation, sigmoid, back-resample
   to native grid, threshold `0.5`, and 26-connected `brain_overlap` refinement.
5. **Native morphometry (`src/morphometry.js`):** 26-connected per-lesion table (voxel volume
   from `|det(affine₃ₓ₃)|`, physical RAS centroids, exact 3D maximum Euclidean diameter,
   IBSI Lorensen Marching Cubes physical mesh surface area/volume/sphericity, mask-supported
   automated axial bidimensional diameters) and native minimum-surface-distance multifocality
   (`>= 0.1 mL`, `>= 5 mm`; distinct from Raidionics' MNI 6-connected HD95 multifocality).
6. **MNI RADS characterization (`src/rads.js`):** brain-cropped 1 mm RAS alignment to
   `mni_icbm152_nlin_sym_09a` (`197 × 233 × 189`) via `@neurodesk/greedy` (affine NMI
   default; optional deformable NMI with lesion masking), reslicing the native-resolution
   cropped tumour mask directly onto the MNI grid, hemispheric laterality and bilateral
   midline crossing, MNI lobe and Schaefer 7/17 cortical overlap, exact 3D EDT voxel-centre
   distance and overlap across 64 BCB subcortical tracts (distinct from Raidionics' tract HD95),
   and Kommers et al. (2021) resectability for glioblastoma.

## Models and Atlases

`scripts/export_model.py` rewrites the four 3D `ConvTranspose(k=3, s=2, p=1, op=1)` nodes
in Raidionics v1.3 AGU-Net models into bit-exact symmetric-pad polyphase `2×2×2 Conv + Slice`
depth-to-space subgraphs for ONNX Runtime WebGPU and stores large weights as `float16`
(`59.88 MB` each, down from `94.05 MB`). `scripts/prepare_atlases.py` packages the
ICBM 2009a template, masks, Schaefer 7/17, NaN-cleaned resectability maps, and a single
`365 KB` bit-packed BCB tract bundle (`8.2 MB` total).

## Validation

Reference container:
`dbouget/raidionics-rads:v1.3.2-py39-cpu@sha256:ef2861258f92e66c21ded1405ec5ffa856ffda9cd9bda38ae90e07ade01946ab`
on `BEAMSTER Dataset_A_038.nii.gz` (CC BY 4.0, `512 × 512 × 250`, `1.37 × 1.37 × 1.25 mm`,
LPS, defaced skull-intact multifocal metastases).

| Comparison | Node (`@neurodesk/tumour-report`) | Reference Container | Agreement |
| --- | --- | --- | --- |
| Native tumour mask | 5,211 voxels (3 foci, 12.18 mL) | 5,211 voxels | **Dice 1.00000** (0 differing voxels) |
| Native brain mask | 525,876 voxels (1,228.7 mL) | 525,874 voxels | **Dice 1.00000** (4 differing voxels) |
| RADS on container MNI mask | Left 100%, Frontal 66.19%, Parietal 31.73%, Resect 0.8807 | Left 100%, Frontal 66.19%, Parietal 31.73%, Resect 0.8807 | **Exact match** |
| End-to-end MNI mask (Greedy affine vs ANTs SyN) | 18,224 vox; Frontal 64.10%, Parietal 34.13% | 17,339 vox; Frontal 66.19%, Parietal 31.73% | **Dice 0.90414** (lobes within 2.4 pp) |

## Command line

Portable archives (Linux x64, Windows x64, macOS Apple silicon) bundle Node.js,
`onnxruntime-node`, Greedy single-thread WebAssembly, both pinned Raidionics v1.3
ONNX models, and all MNI ICBM152 2009a atlases so they run completely offline:

```bash
tumour-report self-check
tumour-report t1c.nii.gz results --tumour-type glioblastoma
tumour-report t1c.nii.gz results --mask tumour_mask.nii.gz --no-mni
tumour-report download-models --cache-dir ./models
```

Environment variables:

- `NEURODESK_TUMOUR_REPORT_MODEL_DIR`: override the local model and atlas directory.
- `NEURODESK_OFFLINE=1`: refuse network downloads and require verified local assets.
- `ORT_DISABLE_TELEMETRY=1`: set automatically so ONNX Runtime writes nothing to `~/.cache`.

## Tests

```bash
pnpm --filter @neurodesk/tumour-report lint
pnpm --filter @neurodesk/tumour-report test
unshare -rn sh -c 'ip link set lo up && pnpm --filter @neurodesk/tumour-report test'
```
