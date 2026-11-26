# cellpose instructions

- `src/cellpose.js` ports Cellpose 3.1.1.1's 2D and 3D pipelines (`normalize99`, `getPadYX`, `taperMask`, tiled `runNet2D`, ortho-plane `runOrtho3D`, Euler `followFlows2D` / `followFlows3D`, histogram-peak `clusterMasks`, 2D `removeBadFlowMasks2D` and `fillHolesAndRemoveSmallMasks`). On the CC0 Allen Institute 2D and 3D examples (`cyto3` 2D, `nuclei` 2D and `cyto3` 3D), browser outputs match Python Cellpose 3.1.1.1 with F1 = 1.00 and mean matched IoU > 0.99.
- `validation/reference.json` records Python Cellpose 3.1.1.1 outputs (`validation/reference.py`); unit tests and `e2e/workflow.spec.js` check against it.
- Pretrained `cyto3` and `nuclei` ONNX models are exported by `validation/export_model.py` (with `mkldnn=False` and dynamic-shape `mean` in `make_style`) and pinned in `models/cellpose.manifest.json`.
