#!/usr/bin/env python3
"""
Convert MuscleMap's PyTorch model to ONNX format.

Usage (from project root):
    python scripts/convert_model.py --checkpoint /path/to/model.pth
    python scripts/convert_model.py --checkpoint /path/to/model.pth --quantize
    python scripts/convert_model.py --checkpoint /path/to/model.pth --output web/models/musclemap-wholebody.onnx
    python scripts/convert_model.py --checkpoint /path/to/model.pth --out-channels 9 --roi-size 128 --num-res-units 2

Requires:
    pip install torch monai onnx onnxruntime

Input:  PyTorch .pth checkpoint (MONAI 2D UNet)
Output: ONNX model in web/models/
"""

import sys
import os
import argparse
import numpy as np

import torch
from monai.networks.nets import UNet


# ==================== Configuration ====================

PROJECT_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DEFAULT_OUTPUT_DIR = os.path.join(PROJECT_ROOT, "web", "models")

# MuscleMap model architecture (defaults for wholebody; overridden by CLI args)
MODEL_CONFIG = {
    "spatial_dims": 2,
    "in_channels": 1,
    "out_channels": 100,
    "channels": [64, 128, 256, 512, 1024],
    "strides": [2, 2, 2, 2],
    "num_res_units": 1,
    "act": "LeakyReLU",
    "norm": "instance",
}


# ==================== Conversion ====================

def load_model(checkpoint_path, config=None):
    """Load a MONAI UNet model from a PyTorch checkpoint."""
    cfg = config or MODEL_CONFIG
    model = UNet(**cfg)
    checkpoint = torch.load(checkpoint_path, map_location="cpu", weights_only=True)

    # Handle both raw state_dict and checkpoint dict formats
    if isinstance(checkpoint, dict) and "model_state_dict" in checkpoint:
        state_dict = checkpoint["model_state_dict"]
    elif isinstance(checkpoint, dict) and "state_dict" in checkpoint:
        state_dict = checkpoint["state_dict"]
    else:
        state_dict = checkpoint

    model.load_state_dict(state_dict)
    model.eval()
    return model


def export_to_onnx(model, output_path, roi_size=256, opset_version=17):
    """Export a PyTorch model to ONNX format."""
    # 2D input: [batch, channel, height, width]
    dummy_input = torch.randn(1, 1, roi_size, roi_size)

    torch.onnx.export(
        model,
        dummy_input,
        output_path,
        opset_version=opset_version,
        input_names=["input"],
        output_names=["output"],
        dynamic_axes={
            "input": {0: "batch", 2: "height", 3: "width"},
            "output": {0: "batch", 2: "height", 3: "width"},
        },
        dynamo=False,
    )
    print(f"  Exported ONNX: {output_path}")


def quantize_model(input_path, output_path):
    """Apply UINT8 dynamic quantization to an ONNX model."""
    from onnxruntime.quantization import quantize_dynamic, QuantType

    quantize_dynamic(
        input_path,
        output_path,
        weight_type=QuantType.QUInt8,
    )
    print(f"  Quantized: {output_path}")


def verify_model(onnx_path, pytorch_model=None, out_channels=100, roi_size=256):
    """Verify an ONNX model runs correctly and optionally compare to PyTorch."""
    import onnxruntime as ort

    session = ort.InferenceSession(onnx_path, providers=["CPUExecutionProvider"])
    dummy = np.random.randn(1, 1, roi_size, roi_size).astype(np.float32)
    result = session.run(None, {"input": dummy})
    output = result[0]
    print(f"  Verified: output shape {output.shape}, "
          f"range [{output.min():.3f}, {output.max():.3f}]")

    expected_shape = (1, out_channels, roi_size, roi_size)
    if output.shape != expected_shape:
        print(f"  WARNING: expected shape {expected_shape}, got {output.shape}")
        return False

    # Compare argmax with PyTorch if model provided
    if pytorch_model is not None:
        with torch.no_grad():
            pt_output = pytorch_model(torch.from_numpy(dummy)).numpy()
        pt_argmax = np.argmax(pt_output, axis=1)
        onnx_argmax = np.argmax(output, axis=1)
        match = np.mean(pt_argmax == onnx_argmax)
        print(f"  Argmax match vs PyTorch: {match * 100:.2f}%")
        if match < 0.99:
            print("  WARNING: argmax match below 99%")

    return True


def main():
    parser = argparse.ArgumentParser(description="Convert MuscleMap model to ONNX")
    parser.add_argument("--checkpoint", required=True, help="Path to PyTorch .pth checkpoint")
    parser.add_argument("--output", default=None, help="Output ONNX path (default: web/models/musclemap-wholebody.onnx)")
    parser.add_argument("--quantize", action="store_true", help="Apply UINT8 dynamic quantization")
    parser.add_argument("--out-channels", type=int, default=100, help="Number of output channels (default: 100)")
    parser.add_argument("--roi-size", type=int, default=256, help="ROI size for dummy input (default: 256)")
    parser.add_argument("--num-res-units", type=int, default=1, help="Number of residual units (default: 1)")
    args = parser.parse_args()

    if not os.path.exists(args.checkpoint):
        print(f"Checkpoint not found: {args.checkpoint}")
        sys.exit(1)

    os.makedirs(DEFAULT_OUTPUT_DIR, exist_ok=True)
    output_path = args.output or os.path.join(DEFAULT_OUTPUT_DIR, "musclemap-wholebody.onnx")

    # Build model config from CLI args
    config = {**MODEL_CONFIG, "out_channels": args.out_channels, "num_res_units": args.num_res_units}

    print(f"Checkpoint: {args.checkpoint}")
    print(f"Output: {output_path}")
    print(f"Quantize: {args.quantize}")
    print(f"Architecture: out_channels={args.out_channels}, roi_size={args.roi_size}, num_res_units={args.num_res_units}")

    # Load model
    print("\nLoading PyTorch model...")
    model = load_model(args.checkpoint, config)

    if args.quantize:
        fp32_path = output_path.replace(".onnx", "-fp32.onnx")
        print("Exporting to ONNX (FP32)...")
        export_to_onnx(model, fp32_path, roi_size=args.roi_size)

        print("Quantizing to UINT8...")
        quantize_model(fp32_path, output_path)

        # Cleanup
        os.remove(fp32_path)
        data_file = fp32_path + ".data"
        if os.path.exists(data_file):
            os.remove(data_file)
    else:
        print("Exporting to ONNX (FP32)...")
        export_to_onnx(model, output_path, roi_size=args.roi_size)

    # Verify
    print("Verifying model...")
    ok = verify_model(output_path, model, out_channels=args.out_channels, roi_size=args.roi_size)

    size_mb = os.path.getsize(output_path) / (1024 * 1024)
    print(f"\nSize: {size_mb:.1f} MB")
    if ok:
        print("SUCCESS")
    else:
        print("FAILED")
        sys.exit(1)


if __name__ == "__main__":
    main()
