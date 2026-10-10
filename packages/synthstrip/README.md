# @neurodesk/synthstrip

Runtime-injected SynthStrip processing, shared by SYNcro's browser worker and Node CLI. The model is the existing Neurodesk VesselBoost SynthStrip ONNX asset; its trained weights are reused. The browser graph splits decoder concatenation/convolution operations algebraically to avoid tensors larger than 2 GB, preserving full spatial context. The original graph remains the native CLI reference.

`runSynthstrip({volume, loadModel, createSession, Tensor, onProgress})` accepts a SynthSR-style volume `{dims, affine, data}` and returns brain, mask, signed-distance volumes and provenance. Runtime adapters own verified model downloads and ONNX Runtime session creation. Sessions/tensors are released after extraction.

Processing reproduces the container's LIA conformation, 1 mm sampling, nonzero bounding box, 64-voxel padding constraints, percentile normalization, signed-distance resampling into the input frame, 1 mm border, six-connected largest component and hole filling. Signed-distance extension beyond the supported model boundary fails explicitly.

Validation on the SYNcro real T1 test case uses the same synthesized input for both implementations. The preprocessed float32 tensor, final mask and masked brain match the container exactly. Signed-distance maximum error is 0.0000201 mm. This evidence applies to the tested synthesized image geometry; broader orientation/pathology validation remains needed. See `../syncro/validation`.

SynthStrip: Hoopes et al., *NeuroImage* (2022), https://doi.org/10.1016/j.neuroimage.2022.119474. Code/model attribution and terms are in `NOTICE` and `LICENSE`.


Reproduce the browser graph with Python and ONNX:

```bash
python scripts/prepare-browser-model.py original-synthstrip.onnx models/synthstrip-browser.onnx
```

The source checksum is enforced. The output SHA-256 is `dc9e11999b58d7949d77ddf1b2ed2910df66f8725c078a6b46ae08b8ebcc2800` (10,296,357 bytes). On the real test image, the rewritten graph preserves the reference brain and mask exactly; signed-distance maximum error is 0.0000212 mm. The model is published through `models/syncro.manifest.json` and has the same attribution/license as the source model.

The browser adapter needs `@neurodesk/runtime-support` in the consuming app.
It is a development dependency here so standalone Node deployments omit the
browser runtime and its dependencies.
