# Brainchop

Whole brain segmentation of T1-weighted MRI using six Brainchop networks:
light and high-accuracy tissue segmentation, standard and small subcortical
segmentation, and Aparc+Aseg 50 and 104. Brain extraction and binary masking
are not offered.

Select an example or load one NIfTI image or DICOM series, choose a model, and
run segmentation. Download the label map from Output. Processing stays in the
browser. The worker is terminated on cancellation; retry starts a fresh worker.

The pinned upstream TensorFlow.js pipeline runs on WebGL. The atlas models use
upstream sequential convolution presets to limit activation memory; tissue and
subcortical models retain their standard upstream presets. Large atlas models
need substantially more graphics memory than the light tissue model. Software
WebGL adapters with an 8192-pixel texture limit cannot run the bundled example. NiiVue
conforms the input to Brainchop's 256 × 256 × 256, 1 mm LIA grid before inference.
The exported label map retains that grid and its affine; it is not resampled
back to the original voxel grid. These models are for research, not diagnosis.

Source and model URLs are pinned to upstream commit
`4c87885f3a2a8835e260d521dcec922b58d91d41`. See `vendor/brainchop/README.md`
for the local worker error-reporting change. Model weights remain outside this
source repository and are registered in the offline asset inventories.

Run `pnpm --filter brainchop build`, `pnpm --filter brainchop test`, and
`pnpm --filter brainchop test:e2e`. Browser tests run against production output.

For local Linux verification with Mesa llvmpipe (16384-pixel textures), run:

```sh
TMPDIR=/storage/tmp LIBGL_ALWAYS_SOFTWARE=1 BRAINCHOP_MESA=1 xvfb-run -a pnpm --filter brainchop test:e2e
```

The standard CI configuration uses the shared hardware-GPU browser settings.
