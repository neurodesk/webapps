# Light-sheet atlas

Registers a cleared mouse brain to the Allen Mouse Brain Common Coordinate Framework (CCFv3,
50 µm) and counts cell candidates per brain region, following BrainGlobe's
[brainreg](https://github.com/brainglobe/brainreg) and
[cellfinder](https://github.com/brainglobe/cellfinder). Everything runs in the browser.

## Pipeline

| Step | Code | Reference |
| --- | --- | --- |
| Read a TIFF stack (multi-page or one file per plane) or an OME-Zarr folder plane by plane | `@neurodesk/webapp-components/file-io/microscopy-stack` | |
| Put the stack in the atlas orientation (BrainGlobe `asr`) and average it to 50 µm voxels | `src/space.js` | brainreg's downsampled grid shape |
| Affine (NMI, `100x50x10`, from image centres) and deformable (SVF, NCC 2×2×2, `100x50x0`) registration, atlas template moving | `src/registration.js`, `@neurodesk/greedy` single-threaded WebAssembly | brainreg 1.0.16 (NiftyReg) |
| Atlas labels on the sample (nearest neighbour) and each sample voxel's atlas coordinate (linear resampling of coordinate images, as brainreg's `deformation_field_*`) | `src/registration.js` | |
| Cell candidate detection | `src/detect.js`, a port of cellfinder 1.10.1's classical detection (BSD-3-Clause) | `cellfinder.core.detect.detect.main` |
| Candidates to atlas regions; per-region counts, volumes and densities | `src/regions.js` | brainreg's `volumes.csv` |

`src/pipeline.js` runs the steps and `src/outputs.js` writes the files; `src/worker.js` runs them
in a module worker (cancel terminates the worker) and `validation/run-example.mjs` runs the
pipeline in Node with the same WebAssembly bytes. A registration-only run of an OME-Zarr image
reads its coarsest level with voxels of at most 50 µm. Runs whose registration grid is larger
than four atlases (a voxel size in the wrong unit) or whose buffers need more than 3 GB are
refused before reading. That estimate leaves out two bounded buffers: the OME-Zarr reader keeps
one decoded chunk slab of up to 512 MB, and detection may hold up to 600 MB of soma voxels in open
structures before it stops, so a run can peak at about 4.1 GB.

## Outputs

- `<name>_atlas-grid.nii.gz`: the sample on the 50 µm atlas-orientation grid (registration runs) or
  on the display grid (detection-only runs).
- `<name>_registered-atlas.nii.gz`: Allen structure ids (uint32) on that grid, as brainreg's
  `registered_atlas.tiff`.
- `<name>_candidates.csv`: each cell candidate's stack voxel (x, y, z), and when registered its
  atlas position (µm along the asr axes), structure and hemisphere.
- `<name>_candidates.nii.gz`: the candidates marked on the grid, for display.
- `<name>_regions.csv`: per structure and hemisphere: acronym, name, Allen id,
  `candidate_count`, volume in the sample (mm³, from the registered labels at 50 µm) and
  `candidates_per_mm3`. Without detection the count and density columns are empty.

Counts are of cell candidates: no classifier runs, and no count has been compared with cells
counted another way on the same brain.

## Validation

- **Detection** (`validation/cellfinder-crop-reference.json`, recorded by
  `validation/cellfinder_reference.py` with cellfinder 1.10.1 on the CPU): on the 26-plane crop
  example (5 × 2 × 2 µm, default settings) every thresholded plane and in-brain tile count is
  identical, and the 38 candidates are the same voxels (`test/examples.test.js`, `e2e/smoke.spec.js`).
- **Registration** (`validation/brainreg-reference.json`, from `validation/compare_brainreg.py`):
  against `brainreg brain/ out/ -v 50 40 40 --orientation psl --atlas allen_mouse_50um` on the
  example brain. Dice of the major divisions: whole brain 0.97, isocortex 0.96, midbrain 0.94,
  thalamus 0.93, hippocampal formation 0.93, striatum 0.92, pons 0.91, olfactory areas 0.90,
  cerebellum 0.89, hypothalamus 0.88, medulla 0.86, cortical subplate 0.81, pallidum 0.81,
  fiber tracts 0.70, ventricles 0.65. The two sample-to-atlas maps differ by a median of 94 µm
  (p90 168 µm) inside the brain, about two atlas voxels. The app's brain extends further
  caudally than brainreg's (medulla 38.0 vs 31.5 mm³), so it labels more of the cut brainstem.
  The tests hold the app's labels and region table to the recorded sha256 in Node and in Chromium.
  Dice against brainreg measures how far two registration methods agree, not accuracy.
- **Against brainreg's outputs** (`test/brainreg.test.js`; brainreg's `registered_atlas` and
  `deformation_field_*` for the example are pinned on Hugging Face in
  `validation/brainreg-reference.json`, under the Allen terms): the whole-brain Dice is at least
  0.97 and the median distance between the two maps at most 100 µm. 8,631 stack points inside
  brainreg's brain are injected as candidates (`runPipeline`'s `cells`) through the whole
  register, map and assign path: their atlas coordinates lie a median of 1.9 atlas voxels from
  brainreg's deformation field at the same voxels, 98 % get brainreg's hemisphere, and of those at
  least two voxels inside a major division (4,289 of the 8,631) 99.8 % get brainreg's division
  (the test requires a median of at most 2 voxels and 95 %). Over all 8,631 points, boundaries
  included, 90.5 % get brainreg's division (98.9 % of those at least one voxel inside; the test
  requires 85 %), and about 71 % get exactly brainreg's leaf region: counts in small regions and
  near boundaries depend on the registration method. The same stack reoriented to `ras`
  (40 × 50 × 40 µm) maps the same points to the same place.

## Deliberate divergences

- The atlas is the 50 µm CCFv3, not the 25 µm one: a 25 µm registration of a whole brain needs
  about 77 million voxels per image and a 0.9 GB warp field, beyond a browser tab. Region
  volumes and the label lookup are at 50 µm.
- Registration is Greedy, not NiftyReg, and brainreg's per-plane despeckle and pseudo-flatfield
  preprocessing is not applied; the Dice above measures the result.
- The 3D downsampling averages the source voxels each 50 µm voxel covers (area weights) instead of
  brainreg's interpolation.
- cellfinder's ResNet classifier is not included: counts are of candidates, which include
  artefacts the classifier would reject. The tiled threshold (`tiled_thresh_tile_size`) and
  centre-of-intensity options are not exposed; both are off by default in cellfinder.
- Detection needs voxels fine enough that the ball filter is at least one voxel deep and a soma
  spans two pixels; coarser stacks are refused. A crop cannot be registered to the whole-brain
  atlas, so its example runs detection only, and the whole-brain example (50 × 40 × 40 µm) runs
  registration only. No openly licensed whole brain small enough for a browser has both
  resolvable cells and a known registration, so the combined path is tested by injecting
  candidates into the whole-brain example (above).
- cellfinder filters uint32, int32 and float64 stacks in float64; this port filters in float32
  only, so detection refuses those types (registration accepts them). For 8- and 16-bit and float32
  stacks the clipping, threshold and soma values follow the sample type as in cellfinder's
  `DetectionSettings`.

## Data

- Examples: BrainGlobe test data (CC0, <https://gin.g-node.org/BrainGlobe/test-data>), voxels
  unchanged, repacked as OME-TIFF on `neurodeskorg/webapps` (`lightsheet-atlas/example/`).
- Atlas: Allen CCFv3 2017 via the BrainGlobe Atlas API (`allen_mouse_50um` 3.1), written by
  `validation/prepare_atlas.py` and pinned in `models/lightsheet-atlas.manifest.json`.
  © 2015–2017 Allen Institute for Brain Science. Both offline asset inventories bundle it. It is
  redistributed for research and noncommercial use only under the
  [Allen Institute terms of use](https://alleninstitute.org/terms-of-use/); commercial
  redistribution of an offline bundle needs the Allen Institute's written permission. Cite the
  dataset (Allen Institute for Brain Science (2017), Allen Mouse Brain Common Coordinate
  Framework, version 3 [dataset], atlas.brain-map.org) and Wang et al. 2020, Cell.

## Licence

Apache-2.0 AND BSD-3-Clause: `src/detect.js` ports cellfinder (`LICENSE-cellfinder`, `NOTICE`,
served as `THIRD_PARTY_NOTICES.txt`).
