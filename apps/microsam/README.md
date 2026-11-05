# micro-sam

Interactive 2D segmentation of light-microscopy images with Segment Anything for Microscopy
(micro-sam; Archit et al., Nature Methods 2025). The app computes the image embedding once with
micro-sam's light-microscopy generalist ViT-T model (`vit_t_lm`), then runs the prompt decoder for
every positive or negative click and every box. Accepted objects form a label image (uncompressed
16- or 32-bit TIFF) and a per-object CSV table (`id, area_px, centroid_x, centroid_y, bbox_x0,
bbox_y0, bbox_x1, bbox_y1, mean_intensity` (or one mean per colour channel), `predicted_iou,
prompt`). Input is one TIFF, OME-TIFF, ImageJ TIFF or PNG image of up to 4096 × 4096 pixels (16 megapixels).

## Pipeline

| Step | micro-sam 1.8.14 (PyTorch) | Here |
| --- | --- | --- |
| Three channels, 0..255 | `micro_sam.util._to_image` (float32, truncated to uint8) | `threeChannels`, `channelToUint8` in `src/preprocess.js` |
| Resize to 1024 on the long side | `ResizeLongestSide.apply_image`: torchvision `resize` on a PIL image, Pillow's bilinear filter | `resizeChannel`, a port of Pillow 13.0.0 `Resample.c` (8-bit fixed point, both pass orders) |
| Normalise and pad | `Sam.preprocess` | `encoderTensor` (float32) |
| Encoder | TinyViT, `precompute_image_embeddings` | `microsam-vit-t-lm-encoder.onnx` on ONNX Runtime Web 1.29, WebGPU or WebAssembly |
| Prompts | `segment_from_points`, `segment_from_box`, `segment_from_box_and_points`, `_process_box` | `decoderInputs`, `boxFromCorners` (numpy rounding), `chooseToken` in `src/segmentation.js` |
| Decoder | `SamPredictor.predict` | `microsam-vit-t-lm-decoder.onnx` (MobileSAM `SamOnnxModel`, all four mask tokens), WebAssembly |
| Mask choice | one positive click: best of the three multimask outputs by predicted IoU; otherwise the single-mask output | the same |
| Committing | napari annotator, `preserve_mode="pixels"` | `commitObject`: a new object never takes an accepted object's pixels |

The worker (`src/worker.js`) keeps the embedding for the session and is terminated to cancel an
embedding run. Decoding is serialised: a newer prompt supersedes an older answer.

### Attention biases

TinyViT caches its attention biases in `Attention.ab` whenever `train(False)` runs, and uses the
cache, not the trained `attention_biases`, at inference. The app exports the model with the zero
cache micro-sam's own inference runs with (`validation/export_onnx.py`: `TrainingMode.PRESERVE`,
no `eval()`, asserting `max |ab| = 0`, which `models/microsam.manifest.json` records as
`cached_attention_bias_absmax`). The upstream code paths disagree:

- Inference leaves the cache at zero. MobileSAM's `build_sam_vit_t` calls `eval()` before it
  loads a checkpoint ([`build_sam.py` L88, L92](https://github.com/ChaoningZhang/MobileSAM/blob/f706ad9c/mobile_sam/build_sam.py#L88-L92)); micro-sam's `get_sam_model`
  builds the model through that registry entry and only then loads the checkpoint, without calling
  `eval()` again ([`util.py` L441, L457](https://github.com/computational-cell-analytics/micro-sam/blob/cb88e8d6/micro_sam/util.py#L441-L457)).
- Training and validation use the trained biases. `SamTrainer` calls `model.train()` for each
  epoch and `model.eval()` before validation, which refreshes the cache from the biases being
  trained ([`sam_trainer.py` L394, L449](https://github.com/computational-cell-analytics/micro-sam/blob/cb88e8d6/micro_sam/training/sam_trainer.py#L394-L449)), and the
  BioImage.IO export calls `predictor.eval()` ([`model_export.py` L55](https://github.com/computational-cell-analytics/micro-sam/blob/cb88e8d6/micro_sam/bioimageio/model_export.py#L55)).
- The published model matches the zero cache. The test embedding in BioImage.IO
  `faithful-chicken` 1.1, the model as micro-sam distributes it, equals the zero-bias state, not
  the refreshed one. This is the main reason for the choice: the app gives what micro-sam users
  get from the published model.

Mask IoUs against the example's annotation are no evidence either way: the example is from
BBBC038 stage1_train, which is part of the light-microscopy generalist's training data, so those
IoUs are in-sample. Which state upstream intends is open; an issue should be filed with micro-sam
asking whether inference is meant to run with the trained attention biases. If upstream changes
`get_sam_model`, re-export and rerecord `validation/reference.json`.

## Validation

Python 3.11 with torch 2.5.1 (CPU), micro-sam 1.8.14 (`cb88e8d6`), MobileSAM `f706ad9c`,
segment-anything `dca509fe`, Pillow 13.0.0, onnx 1.17.0, onnxruntime 1.20.1:

```
python -I validation/export_onnx.py vit_t.pt <out>
python -I validation/make_example.py <stage1_train> <out>
python -I validation/reference.py vit_t.pt <out>/microsam-vit-t-lm-encoder.onnx <out>/microsam-vit-t-lm-decoder.onnx \
  bbbc038-nuclei.tif bbbc038-nuclei-labels.tif validation/reference.json
python -I validation/preprocess_reference.py test/fixtures/preprocess-reference.json
python -I test/fixtures/make_fixtures.py test/fixtures
```

- Export (random inputs): encoder max abs difference 2.6e-6 against PyTorch; decoder 6.2e-4 in
  mask logits and 1.8e-7 in predicted IoU.
- `validation/reference.json`: 24 fixed prompts on the example (six nuclei; one click at the
  centroid, the annotation's bounding box, the click plus a negative click on the nearest other
  nucleus, the box plus the click), run through micro-sam's own `segment_from_*` functions. The
  ONNX models in Python give the same 24 masks (IoU 1.0); embedding max abs difference 2.7e-6.
- Unit tests (`test/preprocess.test.js`): the uint8 image, the Pillow resize and the float32
  encoder tensor have the SHA-256 of micro-sam's for eight synthetic images (uint8, uint16,
  float32; one to three channels; up- and downsampling, the vertical-first pass order, odd sizes,
  no resize).
- Browser (`e2e/workflow.spec.js`, production build, Chromium, WebAssembly): the embedding at 512
  fixed positions is within 9.8e-7 of PyTorch's, and all 24 masks have the SHA-256 of micro-sam's
  PyTorch masks (the test requires identical hashes; the IoU it also logs is a diagnostic).
  Clicking and boxing in the viewer reproduce the reference masks in the downloaded label TIFF.
  The hashes hold for the pinned ONNX Runtime Web 1.29.0 only: the export's mask logits differ
  from PyTorch's by up to 6.2e-4 and some pixels lie within 3.9e-5 of the threshold, so another
  ONNX Runtime version can flip them (AGENTS.md, "microsam", gives the procedure for a bump).
- Against the BBBC038 annotation the reference masks reach IoU 0.64-0.97 per prompt
  (`iou_annotation` in `validation/reference.json`). These IoUs are in-sample (the example is in
  the generalist's training data) and describe the prompts, not the model's accuracy.

The annotation is pinned on Hugging Face beside the example (`microsam/validation/`).

## Data and licences

- Model: micro-sam's "SAM LM Generalist (ViT-T)", BioImage.IO `faithful-chicken` 1.1
  (`vit_t.pt`, sha256 `32b92ab6…ec7b7a`), CC BY 4.0, by Anwai Archit, Constantin Pape and the
  micro-sam contributors; fine-tuned from MobileSAM (Apache-2.0), distilled from Segment Anything
  (Apache-2.0). The ONNX files are pinned in `models/microsam.manifest.json` with a README and the
  Apache-2.0 text on Hugging Face. They keep every weight except the trained attention biases,
  which the zero cache replaces (see "Attention biases"; the modification notice is in `NOTICE`).
- Example: BBBC038v1 (2018 Data Science Bowl) stage1_train sample `1023509c…`, a 360 × 360
  fluorescence image of 23 nuclei, CC0 1.0 (Caicedo et al., Nature Methods 2019); first channel
  of the greyscale PNG saved as TIFF (`validation/make_example.py`), README beside it on Hugging Face.
- Code: this app is MIT (`LICENSE`). It ports micro-sam (MIT) and Pillow's resampling (MIT-CMU);
  `NOTICE` holds the attributions and the model licence, `LICENSE-APACHE-2.0` the Apache-2.0 text
  for the traced MobileSAM and Segment Anything graphs, and the build ships all three at the app's root.

## Not in v1

- micro-sam's automatic instance segmentation (AMG/AIS decoders), tiling for large images, 3D,
  tracking, and the larger `vit_b_lm`/`vit_l_lm` models. `vit_t_lm` is the smallest model and
  runs on the CPU in about 6 s for the example.
- Mask input from the previous prediction (micro-sam's `segment_from_points` does not pass one either).
- Editing accepted masks by hand; the shared `nd-mask-editor` needs a NiiVue viewer.
- The TIFF reader is app-local; it should move to `@neurodesk/webapp-components/file-io/tiff`
  once that module reads 2D multi-sample pages.
