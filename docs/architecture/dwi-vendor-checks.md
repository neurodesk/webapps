# DWI vendor checks

The [design](dwi-microstructure-design.md#data) asks each DWI app to run on the files and sidecars of other scanner vendors. These checks have no numeric gate. Each section records the input facts and the result of each app: [Philips](#philips) ([#419](https://github.com/neurodesk/webapps/issues/419)) and [GE](#ge) ([#420](https://github.com/neurodesk/webapps/issues/420)).

PR [#596](https://github.com/neurodesk/webapps/pull/596) (open) adds `docs/quality/dwi-vendor-checks-2026-10.md`, a scripted check of the same Philips series and of GE ds006837. It runs the browser checks on a 64×64×10 slab. The sections below add full-volume browser runs, dwicorrect with the reverse b0, dwi2trx and a b-vector check. Where both reports measure the same item, the results agree. Merge the two reports when both are on `main`.

Philips report snapshot: [ee2463de](https://github.com/gdevenyi/webapps/commit/ee2463de87c02eb28bef953c9e56beb6ab864e73), 24 October 2026. The GE checks ran on the same day. The n4 command-line rows of both sections ran after [#595](https://github.com/neurodesk/webapps/pull/595) merged.

Method: the production build of each app in headless Chromium (Playwright 1.64.0), driven through its interface or its automation contract with the BIDS files as given. Command-line results cover the runs listed below. Host: Intel Core Ultra 200V with Arc 130V/140V (xe, Mesa 26.2.4 Vulkan). Times are wall times on that host, not benchmarks.

## Philips

Data: OpenNeuro [ds007522](https://openneuro.org/datasets/ds007522) v2.0.1 (CC0), `sub-HML0001/ses-01`: `dwi/sub-HML0001_ses-01_dwi` and `fmap/sub-HML0001_ses-01_dir-PA_epi`. Philips Ingenia Elition X, 3 T, software 5.7.1, dcm2niix v1.0.20220720 ([#419](https://github.com/neurodesk/webapps/issues/419)).

### Input facts

| Item | Value |
|---|---|
| Grid | 128×128×69×136, 1.8125×1.8125×2 mm, int16, LAS, qform = sform (code 1), 5.2° oblique in plane |
| Scaling | `scl_slope` 39.0752, `scl_inter` 0 (`UsePhilipsFloatNotDisplayScaling` 1, `PhilipsScaleSlope` 0.0255917) |
| Shells | 12×b0, 12×b500, 48×b1000, 64×b2000 |
| b0 encoding | one volume b=0; 11 volumes b=1 with unit, non-zero b-vectors (volumes 2–8 and 133–136) |
| `PhaseEncodingDirection` | DWI `j`; reverse b0 `j-` |
| `SliceEncodingDirection` | absent; `dim_info` gives slice = k |
| `TotalReadoutTime` | DWI 0.0332897 s; reverse b0 0.0332836 s |
| Reverse b0 | 8 volumes (b=0 and 7×b=1), `IntendedFor` the DWI |
| b-vector convention | FSL, image axes. MRtrix `dwigradcheck` (MindGrab mask) selects the table as given: no flip, no permutation. Mean length 80.5 (79.4 for the same table in the image basis) against 44.3 for the best flipped table |

All apps treat the b=1 volumes as b0 (threshold 50 s/mm²). All apps apply `scl_slope`. In the MindGrab mask of the N4 run, the median of the first b0 in the output, divided by the scaled input, is 1.003–1.010 for degibbs, dwidenoise, n4 and dwicorrect.

### Results

| App | Browser | Command line |
|---|---|---|
| degibbs | Pass, 101 s. Slice axes 1 and 2: the default when `SliceEncodingDirection` is absent. The default agrees with `dim_info` (slice = k). | Pass, 285 s. Decompressed NIfTI identical to the browser output. |
| dwidenoise | Pass, 14 s. 12 b0 and 124 weighted volumes found. | Pass, 8 s on 6 threads. 12 b0 and 124 weighted volumes found. Decompressed NIfTI and sidecar identical to the browser output. |
| n4 | Pass, 34 s. Field fitted on the mean of 12 b0, MindGrab mask 206570 voxels, field 0.73–1.27 in the mask (1st–99th percentile). | Pass, 47 s ([#595](https://github.com/neurodesk/webapps/pull/595), run after it merged). Mask 206569 voxels (CPU MindGrab) against 206570 (WebGPU). In the voxels of both masks, the field and the first b0 agree with the browser output to 1.3 × 10⁻⁶ (one near-uniform factor). Field 0.73–1.27. bval, bvec and sidecar identical. |
| noddi | Pass, 351 s. 10 maps downloaded. The mask is the 11th download, which does not start in this driver (see Notes). Median FA 0.150, ICVF 0.479, ODI 0.451 in the mask. Midline corpus callosum V1: mean \|x\| 0.81. | Pass, 296 s on 6 threads. Mask 206569 voxels (CPU MindGrab) against 206570 (WebGPU). FA, MD and ODI differ in 7 voxels and ICVF in 6. All are voxels where the two masks disagree (7 voxels; browser mask from the N4 run, same WebGPU MindGrab, same count). FA is above 1 in 399 voxels (maximum 1.225): the WLS fit allows negative eigenvalues. |
| dwicorrect (extra) | Pass, 82 s. The reverse b0 and its sidecar are accepted. 8 outlier slices replaced. Field −92 to 64 Hz (1st–99th percentile) in the mask. b-vectors rotated by up to 1.07°. The field sign is correct: unwarping AP by +u and PA by −u raises their correlation in the mask from 0.643 to 0.694 (0.548 with the opposite sign). | No command line. |
| dwi2trx (extra) | Tensor fit passes, 21 s. Tracking fails: `Streamline tracking failed: Failed to execute 'mapAsync' on 'GPUBuffer': [Device] is lost.` | Tensor fit passes, 39 s. FA identical to the browser except 4 mask-edge voxels. No tracking in the command line. |

All outputs keep the input grid and affine. Gradient files are byte-identical to the input (dwicorrect writes rotated b-vectors). Output sidecars keep `PhaseEncodingDirection` and `TotalReadoutTime`.

### Defects

- dwi2trx tracking loses the WebGPU device: [#598](https://github.com/neurodesk/webapps/issues/598). The defect is not specific to Philips: the Siemens ds005134 sub-01 series fails in the same way, and the pinned example tracks. The kernel reports a timed-out GPU job.
- No Philips-specific defect was found. This check made no code change.

### Notes

- NiiVue logs `Voxels not aligned with world space: 5.18 degrees from plumb` for each oblique volume. This is not a defect.
- In this headless Chromium, the 11th scripted download from one page does not start. A driver that clicks Download on each row of the 11-row NODDI result list gets no 11th file; in reverse order the mask downloads and the FA does not. The dwi2trx example shows the same limit at its 11th artifact. The apps are correct; a test must download at most 10 files from one page.

## GE

Data: OpenNeuro [ds006837](https://openneuro.org/datasets/ds006837) v1.0.1 (CC0), `sub-15464`: two acquisitions of the same subject, each with a reverse b0. `dwi/sub-15464_acq-hb_dwi` with `fmap/sub-15464_acq-hb_dir-j_epi`, and `dwi/sub-15464_acq-muse_dwi` with `fmap/sub-15464_acq-muse_dir-j_epi`. GE Discovery MR750, 3 T, software `30\LX\SIGNA_LX1.MR30.1_R01_2322.c`, dcm2niix v1.0.20230411 ([#420](https://github.com/neurodesk/webapps/issues/420)). The DWI files have the SHA-256 that #596's `validation/dwi-vendors/sources.json` pins. The reverse b0 files are not in that manifest. Their S3 version IDs and SHA-256 are:

| File | S3 `versionId` | SHA-256 |
|---|---|---|
| `fmap/sub-15464_acq-hb_dir-j_epi.nii.gz` | `YGhGcpP_Y_d8pZiDY3dti5762dQ06azi` | `7c65ed87055b49d00e95278265b8380d405c7e321f000d318ff6e55108b03a7c` |
| `fmap/sub-15464_acq-hb_dir-j_epi.json` | `GVdMipv64ddotD1dSqflAvvPiFXaqwwH` | `a91246e3178060690302c8857bcfc29927ff8a673f0cb3d4956644d317ba5172` |
| `fmap/sub-15464_acq-muse_dir-j_epi.nii.gz` | `c4T9TMXDq6gcocsVuzIJ2KuOOQAAWFZ0` | `4706a80558267ed066ce342bd3cedba906d90ed5c463296b9c4ac6183c844db7` |
| `fmap/sub-15464_acq-muse_dir-j_epi.json` | `7lc.xDG1ji7wI7xOcR_rkLiDxaVNz6Z.` | `87e2f9c2a5be43488ba775ca79a5441f3889c2cb416077bcb6dcd5c733ac0c40` |

### Input facts

| Item | HB | MUSE |
|---|---|---|
| Sequence | `epi2`, multiband 2, in-plane acceleration 2 | `epi2muse` (multi-shot), acquisition matrix 144 in PE, reconstructed to 256 |
| Grid | 128×128×64×121, 1.7188×1.7188×1.7 mm, int16, LAS, qform = sform (code 1), 5.4° oblique | 256×256×28×121, 0.8594×0.8594×1.7 mm, int16, LAS, qform = sform (code 1), 3–5° oblique |
| Coverage | whole brain | 47.6 mm slab, z −68 to −7 mm (no corpus callosum) |
| Scaling | `scl_slope` 1, `scl_inter` 0 | `scl_slope` 1, `scl_inter` 0 |
| Shells | 10×b0, 8×b800, 32×b1500, 71×b2500 | the same table |
| b0 encoding | b=0 with zero b-vectors (volumes 1–3, 19, 34, 49, 64, 79, 94, 109) | the same |
| `PhaseEncodingDirection` | DWI `j-`; reverse b0 `j` | DWI `j-`; reverse b0 `j` |
| `SliceEncodingDirection`, `PartialFourier` | absent; `dim_info` gives slice = k | absent; `dim_info` gives slice = k |
| `TotalReadoutTime` | 0.04788 s, DWI and reverse b0 | 0.036036 s, DWI and reverse b0 |
| Reverse b0 | 7 volumes, no bval or bvec file, same grid and affine as the DWI, `IntendedFor` the DWI | the same |
| b-vector convention | FSL, image axes. `dwigradcheck` (MRtrix 3.0.8, MindGrab mask) selects the table as given: no flip, no permutation. Mean length 64.0 (63.1 for the same table in the image basis) against 38.2 for the best flipped table | as given: mean length 46.0 (45.8 in the image basis) against 33.5 for the best flipped table |

The two acquisitions have byte-identical bval and bvec files. All apps find 10 b0 volumes (threshold 50 s/mm²). In the MindGrab mask of the N4 run, the median of the first b0 in the output, divided by the input, is 0.996–1.006 (HB) and 1.000–1.020 (MUSE) for degibbs, dwidenoise, n4 and dwicorrect.

### Results

| App | HB | MUSE |
|---|---|---|
| degibbs, browser | Pass, 83 s. Slice axes 1 and 2 (the default; agrees with `dim_info`). | Pass, 143 s. |
| degibbs, command line | Pass, 234 s. Decompressed NIfTI, bval, bvec and sidecar identical to the browser output. | Pass, 414 s. Identical to the browser output. |
| dwidenoise, browser | Pass, 20 s. Groups of 10 b0 and 111 weighted volumes. | Pass, 32 s. The same groups. |
| dwidenoise, command line | Pass, 10 s on 6 threads. Decompressed NIfTI, bval, bvec and sidecar identical to the browser output. | Pass, 19 s. Identical to the browser output. |
| n4, browser | Pass, 41 s. MindGrab mask 243582 voxels, field 0.71–1.50 in the mask (1st–99th percentile). | Pass, 62 s. Mask 465974 voxels, field 0.74–1.56. |
| n4, command line | Pass, 52 s ([#595](https://github.com/neurodesk/webapps/pull/595)). Mask 243577 voxels (CPU MindGrab) against 243582 (WebGPU). In the voxels of both masks, the field and the first b0 agree with the browser output to 1.1 × 10⁻⁶ (one near-uniform factor). Field 0.71–1.50. bval, bvec and sidecar identical. | Pass, 66 s. Mask 465953 against 465974. Field and first b0 agree to 1.2 × 10⁻⁶. Field 0.74–1.56. bval, bvec and sidecar identical. |
| noddi, browser | Pass, 288 s. 10 maps downloaded (the 11th, the mask, does not start in this driver; see the Philips notes). Median FA 0.432, ICVF 0.506, ODI 0.390 in the mask. Midline corpus callosum V1: mean \|x\| 0.74. FA is above 1 in 3227 voxels (1.32 %, maximum 1.2247): [#600](https://github.com/neurodesk/webapps/issues/600). | Pass, 520 s. Median FA 0.366, ICVF 0.505, ODI 0.390. FA is above 1 in 12357 voxels (2.65 %): #600. |
| noddi, command line | Pass, 249 s on 6 threads. Mask 243577 voxels (CPU MindGrab) against 243582 (WebGPU). FA, MD, ICVF and ODI differ in 7 voxels, all where the two masks disagree. | Pass, 431 s. Mask 465953 against 465974. The maps differ in 21 voxels, all where the masks disagree. |
| dwicorrect (extra), browser | Pass, 79 s. The reverse b0 without bval and bvec is accepted. 15 outlier slices replaced. Field −17 to 32 Hz (1st–99th percentile) in the mask. b-vectors rotated by up to 0.50°. The field sign is correct for a `j-` series: unwarping as the field sidecar documents raises the correlation of the two mean b0 images in the mask from 0.555 to 0.751 (0.448 with the opposite sign). | Pass, 130 s. 4 outlier slices replaced. Field −54 to 152 Hz. b-vectors rotated by up to 1.23°. Correlation 0.472 to 0.649 (0.344 with the opposite sign). |
| dwi2trx (extra), browser | Tensor fit passes, 24 s. Tracking fails: `Streamline tracking failed: Failed to execute 'mapAsync' on 'GPUBuffer': [Device] is lost.` (#598). | Tensor fit passes, 33 s. Tracking fails in the same way (#598). |
| dwi2trx (extra), command line | Tensor fit passes, 40 s. FA differs from the browser in 3 voxels; 2 are outside the CPU mask. | Tensor fit passes, 48 s. FA differs in 19 voxels, all outside the CPU mask. |

All outputs keep the input grid and affine, and all values are finite. Gradient files are byte-identical to the input (dwicorrect writes rotated b-vectors). Output sidecars keep `PhaseEncodingDirection` `j-` and `TotalReadoutTime`.

PR #596 ran NODDI, degibbs, dwidenoise and N4 on a 64×64×10 slab of both acquisitions. It reports full-volume MindGrab masks of 243577 (HB) and 465953 (MUSE) voxels. These are the masks of the CPU command line above.

### Defects

- The NODDI WLS tensor fit writes FA above 1 in 1.3 % (HB) and 2.7 % (MUSE) of the brain mask, against 0.19 % on the Philips series: [#600](https://github.com/neurodesk/webapps/issues/600). These are low-signal voxels (median S0 0.10–0.17 of the brain median; RD < 0 in 81–82 %). The tensor fit uses the b0 volumes and the shells up to b = 1200 s/mm². On this GE table that is 10 b0 and 8 directions at b = 800, two more than the minimum of six. On the Philips table it is 12 b0 and 60 directions. The defect is not specific to GE, but a table with few low-b directions makes it more frequent. NODDI's niimath dtifit option (the same 18 volumes) and DWI2TRX (all 121 volumes) write no FA above 1: they set FA to 0 for a negative eigenvalue (14536 voxels on HB, 35108 on MUSE, with the NODDI option).
- dwi2trx tracking loses the WebGPU device, as on Philips and Siemens data: [#598](https://github.com/neurodesk/webapps/issues/598).
- No other GE-specific defect was found. This check made no code change.

### Notes

- The GE bvec files use the FSL image-axis convention as dcm2niix writes it. No app needs a flip.
- The MUSE series has a large in-plane matrix and few slices. Each browser run takes 1.4–1.8 times as long as on HB.
