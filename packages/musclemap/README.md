# MuscleMap

The browser worker and portable command line use one pipeline for MONAI-compatible
preprocessing, sliding windows, checkpoint-specific labels, volumes and IMF.
ONNX Runtime, model loading, decompression and events are injected by the runtime.

## Command line

```sh
musclemap image.nii.gz results --model wholebody-v1.4 --threads 4
musclemap image.nii.gz results-imf --imf gmm --imf-components 3
musclemap image.nii.gz results-dixon --imf dixon --fat fat.nii.gz --water water.nii.gz
musclemap download-models
musclemap self-check
```

Application release 1.5 adds the portable command; the default scientific checkpoint remains wholebody v1.4.

The portable archives include Node, the native CPU runtime and all seven verified
models. The launcher runs offline by default. A source installation downloads models
into `NEURODESK_MUSCLEMAP_MODEL_DIR`, or an XDG cache, unless `--offline` is set.
Every cached file is checked for its byte length and SHA-256 before inference.

`--model` accepts `wholebody-v1.4` (default), `wholebody-v1.3`, `abdomen-v0.0`,
`forearm-v0.0`, `leg-v0.0`, `pelvis-v0.0` and `thigh-v0.0`. Region names select their
active checkpoint. Each checkpoint retains its own label space; sparse anatomical
labels and class-index display labels are separate outputs.

The new or empty output directory contains `IMAGE_segmentation.nii`,
`IMAGE_segmentation_display.nii` and `musclemap_metrics.csv`, matching the browser's
filenames and CSV serializer. Volumes are in ml. Inputs must be single 3D NIfTI
volumes; geometry is preserved. Threshold IMF supports k-means or GMM with two or
three components. Dixon requires fat and water images with the same dimensions and
affine as the source. `both-kmeans` and `both-gmm` report both methods in the CSV.
DICOM import, editing and segmentation consolidation remain browser workflows.

CPU threads default to `SLURM_CPUS_PER_TASK` or at most four cores. `--overlap`
defaults to the selected model's published setting. Source slices are processed in
chunks of 17 unless `--source-chunk-size full` is selected. `--batch-size` controls
inference batching without changing the source-chunk preprocessing contract.

## Validation and release

`validation/cli-check.mjs --executable PATH` verifies the extracted executable
against the actual browser worker and the independent upstream PyTorch masks from
MuscleMap's existing parity cases. Browser and native inference run sequentially, with four threads each. The original gates remain: identical geometry,
0.99 overall agreement, 0.95 foreground Dice and 0.95 Dice for every reference label.
Chromium and NumPy/nibabel are provisioned only for this package's CI validation;
they are not shipped in the executable archive. Live browser comparison adds
substantial CI time, especially for the anisotropic leg case. The command's volume CSV must agree with its label maps, and IMF runtime tests cover
threshold and Dixon calculations independently of checkpoint inference.

Build and verify on the target platform:

```sh
python3 exes/node-cli/scripts/portable_release.py package packages/musclemap linux-x64
python3 exes/node-cli/scripts/portable_release.py verify packages/musclemap linux-x64
```

`musclemap-native.yml` checks Linux x64, Windows x64 and macOS arm64 independently.
Release publication uses the shared signing workflow; the macOS release is a signed,
notarized installer. Pull requests retain an ad hoc installer for testing.

See [the app README](../../apps/musclemap/README.md) for scientific references,
checkpoint provenance, model licensing and the upstream preprocessing contract.
