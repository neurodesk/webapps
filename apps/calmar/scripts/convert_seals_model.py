#!/usr/bin/env python3
"""Convert DeepISLES' SEALS nnU-Net (ISLES'22 winner) fold 0 to ONNX.

Source: DeepISLES weights, Zenodo record 14026715 (Apache-2.0),
stroke_ensemble_weights.7z, md5 be5b6dfcd66b55c2e6dc6db9a5880f7f,
directory weights/SEALS/nnUNet_trained_models/nnUNet/3d_fullres/
Task012_Ischemic_Stroke_TM_Fullset/nnUNetTrainerV2_DDP__nnUNetPlansv2.1.
Code: github.com/Tabrisrei/ISLES22_Ensemble (src/SEALS carries nnU-Net v1).

Network: nnU-Net v1 Generic_UNet from plans.pkl. 2 input channels
(0 = DWI/TRACE, 1 = ADC), 2 output channels (background, lesion), 32 base
features, 5 pooling stages, 3^3 kernels, InstanceNorm + LeakyReLU, 31.2M
parameters. Exported at a static 1x2x128x128x128 patch (SEALS' patch size),
opset 17, deep supervision off. The fp16 copy keeps fp32 inputs and outputs.

Output: <out>/lnm-deepisles-seals-fold0-128.onnx (119 MB) and
<out>/lnm-deepisles-seals-fold0-128-fp16.onnx (59.5 MB).

Usage:
  7z x stroke_ensemble_weights.7z 'weights/SEALS/*/plans.pkl' \\
      'weights/SEALS/*/fold_0/model_final_checkpoint.model'
  pip install --extra-index-url https://download.pytorch.org/whl/cpu \\
      torch==2.4.1 onnx==1.17.0 onnxruntime==1.20.1 onnxconverter-common==1.14.0 batchgenerators==0.25
  python3 scripts/convert_seals_model.py --seals-src ISLES22_Ensemble/src/SEALS \\
      --trained weights/SEALS/nnUNet_trained_models/nnUNet/3d_fullres/Task012_Ischemic_Stroke_TM_Fullset/nnUNetTrainerV2_DDP__nnUNetPlansv2.1 \\
      --out out_dir

Validation: prints max |PyTorch - ORT| logits on a seeded random patch for
both files. Real-data parity against nnU-Net's own inference is
scripts/run_seals_onnx.py on the ADS example subjects (see README).
"""
from __future__ import annotations

import argparse
import hashlib
import os
import pickle
import sys
from pathlib import Path


def build(seals_src: Path, trained: Path, fold: int):
    sys.path.insert(0, str(seals_src))
    from torch import nn
    import torch
    from nnunet.network_architecture.generic_UNet import Generic_UNet
    from nnunet.network_architecture.initialization import InitWeights_He

    plans = pickle.load(open(trained / "plans.pkl", "rb"))
    stage = plans["plans_per_stage"][max(plans["plans_per_stage"])]
    net = Generic_UNet(
        plans["num_modalities"], plans["base_num_features"], plans["num_classes"] + 1,
        len(stage["pool_op_kernel_sizes"]), plans["conv_per_stage"], 2, nn.Conv3d, nn.InstanceNorm3d,
        {"eps": 1e-5, "affine": True}, nn.Dropout3d, {"p": 0, "inplace": True}, nn.LeakyReLU,
        {"negative_slope": 1e-2, "inplace": True}, True, False, lambda x: x, InitWeights_He(1e-2),
        stage["pool_op_kernel_sizes"], stage["conv_kernel_sizes"], False, True, True)
    checkpoint = torch.load(trained / f"fold_{fold}" / "model_final_checkpoint.model", map_location="cpu", weights_only=False)
    # Trained with DistributedDataParallel: strip its 'module.' prefix.
    net.load_state_dict({k.removeprefix("module."): v for k, v in checkpoint["state_dict"].items()})
    net.do_ds = False
    net.eval()
    return net, stage


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--seals-src", type=Path, required=True)
    parser.add_argument("--trained", type=Path, required=True)
    parser.add_argument("--out", type=Path, required=True)
    parser.add_argument("--fold", type=int, default=0)
    args = parser.parse_args()

    import numpy as np
    import onnx
    import onnxruntime as ort
    import torch
    from onnxconverter_common import float16

    net, stage = build(args.seals_src, args.trained, args.fold)
    assert list(stage["patch_size"]) == [128, 128, 128], stage["patch_size"]
    print(f"parameters: {sum(p.numel() for p in net.parameters())}")
    args.out.mkdir(parents=True, exist_ok=True)
    fp32 = args.out / f"lnm-deepisles-seals-fold{args.fold}-128.onnx"
    fp16 = args.out / f"lnm-deepisles-seals-fold{args.fold}-128-fp16.onnx"
    x = torch.randn(1, 2, 128, 128, 128, generator=torch.Generator().manual_seed(0))
    torch.onnx.export(net, x, str(fp32), input_names=["input"], output_names=["logits"],
                      opset_version=17, do_constant_folding=True, dynamo=False)
    onnx.save(float16.convert_float_to_float16(onnx.load(str(fp32)), keep_io_types=True), str(fp16))
    with torch.no_grad():
        reference = net(x).numpy()
    for path in (fp32, fp16):
        out = ort.InferenceSession(str(path), providers=["CPUExecutionProvider"]).run(None, {"input": x.numpy()})[0]
        digest = hashlib.sha256(path.read_bytes()).hexdigest()
        print(f"{path.name}: {os.path.getsize(path) / 2**20:.1f} MB, max |d| {np.abs(out - reference).max():.4f}, sha256 {digest}")


if __name__ == "__main__":
    main()
