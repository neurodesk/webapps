# VesselCharter (`@neurodesk/vesselcharter`)

Pure-JavaScript 3D blood vessel morphometry, centerline graph extraction, branching analysis and optional brain/ROI vascular density. Runs identically in browser Web Workers, Node tests and the standalone command line.

## Method

Clean-room implementation written from the published papers:

1. **Bounded native-grid NIfTI decoding**: reads 3D binary masks directly into `Uint8Array` (cap 2^27 voxels), validates orthogonality and spatial units in mm, and never resamples binary masks to isotropy.
2. **Pre-conditioning**: typed-array 6-connected interior cavity fill (`fillHoles`, default `true`) and sparse 26-connected component filtering (`minComponentVoxels`, default `10`).
3. **Exact anisotropic 3D EDT**: Felzenszwalb & Huttenlocher (2012) separable squared distance transform along X, Y and Z with physical spacings.
4. **3D medial-axis thinning**: Lee, Kashyap & Chu (1994) 6-subiteration parallel thinning with the 128-entry octant Euler lookup table, 26-connected simple-point test, symmetric opposite-pair directions (`N, S, W, E, U, D`), and a 2-voxel ribbon guard during sequential Step-2 verification so 2-voxel-wide vessels never zipper to 0 voxels.
5. **Loop-safe multigraph & spur pruning**: collapses 26-connected degree >= 3 junction blobs into single logical super-nodes (EDT-weighted centroid), preserves vascular loops (first Betti number `E - V + C`), discards degenerate 1–2 voxel discretization triangles, iteratively prunes terminal spurs (`minSpurLengthMm`, default `1.0 mm`, protecting FOV-truncated ends), and merges resulting degree-2 junctions to fixpoint.
6. **Smoothing, diameters, tortuosity & branching**: endpoint- and junction-pinned chord-length-weighted Taubin (`lambda = 0.5, mu = -0.53`) smoothing clamped within half a voxel inside the foreground; subvoxel-centred inscribed-ellipsoid diameters plus sparse foreground Voronoi segment volume-equivalent diameter (`D_eq`); Distance Metric (`L / chord`) and Bullitt SOAM tortuosity; symmetric pairwise outward junction angles (plus caliber-inferred daughter angle & Murray ratio when one branch is >= 1.1x wider); diameter-stratified bins; and optional same-grid brain/ROI mask density.

## Command line

```sh
vesselcharter self-check
vesselcharter vessels.nii.gz results
vesselcharter vessels.nii.gz results --brain-mask brain_mask.nii.gz --min-spur-length-mm 1.5
```

Outputs match the web application byte for byte:

- `<name>_vesselcharter_summary.json`
- `<name>_vesselcharter_graph.json`
- `<name>_vesselcharter_segments.csv`
- `<name>_vesselcharter_junctions.csv`
- `<name>_vesselcharter_diameter_bins.csv`
- `<name>_vesselcharter_diameter.nii.gz`
- `<name>_vesselcharter_skeleton.nii.gz`
- `<name>_vesselcharter_tree.mz3`

## Validation

1. **Offline analytical 3D phantoms** (`pnpm --filter @neurodesk/vesselcharter test`): exact anisotropic EDT vs brute-force (`< 1e-12 mm`), 1- and 2-voxel thin tubes on anisotropic Lausanne spacing, oblique anisotropic cylinders, 60/90/120 deg Y-bifurcations (recovered within ~1 deg), closed torus loop (`Betti-1 = 1`), 3D helix, hollow-cavity filling, optional sphere ROI density, and CLI byte-parity.
2. **SciPy + scikit-image + Skan** (`validation/skan-reference.py`, `validation/skan-reference.json`, BSD-3-Clause) on the pinned Lausanne 3T TOF VesselBoost crop (`192 x 192 x 64`, `0.46875 x 0.46875 x 0.7 mm`, 33,894 vessel voxels):
   - Anisotropic EDT max abs diff vs `scipy.ndimage.distance_transform_edt`: **`0.0 mm`**
   - Median centerline separation vs `skimage` Lee94: **`0.0 mm`** (p90 `0.66 mm` < 1 max voxel spacing)
   - Total length: **`964.7 mm`** (smoothed) vs `skan` **`976.2 mm`** (**1.2% difference**)
3. **VesselVio** (`validation/vesselvio/compare.py`, `validation/vesselvio/results.json`, GPL-3.0 external black-box oracle only, `JacobBumgarner/VesselVio@db256edb`):
   - Mean diameter: **`1.668 mm`** vs VesselVio **`1.612 mm`** (**3.5% difference**)
   - Surface area: **`5,056 mm²`** vs VesselVio **`5,371 mm²`** (**5.9% difference**)
   - Deliberate differences: VesselCharter reports exact voxel volume (`5,213 mm³`), clamped Taubin-smoothed lengths, preserves all 35 connected components and FOV-truncated branch tips, and flags segments below `2 x max(pixdim)` as `resolution_limited`.
