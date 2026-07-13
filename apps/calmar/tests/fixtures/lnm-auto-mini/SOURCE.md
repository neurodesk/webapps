# Auto-branch full-pipeline smoke fixture

`T1.nii.gz` — MNI152NLin2009cAsym 1 mm template (via
`nilearn.datasets.load_mni152_template(resolution=1)`), resampled to
`160 × 160 × 192` 1 mm with the SynthMorph reference's affine, with a
synthetic 8-voxel-radius hypointensity sphere planted near MNI
(-50, -55, 5) mm to simulate a chronic stroke lesion (~20% of local mean
intensity inside the sphere). Stored as `int16` for compactness (~2 MB).

License: MNI152 templates are public-research-use derivatives of MNI/ICBM
data; redistributable under standard MNI/BrainWeb terms (cite Fonov et al.
2009/2011). No real patient data is committed.

## Why a planted lesion on the template instead of a real T1

The SynthMorph deformable head requires an input at exactly 160×160×192
1 mm AND roughly MNI-aligned. Real clinical T1s (e.g. `ds004884-mini`)
need an upstream affine registration step the webapp does not ship; the
deformable network does not converge from arbitrary clinical poses. The
MNI template self-matches near-identity, so the registration step runs
cleanly, and the rest of the chain (warp → bridge → Yeo overlap → FC
weighted-sum → threshold) executes end-to-end.

The planted lesion is *not* expected to be detected by SynthStroke
verbatim — it's a coarse intensity drop, not a real stroke. The smoke
test asserts the chain *completes without throwing*, not the model's
accuracy. A future Phase 11 fixture will use a real ATLAS-2 / ds004884
case after the upstream affine-prereg path lands.

## Rebuild

```sh
python3 tests/fixtures/lnm-auto-mini/build.py
```

Re-fetches the template and overwrites `T1.nii.gz`. Reproducible across
machines as long as nilearn doesn't re-release the template.
