# CALMaR

**Co-designed Automated Lesion Mapping and Reporting** for stroke lesions,
running entirely in the browser:

1. Auto-segment a stroke lesion from a structural MRI (ONNX model in a Web Worker).
2. Normalize the patient brain to MNI152 with a deep-learning registration model.
3. Choose an `Atlas` and compute lesion overlap with either Yeo 7 networks or
   Schaefer 400 parcels.
4. Combine precomputed normative functional-connectivity maps into a
   lesion-network map. Yeo uses the supported 7-channel development_fmri pack;
   Schaefer uses the supported public N=155 development_fmri pack through the
   lazy-shard loader.
5. Threshold and visualize on top of MNI.

No backend. No data upload. Hosted on GitHub Pages.

The app opens on a short start page that explains the local-first workflow:
load a structural T1, review the lesion mask, then map and export results.
Patient images, masks, voxel values, screenshots, and generated outputs stay
on the user's computer; public atlas and model assets may be fetched by the
browser when needed.

## Status

**Selectable atlas implementation (current)** — the run controls now include a
visible select field labelled exactly `Atlas`.

- `Schaefer 400 parcels` is the default atlas. `Yeo 7 networks` remains fully
  supported and selectable for compatibility and comparison.
- `Schaefer 400 parcels` is available for direct lesion overlap via the
  official Schaefer2018 400-parcel, 7-network, 2 mm atlas. Result tables and
  CSV export use parcel labels instead of Yeo network names; Schaefer display
  labels omit the leading `7Networks_` prefix.
- The atlas registry in `web/js/app/atlas-options.js` maps each option to its
  overlap atlas, connectome asset, FC weighting mode (`network` or `parcel`),
  colormap, affected-map label atlas, and optional functional-profile asset.
- Schaefer FC generation is implemented as
  [`scripts/build_schaefer400_connectome.py`](scripts/build_schaefer400_connectome.py):
  it fetches public Nilearn `development_fmri` subjects, computes 400
  parcel-seed group t-stat maps, emits float16 row-major shards, writes a
  4 mm Schaefer label companion, and can upload to the HF dataset when
  `HF_TOKEN` is available. The manifest points at the uploaded 10-shard,
  118 MB pack and counts only the small index as cold-load because the browser
  fetches only shards containing lesion-hit parcels.
- Functional profile panels work for both atlas choices. Yeo uses the compact
  Yeo7 Neurosynth/NiMARE profile asset directly; Schaefer uses a parcel-wise
  NiMARE ROI decode over all 400 Schaefer parcels. Neither Yeo nor Schaefer is
  described as a dedicated language-area atlas.
- Spatial guardrails tag app-created NIfTI files as `native-t1`, `mni160`, or
  `atlas:<assetId>` and assert those spaces before computation and viewer
  overlay steps. This prevents atlas-grid masks, native review masks, and
  MNI160 registration products from being mixed silently.

**Phase 1 complete (v0.1.0)** — manual-mask Yeo 7-network overlap. Drop a
binary lesion mask aligned to MNI152NLin2009cAsym 2mm, click "Compute
overlap", get a per-network table with voxel counts, % of lesion, an inline
magnitude bar, and a CSV export. Voxels falling outside the Yeo brain mask
are surfaced as a warning. The Yeo7 atlas is fetched live from
[`sbollmann/lnm-webapp-models`](https://huggingface.co/datasets/sbollmann/lnm-webapp-models)
on Hugging Face and cached client-side.

**Phase 2 complete (v0.2.0)** — auto brain extraction + lesion
segmentation on T1.

Drop a structural T1; the app:

1. Runs **SynthStrip brain extraction** automatically in a module worker
   (~7–10 s on M-series, WASM EP, single-pass). Result is rendered as a
   translucent green overlay and downloadable as `lnm-brainmask.nii`.
   Model: manifest asset `lnm-synthstrip`, an ONNX FP32 export of
   [FreeSurfer SynthStrip](https://surfer.nmr.mgh.harvard.edu/docs/synthstrip/)
   (`SynthStrip-Hoopes2022-Apache-2.0`) ported from
   [`neurodesk/vesselboost-webapp`](https://github.com/neurodesk/vesselboost-webapp).
   See [Brain extraction model provenance](#brain-extraction-model-provenance)
   for the exact hosted asset, checksum, and browser wrapper contract.
2. On click of "Run lesion segmentation", runs **SynthStroke baseline**
   (the closest available openly-licensed model for ATLAS-2-style
   chronic stroke on T1; 3D MONAI UNet, MELBA 2025, MIT). ~5 s per pass
   on M-series. Result is rendered as a translucent red overlay and
   downloadable as `lnm-lesion.nii`. Sliding-window 128³ patches,
   threshold 0.4, min cluster 30, overlap 0.25, no TTA.
   See [Lesion segmentation model provenance](#lesion-segmentation-model-provenance)
   for the exact upstream model, conversion script, and browser runtime
   differences from the upstream 192³/TTA recipe.

**Phase 4 complete (v0.4.0)** — Yeo7 group functional-connectivity weighted
sum. After running "Compute overlap" on a manual MNI 2 mm lesion mask, click
"Compute network map" — the orchestrator fetches a 30 MB Yeo7 FC pack (7
brain-wide t-maps, computed from 30 ADHD-200 subjects via
[`scripts/build_yeo7_connectome.py`](scripts/build_yeo7_connectome.py)),
weights each network's t-map by the lesion's share of that network, and
emits a Float32 NIfTI on the Yeo7 atlas grid (99×117×95 2 mm). Output
renders as a red-yellow overlay and downloads as `lnm-network-map.nii`.
Pure main-thread JS — no worker round-trip; the math is a per-voxel linear
combination via [`web/js/modules/fc-weighted-sum.js`](web/js/modules/fc-weighted-sum.js).

**Phase 3 complete (v0.3.0)** — deformable MNI registration via
**SynthMorph** (Hoffmann 2022, Apache-2.0). Click "Run MNI registration"
on a 160×160×192 1mm structural T1; the app fetches the SynthMorph
ONNX (81 MB) + the lnm-mni160 reference (8 MB), downsamples the
source/reference pair to the browser graph's 48×64×80 grid, runs the
SVF-only sub-network in the worker, then performs scaling-and-squaring
SVF integration + 24×32×40→160×160×192 upsample + the spatial warp in pure JS
([`web/js/modules/registration.js`](web/js/modules/registration.js)).
WebGPU execution provider when available; falls back to WASM.

The **`lnm-yeo-auto`** pipeline declares the full T1 → SynthStrip →
seg → register → MNI Yeo overlap chain. Stages run individually for
now (each is a button click); a one-shot "auto" runner that also
resamples the warped lesion onto the MNI152 2mm Yeo grid is a
follow-up polish slice.

**Experimental notes**: SynthMorph's deformable head expects roughly-
MNI-aligned input. Without an upstream affine pre-step (FSL FLIRT,
ANTs `antsRegistrationSyNQuick`), deformable registration on raw
clinical T1 may not converge well. Inputs must be exactly 160×160×192
at 1mm; the orchestrator surfaces a clear error otherwise.

**Phase 39 (v0.17.0)** — assume raw T1; drop visible manual-mask input.

The Input section used to show two file inputs: "Structural T1" and
"Or: pre-computed lesion mask (Yeo 2 mm grid)". Clinical use is
T1-only — the second input was researcher-mode noise. Simplified:

- The lesion file input moves under Advanced as "Researcher mode:
  pre-computed lesion mask" with a clear note that the mask must
  already be on the selected atlas grid.
- The Input section now shows ONE input (T1) plus a help line
  explaining the auto chain handles everything from raw T1.
- `lnm-yeo-only` and `lnm-network-map` pipelines are flagged
  `hidden: true` so they drop out of the dropdown. Visible pipelines:
  `lnm-yeo-auto` (the default) and `lnm-segment-only`. Hidden
  pipelines remain reachable via `setLesion()` auto-promote when a
  researcher loads a Yeo-grid mask through the Advanced input or
  when the browser smoke drives `#lesionFileInput` directly.
- Static `<select>` fallback option in `index.html` is now
  `lnm-yeo-auto` (the auto chain) instead of `lnm-yeo-only`.

Test contract pinned: `test:tasks` asserts both manual-mask
pipelines are hidden + `lnm-yeo-auto` is visible. `test:html` asserts
the static fallback is now the auto pipeline.

**Phase 38 (v0.16.2)** — N=155 development_fmri connectome + smoke verify.

- **Connectome upgrade**: ADHD-200 N=40 → development_fmri N=155
  (~4× sample size). `scripts/build_yeo7_connectome.py` parameterised
  with a `--dataset {adhd, development_fmri}` flag; same processing
  pipeline (per-subject Yeo7 ROI mean → Pearson r-map → Fisher-z →
  group t-stat). New pack uploaded to HF as
  `connectomes/yeo7_fc_pack_dev155.bin` under cacheKey
  `yeo7-fc-pack-development-n155-v1`. Manifest entry repointed; old
  N=40 pack still accessible via its prior URL for users pinning the
  older cacheKey.

  Group t-stat range: **[-13.47, +30.72]** (vs N=40's [-13.85, +19.74]
  — peak +stat ~55% higher with the larger sample, as expected for a
  fixed-effect group analysis).

- **Browser smoke verified at v0.16.1**: 6/6 phases green
  (1c.4 + 8 + 2a.1.5 + 2a.2.5 + 3.7 + 10). Confirms Phases 34/35/36/37
  didn't regress anything user-visible. `SynthMorph EP=wasm`
  (headless Chromium + swiftshader doesn't satisfy ORT's WebGPU
  device requirements; degraded path fires as expected).

**Phase 35 (v0.16.1)** — controller + UI module behavior tests.

The Phase 33 audit flagged 4 controllers + 3 UI modules as
source-grep-only. This phase replaces that with real coverage:

- **`test:viewer-controller`** — fake NiiVue (records every call); pins
  the **Phase 4 silent-regression bug**: `loadBaseVolume` MUST call
  `nv.loadVolumes([single])` (1 entry), `loadOverlay` MUST use
  `nv.addVolumeFromUrl(...)`. A future "simplification" back to
  `loadVolumes([base, ...overlays])` (which leaves overlay LUT
  uninitialised in 0.68.x) fails immediately. 9 cases.
- **`test:file-io-controller`** — fake DOM File events; pins NIfTI vs
  DICOM detection (case-insensitive `.nii`/`.nii.gz`), the mixed-list
  picker, dispatch via `onFileLoaded`, drop-item routing. 9 cases.
- **`test:inference-executor`** — fake Worker constructor; pins the
  message protocol (init/load/run-synthstrip/run-register/etc.),
  `stageData` routing into `this.results`, `step-complete` state
  transitions, error-path `onError` + state cleanup, `cancel()`
  termination + idle-no-op, `removeResult`/`clearResults`,
  `volume-info` + `complete` callbacks. 11 cases.
- **`test:ui-modules`** — fake DOM; pins `ConsoleOutput` log/clear/
  missing-element no-op, `ProgressManager` setProgress paints
  `width: NN%` + reset-to-0, `ModalManager` open/close/toggle/isOpen +
  overlay-click-to-close (target===modal closes; click on a child
  doesn't). All three modules also tested for graceful behaviour when
  the bound DOM id doesn't exist.

**Test surface**: 24 → 28 distinct suites in `npm test`. Closes the
7 zero-coverage modules from the Phase 33 audit.

**Phases 34 + 36 + 37 (v0.16.0)** — auto-prealign + PCA orientation fix + download progress.

- **Phase 34: auto-prealign in `runFullPipeline`** — clinical T1
  workflow now requires *one click*, not three. The `lnm-yeo-auto`
  pipeline gains a `prealign` stage between `brain-extraction` and
  `inference-pipeline`. `prealignToMni160({ skipIfAligned: true })` is
  idempotent: probes the structural's dims and no-ops when already at
  160×160×192. New `prealign` module added to `IMPLEMENTED_MODULES`
  and `_runStage`'s case dispatch.

- **Phase 36: PCA 180° fix via NIfTI affine prior** — the Phase 33
  audit flagged that PCA on a brain mask gives the principal axes up
  to sign, so a clinical T1 acquired upside-down would silently
  prealign to a mirror-image brain. Resolution: trust the source NIfTI
  affine. After PCA, project each column from source-voxel to
  source-world space, pick column signs that make `R_world`'s diagonal
  positive (PCA axes align with world axes the source declares). When
  re-enforcing det = +1, flip the *most ambiguously-oriented* column
  (smallest `|R_world[k][k]|`) instead of always column 2 — which is
  what the previous implementation did and undid the sign correction.
  `test:prealign-pca-orientation` flipped from documented-limitation to
  hard assertion.

- **Phase 37: download progress for FC pack fetch** — the FC pack
  (~30 MB cold) used to download silently from Hugging Face during
  network-map runs. Now `loadConnectomeFromManifest` accepts an
  `onProgress` callback that the orchestrator wires into the existing
  status-bar progress. `fetchCacheFirst` opts into a streaming-tee
  path when a callback is supplied (cache hits skip the streaming).
  Exception in `onProgress` is swallowed — best-effort. Worker model
  fetches already had progress (Phase 19); this closes the atlas-side
  gap. Two new test cases added to `test:atlas-loader-cache`.

  *Honest correction*: the original Phase 37 plan claimed lazy-loading
  ORT WASM would drop first-page-load from 38 MB to 3 MB. On further
  inspection this was already the case — the worker (and therefore
  ORT) is created lazily; the 35 MB WASM only downloads on first
  inference. Pivoted Phase 37 to download-progress UX, which is the
  actual user-facing gap.

**Phase 33 (v0.15.1)** — test-suite audit + tightening.

Audit found three loose thresholds and four uncovered modules. Fixed:

**Tightened thresholds**:

- `test:resample-parity` Dice: ≥ 0.95 → exact `= 1.0`. The math is
  bit-exact for an aligned-grid 2× nearest-neighbour roundtrip.
- `test:real-data-bridge` per-network tolerance: flat ±25 voxels →
  `max(15, 0.05 × expected)`. Stops Visual (n=125) from getting 20%
  slack while Limbic (n=1904) gets 1.3%.
- `test:synthstrip-parity` coverage: 10–95% → 18–60%; centroid drift:
  <15 voxels → <10 voxels. Catches "model output is half a hemisphere"
  while accommodating the MNI template's natural inferior offset.

**4 new behavior tests** (replace source-grep coverage):

- `test:app-behavior` — partially-instantiates `LesionNetworkMappingApp`
  with stubbed browser globals, replaces `_runStage` with a recording
  spy, and asserts: stages dispatch in declared order, stage exception
  halts the chain, precondition gates fire, `_runStage` rejects
  unknown modules, `_autoPromotePipeline` only fires before user
  manual pick. Catches a regression where the for-loop accidentally
  `return`s after stage 1.
- `test:nifti-writer` — round-trips Float32 + Uint8 phantoms through
  `writeNifti1` and `nifti-reader-js`, asserts byte-equal voxel
  values, dim/spacing/affine round-trip, NIfTI-1 magic bytes. Was
  zero-coverage despite being load-bearing for every download button.
- `test:atlas-loader-cache` — exports `fetchCacheFirst` and pins the
  Phase 4 silent-fail bug fix: bare cacheKey strings parse as URL
  schemes and crash `Cache.put`; the fix folds them into a URL
  fragment. Tests warm-cache short-circuit, non-fatal cache failure,
  and HTTP-error propagation.
- `test:prealign-pca-orientation` — DOCUMENTS the 180° ambiguity
  limitation: PCA covariance is identical for upright and flipped
  acquisitions, so `principalAxisAlign` produces mirror-image outputs
  for the same anatomy. The test confirms equal mass / equal skew
  magnitudes on both poses; the orientation sign mismatch is logged
  but not hard-asserted (a 3rd-moment fix would interact poorly with
  the det = +1 enforcement; resolution needs an A/P/L/R anatomical
  prior or accepting MNI's left-handed FSL convention).

**Test surface**: 29 distinct test scripts, 21+ in `npm test` (was 21).
6 browser smokes + 4 opt-in heavy parity tests unchanged.

**Phase 32 (v0.15.0)** — UI cleanup for clinical use.

Audit found the sidebar had grown to **3 stacked sections × 6+ buttons
each** and the toolbar carried **9 controls of which 6 had no JS
binding** (carried over from the SCT scaffold). Redesigned:

- **Sidebar collapses to three numbered panels**:
  1. **Input** — file inputs only.
  2. **Run analysis** — single primary button. The 7 per-stage controls
     (brain extraction, prealign, lesion seg, registration, warp, Yeo
     overlap, network map) move into an `<details>` "Advanced" disclosure
     that's closed by default.
  3. **Results** — overlap table + threshold panel + 3 essential
     downloads (CSV, network map, thresholded mask). Brain/lesion mask
     downloads move into an "Intermediate downloads" disclosure.

  All 27 DOM IDs preserved (the per-stage buttons just live inside
  `<details>` now), so every existing JS binding + the
  `test_index_html.mjs` lockdown still work.

- **Toolbar trimmed**: dropped 6 dead controls (`windowMin/Max`,
  `rangeMin/Max`, `rangeSelected`, `resetWindow`, `inputVisibilityToggle`,
  `downloadCurrentVolume`, `screenshotViewer`) — none had JS bindings.
  Kept: view tabs, overlay opacity (now visible by default; was hidden),
  crosshair, smoothing, colorbar, base colormap.

- **Section headers** are now static labels (no longer click-to-collapse —
  the per-stage Advanced controls use native `<details>` instead).
  `toggleSection` script removed; `.sidebar-section.collapsed` CSS rules
  removed.

- **Browser smoke**: 4 tests broke (per-stage buttons inside closed
  disclosure → "not visible" to Playwright). Added `openAllDisclosures(page)`
  helper called after each `page.goto`; idempotent. Phase 8/10 (primary
  flow) untouched.

**Phase 31 (v0.14.1)** — smoke regressions fixed + docs refresh.

Ran the browser smoke for the first time since v0.10.0 and surfaced two
issues I'd been carrying:

1. **Pipeline auto-promote** — Phase 15 made `runFullPipeline` iterate
   `selectedPipeline.stages`. Default selection `lnm-yeo-only` only had
   `[parcel-overlap]`, so "Run full pipeline" with a manual mask only
   ran overlap. Phase 8 smoke timed out polling for `thresholdedMaskFile`.
   - `setStructural()` now auto-promotes the dropdown to `lnm-yeo-auto`
     (full auto chain), `setLesion()` to `lnm-network-map` (overlap +
     FC + threshold) when no structural is loaded.
   - Suppressed once the user manually picks a pipeline
     (`_userPickedPipeline = true`).
   - Result: Phase 8 smoke now passes in 4.3s (was 120s timeout).

2. **Browser-runnable SynthMorph graph** — the original 160×160×192 ONNX
   graph hit a multi-gigabyte first Conv3D activation in ORT WebGPU/WASM.
   The registered browser asset is now `lnm-synthmorph-mni-48x64x80.onnx`:
   same SynthMorph weights, smaller static graph, source/reference
   downsampled before ONNX, and displacement upsampled back to MNI160.
   `npm run test:synthmorph-browser-model` gates the activation budget,
   and Phase 3.7 smoke now requires browser registration completion.

AGENTS.md architecture entry for `prealign.js` added; test surface table
refreshed (20 Node suites listed).

**Phases 26–30 complete (v0.14.0)** — autonomy push.

This batch closes work I'd previously framed as needing user input,
after a re-review showed every blocker was softer than it sounded.

- **Phase 26 — PCA principal-axis prealign**
  [`web/js/modules/prealign.js`](web/js/modules/prealign.js) now exports
  `covarianceOfMask`, `jacobiEigen3x3`, and `principalAxisAlign`. The
  prealigner rotates the brain's principal axes onto MNI canonical
  axes (forced right-handed) on top of the centroid match. Validated
  on synthetic rotated phantoms AND on the real ds004884 T1 — PCA
  lands the brain mask centroid at MNI160 voxel (79, 81, 96) within
  1.5 voxels.

- **Phase 27 — N=40 ADHD-200 connectome rebuild + HF upload**
  Re-ran [`scripts/build_yeo7_connectome.py`](scripts/build_yeo7_connectome.py)
  at the maximum N (40) supported by `nilearn.datasets.fetch_adhd`,
  uploaded as `connectomes/yeo7_fc_pack_n40.bin` (cacheKey
  `yeo7-fc-pack-adhd200-n40-v1`), bumped the manifest. New group t-stat
  range [-13.85, 19.74]; old N=30 pack remains accessible via its
  prior URL.

- **Phase 28 — SynthMorph EP introspection**
  Worker now tries WebGPU explicitly first, catches the failure, then
  retries with WASM, and logs `SynthMorph EP=<name>`. Smoke surfaces
  the chosen EP in test output. Catches a regression where a future
  ORT upgrade silently always picks WASM (which OOMs on the 4 GB heap).

- **Phase 29 — PCA on real anatomical data**
  New `scripts/test_real_data_pca.mjs` runs the Phase 26 pipeline on
  the ds004884 T1 with a quick intensity-threshold brain mask. Asserts
  positive eigenvalues, dominant principal axis, det(R)=+1, and the
  resampled centroid lands within 1.5 voxels of MNI center.

- **Phase 30 — real-data Dice parity gate**
  `tests/fixtures/ds004884-mini/expected_yeo_overlap.json` pins the
  network voxel counts for ds004884; the bridge test asserts max-abs
  diff stays under 25 voxels per network. Catches a silent shift in
  the resample / bridge / overlap chain that doesn't crash but moves
  the answer.

**Phase 25 complete (v0.13.2)** — manifest checksum verifier.

`scripts/test_manifest_checksums.cjs` walks every supported asset in
`web/models/manifest.json`, locates its bytes in either
`web/models/_dev_cache/` (developer machine) or
`tests/fixtures/yeo7-mini/atlas.nii.gz` (committed copy), and asserts
the actual sha256 matches the manifest's declared one. Catches:

1. The committed Yeo7 fixture drifting from the runtime asset.
2. A model rebuild landing in `_dev_cache` without a matching manifest
   bump (cacheKey collision → browser serves stale cached bytes).
3. A manifest typo where `filename` / `sourceUrl` doesn't match the
   actual asset id.

Skips assets without a local copy (most CI runners don't fetch the
~200 MB of weights), but requires ≥ 1 verified asset so the gate
doesn't silently no-op. Currently verifies 7 / 7 supported assets
(including independent verification of the committed Yeo7 fixture)
on a developer machine.

**Phase 24 complete (v0.13.1)** — real-data Yeo overlap in `npm test`.

`tests/fixtures/yeo7-mini/atlas.nii.gz` (73 KB, identical bytes to the
runtime asset) committed alongside the existing `ds004884-mini` lesion
fixture. `scripts/test_real_data_bridge.mjs` extended to load the
atlas, run `computeParcelOverlap` + `summarizeNetworkOverlap` on the
prealigned + Yeo-resampled lesion, and assert:

- ≥ 2 Yeo networks hit (real chronic strokes span vascular
  territories that cross network boundaries)
- network voxel sums + out-of-atlas voxels = total Yeo lesion count

Output for the committed ds004884 case (left-hemisphere chronic
stroke): 7 networks hit; Limbic 11.6%, Default 10.5%, Frontoparietal
7.1% dominant; ~63% subcortical / outside the cortical Yeo mask.

**Phase 21+22 complete (v0.13.0)** — UX + deploy budget.

- **Reset state button**: New "Clear results" button in the Results
  section drops every intermediate file (overlap, network map,
  thresholded mask, brain mask, lesion mask, MNI lesion, network map
  raw data) + re-disables every download button + clears the table
  body and threshold summary. Structural file is retained so users
  can quickly re-run on the same input.
- **Deploy-size budget**: New `scripts/test_deploy_budget.cjs` walks
  the static deploy artifact (web/ minus _dev_cache) and tallies
  every supported manifest entry's `sizeBytes` for runtime fetches.
  Asserts static < 60 MB (currently 38) and total cold-load < 300 MB
  (currently 247). Locks the original plan's "<200 MB cold load"
  acceptance criterion against future model swaps.

**Phase 18 complete (v0.12.1)** — real-data bridge integration test.

The unit suites covered the resample math on synthetic phantoms and
the prealign math on synthetic centroids; this slice connects them on
real anatomical shape so a regression that fires only on a real lesion
surfaces in CI. New `scripts/test_real_data_bridge.mjs` runs in `npm
test`:

1. Decodes the committed `ds004884-mini` lesion mask (160×256×256 1mm
   real chronic stroke, ~131k voxels).
2. Runs `centroidOfMask` → `applyAffineToVoxel` → `computePrealignAffine`.
3. Resamples the lesion onto MNI160 1mm via `resampleAffine(...)`.
4. Resamples again onto the canonical Yeo7 99×117×95 2mm grid.
5. Asserts: source 131k → MNI160 ~131k (within ±15% for a 1mm→1mm
   shift+flip), MNI160 → Yeo7 within ±50% of the expected ⅛
   downsample, and the MNI160 centroid lands at voxel (80, 80, 96)
   within 1 voxel.

**Phase 16 complete (v0.12.0)** — in-browser affine pre-registration.

The SynthMorph deformable head requires its input at exactly 160×160×192
1mm AND roughly MNI-aligned. Real clinical T1s come in arbitrary dims,
voxel sizes, and ACPC orientations, which previously meant external
prep (FSL FLIRT / ANTs) before the auto chain could run. This phase
ships a centroid-match prealigner in pure JS:

- New module [`web/js/modules/prealign.js`](web/js/modules/prealign.js)
  exports `centroidOfMask`, `applyAffineToVoxel`, and
  `computePrealignAffine`. The destination affine places the source
  brain centroid at MNI160 voxel (80, 80, 96) under canonical FSL
  orientation (-x, +y, +z); when fed to `resampleAffine(..., 'trilinear')`
  it produces a 160³ 1mm prealigned T1 + brainmask in one pass.
- New orchestrator method `prealignToMni160()` and a new "Pre-align to
  MNI 160³ 1mm" button in the Lesion section. Runs SynthStrip first
  if the brainmask is absent, then resamples T1 + brainmask in pure JS,
  clears stale downstream state, and rerenders the viewer.
- Test suite: `scripts/test_prealign.cjs` covers the math (cube
  centroid, identity / scaled+translated affines, round-trip from MNI
  voxel back to source world centroid). Wired into `npm test`.

Limitations: centroid match only — no rotation correction, no
intensity-based optimisation. Works well for ACPC-aligned scans
(modern T1s); rotated clinical acquisitions or scans with severe
pathology may need a follow-up rigid pass (Phase 16 v2).

**Phase 20 complete (v0.11.1)** — CI/CD lock-down. Both
`.github/workflows/deploy-pages.yml` and `.github/workflows/release.yml`
were carried over from the SCT scaffold and broken on this fork
(referenced Git LFS we don't use, `web/models/*.onnx` files that don't
exist, and missing helper scripts `get_version.sh` /
`summarize_test_failures.cjs`). Rewritten:

- LFS removed throughout (we fetch ONNX from Hugging Face at runtime).
- Deploy verification now checks `web/wasm/ort-wasm*.wasm` (the only
  weight-class artifact we actually ship).
- New `scripts/get_version.sh` parses `VERSION` out of
  `web/js/app/config.js` for the release-tag bump step.
- Release workflow simplified — runs `npm test`, uploads the log on
  failure, computes the next patch version, tags + creates the GitHub
  release, then the deploy workflow's `workflow_run` trigger redeploys
  production from the new tag.

**Phase 19 complete (v0.11.0)** — per-stage perf instrumentation.

`runFullPipeline()` now wraps each stage in `performance.now()` markers,
logs a `[perf] <stage> (<module>): NN.NN s` line per stage, and emits a
final `=== Pipeline complete in X ===` summary with the total runtime
and stage count. Stage timings are also collected into
`window.app._perfStats` for inspection (e.g. `JSON.stringify(app._perfStats)`
in the dev console). No external deps; same suite stays green.

**Phase 15 complete (v0.10.0)** — pipeline-driven `runFullPipeline`.

- `runFullPipeline()` now iterates `selectedPipeline.stages` instead of
  hard-coding the chain. Selecting a different pipeline truncates or
  extends what runs:
  - **lnm-yeo-only**: overlap (manual mask).
  - **lnm-segment-only**: brain extraction → lesion seg.
  - **lnm-network-map**: overlap → FC → threshold (manual mask).
  - **lnm-yeo-auto**: brain extraction → seg → register → overlap →
    FC → threshold.
- New `_runStage(stage)` dispatches on `stage.module`. Unknown modules
  throw so a manifest typo surfaces immediately.
- Threshold module added to `IMPLEMENTED_MODULES`. Stage-level
  `defaults` are pushed into the threshold UI controls before
  `applyNetworkThreshold()` runs, so each pipeline can ship its own
  threshold preset.
- Test contract pinned: `_runStage` must have a case for every
  implemented module; `runFullPipeline` must iterate `pipeline.stages`.

**Phase 14 complete (v0.9.1)** — cancel-button wiring. The
`#cancelButton` next to the status line now actually terminates the
worker via `executor.cancel()`. Disabled state is driven from
`handleWorkerProgress` (enabled while progress fraction is in [0, 1))
and `handleStepComplete` (disabled at end-of-step), matching the
SCT-era behaviour for which the button was originally drawn.

**Phase 13 complete (v0.9.0)** — UX surface.

- Pipeline dropdown now lists every runnable pipeline declared in
  `lnm-tasks.js`, not just `lnm-yeo-only`. The Schaefer400 legacy pipeline
  (`lnm-default`) remains `hidden: true`; the user-facing Schaefer path is the
  `Atlas` selector.
- New `isPipelineRunnable(pipeline)` helper + Node test enforces the
  dropdown filter contract.
- About modal now shows the actual `Config.VERSION` instead of an
  empty placeholder.

**Phase 8–11 complete (v0.8.0)** — fixtures + smoke + docs.

- New 160×160×192 1mm fixture
  ([`tests/fixtures/lnm-auto-mini`](tests/fixtures/lnm-auto-mini)):
  MNI152NLin2009cAsym 1mm template + planted hypointensity sphere as a
  smoke-test stand-in for a real stroke T1.
- Browser smoke now covers both branches of the full pipeline button.
  Phase 8 (manual mask, ~15 s) and Phase 10 (auto chain, ~5 min cold)
  exercise the orchestrator end-to-end.
- AGENTS.md "Test surface" + "Key Conventions" sections rewritten
  from the SCT scaffold to the current LNM invariants (module worker
  lazy nifti load, Cache Storage URL fragment trick, NiiVue
  `addVolumeFromUrl` call shape, SynthMorph 160³ hard check,
  bridge/runFullPipeline contract, threshold UI live-update).

**Phase 7 complete (v0.7.0)** — polish + parity guard.

- Citations modal updated with Yeo, SynthStrip (Hoopes 2022),
  SynthStroke (Chalcroft 2025), ATLAS v2.0 (Liew 2022), SynthMorph
  (Hoffmann 2022), ADHD-200, and the canonical lesion-network-mapping
  paper (Boes 2015).
- `runFullPipeline()` now detects a manually-loaded Yeo-grid lesion mask
  and skips segmentation/registration/bridge — going straight to
  overlap → FC → threshold so the manual flow is one click too.
- New `test:resample-parity` suite asserts a Yeo→MNI160→Yeo
  nearest-neighbor roundtrip preserves a 6³ phantom at Dice = 1.0 with
  no centroid drift, locking down the bridge math against future
  changes.

**Phase 6 complete (v0.6.0)** — end-to-end auto-pipeline. The native lesion
mask produced by SynthStroke is now bridged onto the Yeo7 MNI 2 mm grid in
two steps the orchestrator chains internally:

1. The worker applies the SynthMorph integrated displacement field to the
   F-order lesion voxels (`stepWarpMask` → 160×160×192 1 mm).
2. Pure-JS [`web/js/modules/resample.js`](web/js/modules/resample.js)
   performs an affine-aware resample (NIfTI sform → 4×4 inverse →
   per-voxel destination lookup) onto the Yeo atlas grid (99×117×95
   2 mm), nearest mode for binary masks.

The result is adopted as `this.lesionFile` so a downstream
`runYeoOverlap` → `runFcNetworkMap` → `applyNetworkThreshold` chain
runs without any extra plumbing. A new **"Apply registration to lesion"**
button exposes step (1)+(2); a **"Run full pipeline"** button chains
brain extraction, lesion segmentation, registration, the bridge, Yeo
overlap, FC network map, and threshold (defaults) in one click.

**Phase 5 complete (v0.5.0)** — thresholding UI + cluster cleanup. The
"Network map" subsection now exposes a Threshold panel:

- **Mode**: absolute (slider is t-stat) or top percent of |voxels| (slider
  is 0–10 in 0.1% steps; `5` keeps roughly the strongest 5% and `0` keeps none).
- **Symmetric** toggle: `|x| > T` instead of `x > T` for positive/negative
  one-sided.
- **Min cluster (voxels)**: post-threshold 26-connected component cleanup
  via the existing `removeSmallComponents` helper. The summary reports how
  many voxels were removed by this cleanup, so a value below the current
  connected component sizes is explicit rather than silent.
- A live summary line reports the survivor count; a **Download
  thresholded mask** button emits a `Uint8` NIfTI binary mask
  (`lnm-network-map-thresh.nii`).

Pure JS in [`web/js/modules/threshold.js`](web/js/modules/threshold.js);
the slider re-fires `applyNetworkThreshold` on every input change so the
mask + summary stay in sync with the controls.

## Attribution

The browser scaffolding (NiiVue viewer integration, ONNX Runtime Web worker
pipeline, NIfTI/DICOM I/O, GitHub Pages deploy workflow) is adapted from
[`neurodesk/spinalcordtoolbox-webapp`](https://github.com/neurodesk/spinalcordtoolbox-webapp).
See `THIRD_PARTY_NOTICES.md` (added in Phase 1) for full credit.

Pipeline-specific dependencies (added incrementally):

- **Brain extraction**: SynthStrip (Hoopes 2022, Apache-2.0); manifest asset `lnm-synthstrip`, ONNX export ported from `neurodesk/vesselboost-webapp`.
- **Lesion segmentation**: SynthStroke baseline (Chalcroft 2025 MELBA, MIT); 3D MONAI UNet, T1.
- **Registration**: SynthMorph (Hoffmann 2022, Apache-2.0); UNet-only ONNX cut (layers 0–33); JS-side SVF integration + warp.
- **Atlases**: Yeo 2011 7-network cortical atlas; Schaefer 2018 400 × 7 networks (CC-BY).
- **Connectomes**: Yeo7 development_fmri N=155 group functional connectivity (computed by `scripts/build_yeo7_connectome.py`, Yeo7 ROI seed-to-voxel t-maps). Schaefer400 development_fmri N=155 group functional connectivity is built by `scripts/build_schaefer400_connectome.py` and served as 10 lazy float16 shards with a 4 mm Schaefer companion atlas.
- **Functional profiles**: Exploratory term associations from compact Neurosynth v7 / NiMARE profile assets. Yeo7 profiles are rebuilt offline with `scripts/build_yeo7_function_profiles.py`; Schaefer400 profiles are generated by `scripts/build_schaefer400_function_profiles.py` with a parcel-wise NiMARE `ROIAssociationDecoder` over all 400 Schaefer ROIs. Both are weighted in-browser by direct lesion overlap or thresholded connectivity-map effects.

### Lesion segmentation model provenance

CALMaR uses exactly one default SynthStroke lesion-segmentation asset:

- Manifest id: `lnm-stroke-lesion`
- Runtime filename: `models/lnm-stroke-lesion.onnx`
- Source version: `SynthStroke-baseline-MELBA2025-MIT`
- Browser format: `onnx-fp32`
- Cache key: `lnm-stroke-lesion-synthstroke-baseline-v1`
- Size: `74518462` bytes
- SHA-256: `49f3d047a2299501791c7176cfda770d45d2f411a18ef41dd1105be4d0582cb8`
- Hosted source: [`sbollmann/lnm-webapp-models/models/lnm-stroke-lesion.onnx`](https://huggingface.co/datasets/sbollmann/lnm-webapp-models/resolve/main/models/lnm-stroke-lesion.onnx)

The ONNX asset was converted from the Hugging Face
[`liamchalcroft/synthstroke-baseline`](https://huggingface.co/liamchalcroft/synthstroke-baseline)
model:

- Upstream model: SynthStroke baseline, not SynthStroke SynthPlus
- Upstream revision observed for provenance: `b693a650026359705688fbce409219c4dbb5d6be`
- Upstream files: `config.json` and `model.safetensors`
- Upstream config SHA-256: `2d9e7eb2ab4cb0a696ce6a845ad3123b77b31867f7ba74a271b81132cca38b1e`
- Upstream weights size: `74468100` bytes
- Upstream weights ETag: `d56c089e8c4bcc0ad2281f1e80b7c0e265f3b7138dee17fb2d160487604eee66`
- Conversion source: `scripts/convert_lesion_seg_model.py`

`scripts/convert_lesion_seg_model.py` reconstructs the MONAI 3D UNet from the
upstream config (`channels=[32,64,128,256,320,320]`,
`strides=[2,2,2,2,2]`, `PRELU`, `INSTANCE`, `num_res_units=1`), loads the
Safetensors weights, traces a static `1 x 1 x 128 x 128 x 128` tensor, exports
opset 17 ONNX with weights inlined in a single file, then checks PyTorch vs
ONNX Runtime output with a max-absolute-difference gate of `< 1e-2`.

The upstream model card describes 192³ patches, 1 mm spacing, one T1w input
channel, background/stroke output classes, and optional TTA. CALMaR uses the
same baseline weights but runs browser-bounded 128³ sliding-window patches with
`overlap=0.25`, `testTimeAugmentation=false`, probability threshold `0.4`, and
minimum connected component size `30`. At runtime the worker collapses the
2-channel `[background, stroke]` logits into a single stroke log-odds map
(`stroke - background`) before sigmoid thresholding.

### Brain extraction model provenance

CALMaR uses exactly one SynthStrip model asset for brain extraction:

- Manifest id: `lnm-synthstrip`
- Runtime filename: `models/synthstrip.onnx`
- Source version: `SynthStrip-Hoopes2022-Apache-2.0`
- Browser format: `onnx-fp32`
- Cache key: `lnm-synthstrip-v1`
- Size: `10294211` bytes
- SHA-256: `7b8eeecf3793a6c4510b9f5270ecc03d9c3262d26e08d568203a651ab4b84074`
- Hosted source: [`sbollmann/lnm-webapp-models/models/synthstrip.onnx`](https://huggingface.co/datasets/sbollmann/lnm-webapp-models/resolve/main/models/synthstrip.onnx)

The ONNX asset was converted from FreeSurfer's official main SynthStrip model
v1 checkpoint:

- Original model: `synthstrip.1.pt` (main SynthStrip model v1, not
  `synthstrip.nocsf.1.pt` or the pediatric model)
- Original source: [`surfer.nmr.mgh.harvard.edu/pub/dist/freesurfer/synthstrip/models/synthstrip.1.pt`](https://surfer.nmr.mgh.harvard.edu/pub/dist/freesurfer/synthstrip/models/synthstrip.1.pt)
- Original SHA-256: `37417f802196186441aae3e7f385d94f8a98c64a88acaeaa2723af995c653e33`
- Conversion source: `neurodesk/vesselboost-webapp:scripts/convert_synthstrip.py`

The app resolves this entry from `web/models/manifest.json`.
`runBrainExtraction()` passes it to the module worker with the `lnm-synthstrip`
model asset id. The worker runs `web/js/modules/brain-extraction.js` with the
browser fast path (`fast: true`), WASM execution, no final dilation, SDT `< 1`
thresholding, largest connected component cleanup, and interior fill. The JS
wrapper is the browser port of the FreeSurfer SynthStrip preprocessing and
postprocessing path used by `neurodesk/vesselboost-webapp`.

## Local development

```sh
npm install
bash web/setup.sh   # downloads ONNX Runtime WASM
bash web/run.sh     # serves http://localhost:8080/
npm test            # full Node-only suite: lint, manifest, overlap,
                    # function profiles, spatial checks, inference helpers,
                    # worker, app, html
```

### Browser smoke tests

Optional. Run the Phase 1 manual-mask Yeo flow + the Phase 2a.1 auto-fired
SynthStrip flow in headless Chromium. Not in `npm test`; requires a one-off
browser install:

```sh
npx playwright install chromium
npm run test:smoke               # ~10 s on M-series; needs HF access
```

### Node-side parity tests

Drive each ONNX pipeline directly via `onnxruntime-node` (no browser),
against a real MNI152 anatomical T1. Pipeline-correctness checks
(plausibility, not Dice — see commit notes).

```sh
npm run test:synthstrip-parity     # SynthStrip:        ~5 s
npm run test:lesion-seg-parity     # Lesion seg:        ~5 s; Dice >= 0.50 vs ds004884 ground truth
npm run test:registration-parity   # SynthMorph:       ~3 s (CPU EP); browser graph self-pair near-identity
npm run test:fc-weighted-sum-parity # FC weighted sum: ~1 s; identity case bit-exact
```

All fetch their respective ONNX models live from Hugging Face on first
run (cached under `web/models/_dev_cache/`, gitignored). The
lesion-segmentation parity uses one chronic-stroke subject from
[OpenNeuro ds004884](https://openneuro.org/datasets/ds004884/versions/1.0.1)
(Aphasia Recovery Cohort, Roth et al. 2024 — CC0); see
`tests/fixtures/ds004884-mini/SOURCE.md` for attribution. Observed Dice
on `sub-M2051 ses-284`: 0.5325.

## License

TBD; intended to be open-source. Third-party assets retain their own licenses.
