# T1 inference window placement — 2026-11-02

The SynthStroke model weights are unchanged. The correction changes the algorithm
around the model: the prealigned 160 × 160 × 192 T1 no longer expands to an
artificial 256³ volume before sliding-window inference. The final window is
anchored to the acquired image boundary. Eight 128³ windows replace 27 windows;
8-flip TTA, overlap setting 0.25, threshold 0.4, minimum component 30, global
z-score normalization, Gaussian blending and native-space projection stay fixed.
Only the T1 model selects minimum padding. Other models retain their defaults.

## Development comparison

Data: [OpenNeuro ds004884 v1.0.2](https://openneuro.org/datasets/ds004884/versions/1.0.2),
snapshot `0885e5939abc8f909a175dd782369b7afc3fdd08`. The first three same-session
T1/mask pairs in lexical subject order were exploratory; the next six were
follow-up checks. Scan and mask sizes, SHA-256 checksums and dataset paths are in
`padding-inputs.json`. No model-training exclusion was established.

| Subject | Before Dice | Corrected Dice | Before recall | Corrected recall |
| --- | ---: | ---: | ---: | ---: |
| M2012 | 0.6358 | 0.6449 | 0.5277 | 0.5414 |
| M2018 | 0.4249 | 0.5095 | 0.3240 | 0.3869 |
| M2026 | 0.0000 | 0.0000 | 0.0000 | 0.0000 |
| M2029 | 0.5397 | 0.5750 | 0.3906 | 0.4329 |
| M2034 | 0.6685 | 0.6675 | 0.5321 | 0.5290 |
| M2035 | 0.7871 | 0.8279 | 0.7386 | 0.8303 |
| M2036 | 0.8101 | 0.8774 | 0.7650 | 0.8710 |
| M2037 | 0.3608 | 0.3585 | 0.2372 | 0.2315 |
| M2042 | 0.8480 | 0.8735 | 0.7742 | 0.8012 |

Mean subject Dice: **0.5639 → 0.5927** across nine cases, and
**0.6690 → 0.6966** in the six follow-up cases. Six improved, two declined
slightly and one remained empty. This is a modest development improvement,
not a replacement for a broader evaluation. M2026's 6.8 mL reference lesion
remains completely missed. Several larger lesions remain under-segmented.

The manual masks were drawn on T2 and sampled onto T1 in scanner coordinates
with nearest-neighbor interpolation; anatomical T2-to-T1 registration was not
performed. Single-slice alignment previews were inspected for all nine cases.
Their sampling/alignment uncertainty limits the accuracy of these scores.
Forward/backward sampling of each reference through the prealignment grid gave
Dice 0.9762–0.9915 with retained volume ratios 0.9972–1.0009; these checks do not
establish anatomical registration accuracy.

Comparisons used the same cached CPU SynthStrip mask and prealignment per subject
to isolate window placement. An independent full command-line preparation on
M2018 reproduced the corrected experimental candidate voxel for voxel and with
the same native affine. Model SHA-256:
`49f3d047a2299501791c7176cfda770d45d2f411a18ef41dd1105be4d0582cb8`.

## Browser and regression checks

- Context-sensitive synthetic inference rejects any artificial-air window when
  the image already exceeds the patch size; a separate case checks voxel
  placement after padding a short axis.
- The fresh production browser's lesion inference, native projection, download
  and unconfirmed review workflow ran on M2018 using the verified CPU brain mask.
  Browser/CPU candidate Dice was 0.999318; native affines matched exactly.
- Full browser preparation on M2018 failed earlier in the existing SynthStrip
  stage with an opaque numeric ONNX Runtime error, at both 18 and 4 threads.
  The browser check above therefore does **not** validate browser brain extraction.
  This independent runtime issue remains unresolved by the window correction.

## Reproduction

Keep all scans, models, masks and outputs outside the source checkout. Provision
the files named in `padding-inputs.json` under `DATA_DIR/<subject>/{t1,mask}.nii.gz`
and obtain the pinned models with `calmar download-models --cache-dir MODEL_CACHE`.
Inspect the scanner-coordinate T2 reference alignment before interpreting scores.

```sh
node packages/calmar/validation/compare-padding.mjs DATA_DIR OUTPUT_DIR MODEL_CACHE
```

The opt-in comparison checks every input hash, runs the full shared CPU pipeline
for both modes, verifies native geometry and writes counts and scores to
`OUTPUT_DIR/comparison.json`. It requires fresh output directories. Recomputing
brain extraction/prealignment for each mode costs more than the cached experiment
reported above. Exact scores may differ slightly with nearest-neighbor tie
rounding between this JavaScript scorer and the original nibabel scorer.
