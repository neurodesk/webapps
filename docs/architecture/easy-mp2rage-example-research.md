# Real brain example for Easy MP2RAGE

Reviewed 2026-09-18. Use the original MP2RAGE authors' demonstration images from [JosePMarques/MP2RAGE-related-scripts, commit `7a4ba42864c399354d21e84fc11e3d8911428871`](https://github.com/JosePMarques/MP2RAGE-related-scripts/tree/7a4ba42864c399354d21e84fc11e3d8911428871/data). This is the strongest examined candidate because the authors demonstrate both background suppression and B1-corrected T1 estimation with these images. It includes a measured SA2RAGE B1 map; a fabricated uniform B1 map is unnecessary.

## Files and acquisition parameters

Download from `https://raw.githubusercontent.com/JosePMarques/MP2RAGE-related-scripts/7a4ba42864c399354d21e84fc11e3d8911428871/data/`:

| File | Bytes | SHA-256 |
| --- | ---: | --- |
| `MP2RAGE_UNI.nii` | 13,716,912 | `40b65d7bf05cca0527f8934e33525dc32ad6f9aef43d3bda72b903054a9479a1` |
| `MP2RAGE_INV1.nii` | 13,716,912 | `24000f6ae665e898837dff5d52557e63ee5143d498333fbab9fdbcc9cd907333` |
| `MP2RAGE_INV2.nii` | 13,716,912 | `8b2318ed8534b41ed4701ad349153456b1648ca59ea0b6f7452216a7b9fb2532` |
| `Sa2RAGE_B1map.nii.gz` | 8,712,070 | `106db9fe67604236bd68d3fa1b008aa2373604b77b738daf56f6e86c3eaf74e4` |

[DemoForR1Correction.m](https://github.com/JosePMarques/MP2RAGE-related-scripts/blob/7a4ba42864c399354d21e84fc11e3d8911428871/DemoForR1Correction.m) supplies these MP2RAGE parameters explicitly:

| Parameter | Value |
| --- | --- |
| Field strength | 7 T |
| Sequence TR | 6 s |
| GRE readout TR | 0.0067 s |
| Inversion times | 0.8 s, 2.7 s |
| Readout counts before/after centre (`NZslices`) | 35, 72 |
| Flip angles | 4°, 5° |
| Inversion efficiency used by the demo | 0.96 |

That script loads the B1 map together with UNI. Its alternative direct-relative-B1 example divides the stored B1 values by **1000** before calling `T1B1correctpackageTFL`; a relative value of one represents the nominal flip angle. Preserve that documented conversion when preparing the example. Do not claim raw SA2RAGE ratio data are included: `Sa2RAGE_B1map.nii.gz` is an already estimated B1 map. The script also offers iterative SA2RAGE correction, but that is a separate processing choice.

[DemoRemoveBackgroundNoise.m](https://github.com/JosePMarques/MP2RAGE-related-scripts/blob/7a4ba42864c399354d21e84fc11e3d8911428871/DemoRemoveBackgroundNoise.m) uses the same UNI, INV1 and INV2 files together for robust combination. It gives 10 as an example regularization factor after interactive selection, not a universal optimal value.

## Inspection of downloaded files

All four images were downloaded from the pinned URLs above and inspected with nibabel. Each has dimensions **218 × 220 × 143**, voxel spacing approximately **1.04545 × 1.04545 × 0.99990 mm**, and signed 16-bit stored values. Their effective voxel-to-world affines match:

```text
 0         0         0.999901   -69.289345
-1.045455  0         0          142.131775
 0         1.045455  0         -146.276047
 0         0         0            1
```

UNI and inversion files use an active qform (`qform_code=1`) and inactive identity sform (`sform_code=0`). The B1 file has both forms active, with its sform equal to the others' qform. Comparing the inactive sform would incorrectly suggest misalignment. The authors' correction script assumes a coregistered, interpolated B1 map, and these file headers agree with that condition. No independent session identifier or acquisition date is provided, so describe them as the authors' matching demonstration images, without inventing a session identifier.

Central orthogonal UNI slices were inspected and show anatomical brain tissue, scalp and neck. The source does not document defacing or participant demographics; do not label this example defaced, skull-stripped, healthy-adult, or otherwise assign undocumented properties. The B1 stored range is 0–2440 (relative 0–2.44 after conversion). UNI range is 0–4089. These are observed file statistics, not protocol assumptions.

The repository distributes a [GPL version 3 license](https://github.com/JosePMarques/MP2RAGE-related-scripts/blob/7a4ba42864c399354d21e84fc11e3d8911428871/License.txt), without a separate data license in the inspected tree. Preserve this license and source attribution with any hosted copy; do not relabel the files CC0. Keep large files in the Neurodesk Hugging Face dataset, with a pinned revision and checksums. Document any compression, B1 scaling, reorientation or resampling applied to create the hosted example.

## Alternatives examined

- [OpenNeuro ds004611, pinned tree `ada628c7e284eb541face6a64bf3e3b5633a1f10`](https://github.com/OpenNeuroDatasets/ds004611/tree/ada628c7e284eb541face6a64bf3e3b5633a1f10) contains same-subject UNIT1, INV1 and INV2. Its [dataset description](https://github.com/OpenNeuroDatasets/ds004611/blob/ada628c7e284eb541face6a64bf3e3b5633a1f10/dataset_description.json) declares CC0 and DOI `10.18112/openneuro.ds004611.v1.0.2`; its [README](https://github.com/OpenNeuroDatasets/ds004611/blob/ada628c7e284eb541face6a64bf3e3b5633a1f10/README) describes defaced developmental scans. This is a viable denoising example, but no B1 or SA2RAGE files were found in its complete tree. The inspected subject's JSON sidecars supply TR 5 s, TI 0.7/2.5 s and flip angles 4/5°, but not an explicit GRE readout TR. It does not support the app's B1-correction example as completely as the Marques dataset.
- [OpenNeuro ds007418, pinned tree `f91513cf9ebab2d5bd391b6e0a3843366dcab676`](https://github.com/OpenNeuroDatasets/ds007418/tree/f91513cf9ebab2d5bd391b6e0a3843366dcab676) contains 7 T T1w volumes alongside multi-echo GRE data. Its complete tree has no separate MP2RAGE inversion images or B1 map; reject it for this example.
- [benoitberanger/mp2rage, pinned tree `73e481a3c51001295f05c4d413f312ecc5dc733d`](https://github.com/benoitberanger/mp2rage/tree/73e481a3c51001295f05c4d413f312ecc5dc733d/example) has screenshots and animated demonstrations under `example`, not downloadable NIfTI example volumes. It points back to the Marques implementation.
