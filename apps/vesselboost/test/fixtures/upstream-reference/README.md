# Upstream VesselBoost reference mask

`lausanne-tof-crop-192x192x64_vesselboost-manual_0429.nii.gz` (13 930 bytes, SHA-256
`6502ec4c92e57bc98fda8d2c33f6cbd305d147a6d12b9982cf0932a2e37a3a1d`, 33 894 vessel voxels) is the
binary segmentation upstream VesselBoost produced for the test crop. `e2e/automation.spec.js`
requires the app's mask to reach Dice 0.99 against it. The app did not produce this file.

- Input: `test/tof-crop.mjs` cuts voxels x 80-271, y 112-303, z 36-99 from the pinned Lausanne
  TOF example (OpenNeuro ds003949 sub-000, CC0; see `example-provenance.json`). Crop SHA-256
  `80f24eb18924017208f7a5e9a50786428d8c98930cf0a3b85d6d628005aa5fd5`.
- Tool: https://github.com/KMarshallX/VesselBoost at commit
  `541158d90fda67d76e8a90a3a2ce1eedc53b4693`, run natively on macOS arm64 (CPU) with Python
  3.12.13, torch 2.11.0, numpy 2.4.4, scipy 1.17.1, nibabel 5.4.2, patchify 0.2.3,
  connected-components-3d 4.1.0.
- Weights: `manual_0429`, SHA-256
  `fb318efe161b0036f2af2585fb282dd92ab45c6f0258422154340f05a2b3ef80`, taken from layer
  `sha256:013b45082f1544f10da017ef55f138dea729cfbe3247bd8561ecaba5bcd5cd41` of
  `vnmd/vesselboost_2.0.0@sha256:091d2d274783f70829b0b329274cdc76887fd3f84dfed396cee05479827400e9`.
- Command, generated 2026-10-03:
  `python prediction.py --image_path in/ --output_path out/ --pretrained manual_0429 --prep_mode 4`
  (upstream defaults: threshold 0.1, components under 10 voxels removed, no blending), then
  `scripts/pack_upstream_reference.py` to store the mask as uint8.

`scripts/make_upstream_reference.sh` repeats all of it. Measured on 2026-10-03 the app (ONNX
Runtime Web 1.21.0, WebAssembly, downsample 1, no bias correction, no denoising) matched it
voxel for voxel: Dice 1.0000.
