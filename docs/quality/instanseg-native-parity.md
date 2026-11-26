# InstanSeg Browser ONNX Parity Evidence

This note records how `instanseg-brightfield-nuclei.onnx` in `models/instanseg.manifest.json` was
exported and validated against upstream `instanseg/instanseg` `v0.1.2` (`bc36594d68e555ebd940f5917a1ce0eed6048b15`)
with `brightfield_nuclei.zip` (`instanseg_models_v0.1.1`).

## Pinned sources

- **Upstream code:** `instanseg/instanseg` `v0.1.2` (`bc36594d68e555ebd940f5917a1ce0eed6048b15`, Apache-2.0)
- **Upstream weights:** `https://github.com/instanseg/instanseg/releases/download/instanseg_models_v0.1.1/brightfield_nuclei.zip` (SHA-256 `427aa9cfe961b6d0012e2abf6befc6a9f76398db5d28dc2302ad911327d1c448`, Apache-2.0)
- **Standalone container:** `vnmd/instanseg_0.1.2:20261125` (`linux/amd64` image digest `sha256:9191b6978ea544b19de03e440fe2b786ffac20906a8e36182329850fbe8cc142`, multi-arch tag digest `sha256:681fc877…`)
- **Exported ONNX asset:** `neurodeskorg/webapps@d92e42ac7515e9089de3c4996f61aa05af3cbee0/instanseg/models/instanseg-brightfield-nuclei.onnx` (`15,287,206` bytes, SHA-256 `62c392fef7f014a0f5847e839b37783f7a732f731136646705dd40ca5a696c46`, float32, opset 17: `Add`, `Concat`, `Constant`, `Conv`, `MaxPool`, `Relu`, `Resize`)
- **Example scan:** `neurodeskorg/webapps@d92e42ac7515e9089de3c4996f61aa05af3cbee0/instanseg/examples/he_brightfield_512.ome.tif` (`744,085` bytes, SHA-256 `5c03877e27e07ead98f5fac7bcc671c6b2a3687dfed8d754dfeff2f4ef7b006d`, `512 × 512`, `0.50008 µm/px` calibrated RGB OME-TIFF crop `[200:712, 200:712]` of upstream `HE_example.tif`, Apache-2.0)

## Reproducing the oracles and parity gate

Generate the upstream PyTorch TorchScript oracles from pinned `brightfield_nuclei.zip` and `HE_example.tif` (using upstream `instanseg.pt`, `_rescale_to_pixel_size`, and `_sliding_window_inference` at `window_size=(512, 512)`):

```bash
python3 packages/instanseg/validation/generate_oracles.py \
  --model-zip "$TMPDIR/brightfield_nuclei.zip" \
  --he-tiff "$TMPDIR/HE_example.tif" \
  --out-dir "$TMPDIR/instanseg-oracles"

node packages/instanseg/validation/parity.mjs \
  "$TMPDIR/instanseg-oracles/he_brightfield_512.ome.tif" \
  "$TMPDIR/instanseg-brightfield-nuclei.onnx" \
  "$TMPDIR/instanseg-oracles/oracle_512.npy"
```

## Single-tile, tiled, and non-integer pixel-size parity (`packages/instanseg/validation/parity.mjs`)

Executed with `@neurodesk/instanseg` + `onnxruntime-node` against upstream `instanseg.pt` (`brightfield_nuclei`), `_rescale_to_pixel_size`, and `_sliding_window_inference`:

| Dataset | Size, scale & tiling | Upstream nuclei | `@neurodesk/instanseg` nuclei | F1 @ IoU 0.50 | F1 @ IoU 0.90 | Mean matched IoU | Foreground Dice |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: |
| `he_brightfield_512.ome.tif` | `512 × 512`, `0.50008 µm/px` (1 tile) | 1,115 | 1,115 | **1.000000** | **1.000000** | **0.999996** | **0.999994** |
| `he_brightfield_768.ome.tif` | `768 × 768`, `0.50008 µm/px` (2 × 2 tiled) | 2,336 | 2,336 | **1.000000** | **1.000000** | **1.000000** | **1.000000** |
| `he_brightfield_501x499_033um.ome.tif` | `501 × 499`, `0.33 µm/px` (non-integer `0.66×` rescale, 1 tile) | 659 | 659 | **1.000000** | **1.000000** | **1.000000** | **1.000000** |

## Known tiling threshold difference vs Standalone CLI

Upstream `InstanSeg.eval()` runs images with fewer than `3 × 1500 × 1500` total values without tiling by default, whereas the browser app tiles images above the configured `tileSize` (default `512 × 512`, matching upstream `_sliding_window_inference`) to stay within WebGPU/WASM memory limits. On `he_brightfield_768.ome.tif`, upstream untiled vs upstream tiled (`512 × 512`) agrees at foreground Dice `0.99936`.
