# white-matter-lesions instructions

- The pipeline, output writer and model pins live in `packages/white-matter-lesions`, shared by the
  worker and the `flames` command (`bin/flames.js`, `src/node.js`); change outputs there so both stay
  identical. Its `model.manifest.json` must equal `models/white-matter-lesions.manifest.json` (tested).
  Every `flames` archive must pass `validation/cli-check.mjs`: mask Dice >= 0.998 against the worker path
  on ONNX Runtime Web (`validation/web-reference.mjs`).
