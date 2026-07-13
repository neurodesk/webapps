#!/usr/bin/env python3
"""Convert the SynthStroke baseline (MIT, MELBA 2025) safetensors weights
to ONNX for browser inference.

Source model:  liamchalcroft/synthstroke-baseline on Hugging Face (MIT).
                3D MONAI UNet, T1 input (1 channel), binary stroke output
                (2 channels: background, stroke).
Architecture:  channels=[32,64,128,256,320,320] strides=[2,2,2,2,2]
                act=PRELU norm=INSTANCE num_res_units=1
Trace shape:   1 x 1 x 128 x 128 x 128 (matches SynthStroke's
                DEFAULT_PATCH_SIZE; the browser worker sliding-windows
                anything bigger).

Output:
  /tmp/lnm_seg_onnx/lnm-stroke-lesion.onnx (~71 MB fp32, opset 17, weights
  inlined — `dynamo=False` legacy exporter so weights stay inside the
  single .onnx file).

Validation: max abs(torch_out - ort_out) printed; should be < 1e-2.

Usage (one-shot):
  pip install --user --extra-index-url https://download.pytorch.org/whl/cpu \\
      torch onnx onnxruntime safetensors monai huggingface_hub
  python3 scripts/convert_lesion_seg_model.py
  HF_TOKEN=... hf upload sbollmann/lnm-webapp-models /tmp/lnm_seg_onnx/lnm-stroke-lesion.onnx \\
      models/lnm-stroke-lesion.onnx --repo-type dataset

The exported model is then registered in web/models/manifest.json as the
'lnm-stroke-lesion' modelAsset.
"""
import hashlib
import json
import os
import sys

OUT_DIR = "/tmp/lnm_seg_onnx"
ONNX_PATH = os.path.join(OUT_DIR, "lnm-stroke-lesion.onnx")
PATCH = 128


def main():
    import torch
    from huggingface_hub import hf_hub_download
    from monai.networks.nets import UNet
    from safetensors.torch import load_file
    import numpy as np

    os.makedirs(OUT_DIR, exist_ok=True)
    sidecar = ONNX_PATH + ".data"
    if os.path.exists(sidecar):
        os.remove(sidecar)

    cfg_path = hf_hub_download(repo_id="liamchalcroft/synthstroke-baseline", filename="config.json")
    weights_path = hf_hub_download(repo_id="liamchalcroft/synthstroke-baseline", filename="model.safetensors")
    cfg = json.load(open(cfg_path))
    state = load_file(weights_path)
    print(f"Loaded weights: {weights_path}")
    print(f"  state_dict params: {sum(t.numel() for t in state.values())}")

    model = UNet(
        spatial_dims=cfg["spatial_dims"],
        in_channels=cfg["in_channels"],
        out_channels=cfg["out_channels"],
        channels=tuple(cfg["channels"]),
        strides=tuple(cfg["strides"]),
        kernel_size=cfg["kernel_size"],
        up_kernel_size=cfg["up_kernel_size"],
        num_res_units=cfg["num_res_units"],
        act=cfg["act"],
        norm=cfg["norm"],
        dropout=cfg["dropout"],
        bias=cfg["bias"],
        adn_ordering=cfg["adn_ordering"],
    )
    missing, unexpected = model.load_state_dict(state, strict=False)
    if missing or unexpected:
        print(f"  load_state_dict: missing={len(missing)} unexpected={len(unexpected)}")
        if missing[:5]:
            print(f"    missing keys (head): {missing[:5]}")
        if unexpected[:5]:
            print(f"    unexpected keys (head): {unexpected[:5]}")
    model.eval()

    torch.manual_seed(0)
    dummy = torch.randn(1, 1, PATCH, PATCH, PATCH)
    with torch.no_grad():
        torch_out = model(dummy)
    print(f"forward OK; output shape: {tuple(torch_out.shape)}")

    # Static patch size; dynamic axes complicate ORT's optimisation passes.
    # The browser sliding-window pipeline pads to a fixed patch anyway.
    # `dynamo=False` keeps weights inline in a single .onnx file.
    torch.onnx.export(
        model, dummy, ONNX_PATH,
        input_names=["input"], output_names=["logits"],
        opset_version=17, do_constant_folding=True,
        dynamo=False,
    )
    sz = os.path.getsize(ONNX_PATH)
    print(f"ONNX written: {ONNX_PATH}  ({sz/1024/1024:.1f} MB)")

    # Roundtrip parity check.
    import onnxruntime as ort_py
    sess = ort_py.InferenceSession(ONNX_PATH, providers=["CPUExecutionProvider"])
    ort_out = sess.run(None, {"input": dummy.numpy()})[0]
    diff_max = float(np.max(np.abs(torch_out.numpy() - ort_out)))
    diff_mean = float(np.mean(np.abs(torch_out.numpy() - ort_out)))
    print(f"max abs diff (torch vs ort): {diff_max:.6e}")
    print(f"mean abs diff:               {diff_mean:.6e}")
    if diff_max > 1e-2:
        print("ERROR: parity check failed (max diff > 1e-2)", file=sys.stderr)
        sys.exit(1)

    sha = hashlib.sha256(open(ONNX_PATH, "rb").read()).hexdigest()
    print(f"sha256: {sha}")


if __name__ == "__main__":
    main()
