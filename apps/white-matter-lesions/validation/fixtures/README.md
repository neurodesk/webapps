# Reference lesion mask for the shipped example

`MSLesSeg_P57_T1_FLAIR_reference-fold0_lesions.nii.gz` (10 124 bytes, SHA-256
`e8305ef1bb0fa4260cc9a434fec1bf65e171e6c929e67b6c446c1a3935fea905`, 12 631 lesion voxels,
90 lesions, 31.52 ml) is what `validation/reference.py` produces for the example FLAIR with
FLAMeS fold 0. `e2e/app.spec.js` requires the browser app's mask to reach Dice 0.99 against it.
Measured 2026-10-03 on WebAssembly: Dice 0.9989 (12 623 app voxels, 90 lesions, 31.5 ml).

What it is independent of: `src/pipeline.js` and ONNX Runtime Web. `reference.py` is NumPy with
nnunetv2's `resample_data_or_seg_to_shape` and native ONNX Runtime, and `validation/README.md`
records its agreement with `nnUNetv2_predict` (Dice 0.97 to 0.99).

What it is not independent of: the brain mask comes from the app's SynthStrip port
(`strip_example.mjs`), and the network is the same ONNX export. It is not `nnUNetv2_predict`
on FreeSurfer's SynthStrip, which is not installed where this was generated, and it is not the
expert annotation, which MSLesSeg publishes only in MNI space (42.1 ml for this patient).

Generated 2026-10-03 on macOS arm64 with Python 3.12.13, onnxruntime 1.25.1, nnunetv2 2.8.1,
batchgenerators 0.25.1, numpy 2.4.4, scipy 1.17.1, nibabel 5.4.2, and Node 24.13.0 with the
repository's onnxruntime-web:

```sh
# <work> holds MSLesSeg_P57_T1_FLAIR.nii.gz (the pinned example, SHA-256 179472456b85...),
# flames-fold0.onnx (models/white-matter-lesions.manifest.json) and synthstrip-browser.onnx
# (models/syncro.manifest.json, SHA-256 dc9e11999b58...).
node validation/strip_example.mjs <work>/MSLesSeg_P57_T1_FLAIR.nii.gz <work>/synthstrip-browser.onnx \
  <work>/stripped/MSLesSeg_P57_T1_FLAIR.nii.gz          # 638 026 brain voxels
python validation/reference.py <work> example_f0 --inputs stripped --folds 0 --model 'flames-fold{}.onnx'
```

The mask in `<work>/out/example_f0/` was then stored as uint8 with an untimestamped gzip.
