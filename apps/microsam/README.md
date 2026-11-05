# micro-sam

Interactive 2D segmentation of light-microscopy images with Segment Anything for Microscopy
(micro-sam; Archit et al., Nature Methods 2025). The app computes the image embedding once with
micro-sam's light-microscopy generalist ViT-T model (`vit_t_lm`), then runs the prompt decoder for
every positive or negative click and every box. Accepted objects form a label image (uncompressed
16- or 32-bit TIFF) and a per-object CSV table (`id, area_px, centroid_x, centroid_y, bbox_x0,
bbox_y0, bbox_x1, bbox_y1, mean_intensity` (or one mean per colour channel), `predicted_iou,
prompt`). Input is one TIFF, OME-TIFF, ImageJ TIFF or PNG image of up to 16 megapixels.

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

TinyViT caches its attention biases in `Attention.ab` whenever `train(False)` runs. MobileSAM's
builder calls `eval()` before micro-sam loads the checkpoint, and `get_sam_model` does not call it
again, so micro-sam's PyTorch inference runs with the cache computed from the initial biases, which
are zeros (measured: `max |ab| = 0` on the loaded model). `validation/export_onnx.py` exports the model in
exactly that state (`TrainingMode.PRESERVE`, no `eval()`), so the app reproduces what micro-sam
users get. On the example, refreshing the cache with `eval()` gave mean IoU against the annotation
of 0.927 (box prompts, 23 nuclei) and 0.837 (one click) against 0.930 and 0.846 for micro-sam's
runtime state. Whether the trained biases were meant to be used is not established here.

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
  PyTorch masks (the test requires the hashes and IoU >= 0.99). Clicking and boxing in the viewer
  reproduce the reference masks in the downloaded label TIFF.
- Against the BBBC038 annotation the reference masks reach IoU 0.64-0.97 per prompt
  (`iou_annotation` in `validation/reference.json`); a negative click on a neighbouring nucleus
  lowers the IoU of five of the six nuclei below the single click's.

The annotation is pinned on Hugging Face beside the example (`microsam/validation/`).

## Data and licences

- Model: micro-sam's "SAM LM Generalist (ViT-T)", BioImage.IO `faithful-chicken` 1.1
  (`vit_t.pt`, sha256 `32b92ab6…ec7b7a`), CC BY 4.0, by Anwai Archit, Constantin Pape and the
  micro-sam contributors; fine-tuned from MobileSAM (Apache-2.0), distilled from Segment Anything
  (Apache-2.0). The ONNX files, with unchanged weights, are pinned in
  `models/microsam.manifest.json` with a README on Hugging Face.
- Example: BBBC038v1 (2018 Data Science Bowl) stage1_train sample `1023509c…`, a 360 × 360
  fluorescence image of 23 nuclei, CC0 1.0 (Caicedo et al., Nature Methods 2019); first channel
  of the greyscale PNG saved as TIFF (`validation/make_example.py`), README beside it on Hugging Face.
- Code: this app is MIT (`LICENSE`). It ports micro-sam (MIT) and Pillow's resampling (MIT-CMU);
  `NOTICE` holds the attributions and the model licence, and the build ships both at the app's root.

## Not in v1

- micro-sam's automatic instance segmentation (AMG/AIS decoders), tiling for large images, 3D,
  tracking, and the larger `vit_b_lm`/`vit_l_lm` models. `vit_t_lm` is the smallest model and
  runs on the CPU in about 6 s for the example.
- Mask input from the previous prediction (micro-sam's `segment_from_points` does not pass one either).
- Editing accepted masks by hand; the shared `nd-mask-editor` needs a NiiVue viewer.
- The TIFF reader is app-local; it should move to `@neurodesk/webapp-components/file-io/tiff`
  once that module reads 2D multi-sample pages.
