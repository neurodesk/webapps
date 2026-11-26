"""Build aurora-t1c-o_best.onnx from BrainLesion/AURORA weights v1.0.0 (Zenodo 10557069).

    python export_model.py <t1c-o_best.tar> <output.onnx>

Needs torch, monai, onnx, and onnxruntime.

Three graph rewrites, each checked against PyTorch on a random 192x192x32 patch:
1. Replace nn.Mish with x * tanh(softplus(x)) for opset 17 compatibility (0.000e+00 max diff).
2. Rewrite every 3D ConvTranspose (kernel == stride == 2, no padding) as a 1x1x1 Conv followed by
   Reshape/Transpose/Reshape depth-to-space so ONNX Runtime WebGPU executes natively with no CPU fallback.
3. Store convolution weights as float16 with Cast to float32 compute, halving download size to ~11.5 MB.
"""
import hashlib
import json
import sys
import tempfile
from pathlib import Path

import numpy as np
import onnx
import onnxruntime as ort
import torch
import torch.nn as nn
import torch.nn.functional as F
from monai.networks.nets import BasicUNet
from onnx import TensorProto, helper, numpy_helper, shape_inference

PATCH_SHAPE = (1, 1, 192, 192, 32)


class DecomposedMish(nn.Module):
    def forward(self, x):
        return x * torch.tanh(F.softplus(x))


def replace_mish(module):
    for name, child in list(module.named_children()):
        if isinstance(child, nn.Mish):
            setattr(module, name, DecomposedMish())
        else:
            replace_mish(child)


def sha256(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def load_aurora(checkpoint_path, decompose_mish=False):
    net = BasicUNet(
        spatial_dims=3,
        in_channels=1,
        out_channels=2,
        features=(32, 32, 64, 128, 256, 32),
        dropout=0.1,
        act="mish",
    )
    checkpoint = torch.load(str(checkpoint_path), map_location="cpu", weights_only=False)
    state = {k.replace("module.", ""): v for k, v in checkpoint["model_state"].items()}
    net.load_state_dict(state)
    net.eval()
    if decompose_mish:
        replace_mish(net)
    return net


def attribute(node, name):
    return next(helper.get_attribute_value(a) for a in node.attribute if a.name == name)


def replace_transposed_convolutions(model):
    model = shape_inference.infer_shapes(model)
    graph = model.graph
    initializers = {i.name: i for i in graph.initializer}
    shapes = {v.name: [d.dim_value for d in v.type.tensor_type.shape.dim] for v in graph.value_info}
    nodes = []
    for node in graph.node:
        if node.op_type != "ConvTranspose":
            nodes.append(node)
            continue
        kernel = attribute(node, "kernel_shape")
        assert kernel == attribute(node, "strides") and not any(attribute(node, "pads")) and attribute(node, "group") == 1, node.name
        weight = numpy_helper.to_array(initializers[node.input[1]])
        bias = numpy_helper.to_array(initializers[node.input[2]])
        inputs, outputs = weight.shape[:2]
        taps = int(np.prod(kernel))
        n, _, d, h, w = shapes[node.input[0]]
        name = node.name.strip("/").replace("/", "_")
        graph.initializer.extend([
            numpy_helper.from_array(weight.reshape(inputs, outputs * taps).T.reshape(outputs * taps, inputs, 1, 1, 1), name + "_weight"),
            numpy_helper.from_array(np.repeat(bias, taps), name + "_bias"),
            numpy_helper.from_array(np.array([n, outputs, *kernel, d, h, w], np.int64), name + "_split"),
            numpy_helper.from_array(np.array([n, outputs, d * kernel[0], h * kernel[1], w * kernel[2]], np.int64), name + "_merge"),
        ])
        nodes += [
            helper.make_node("Conv", [node.input[0], name + "_weight", name + "_bias"], [name + "_taps"], kernel_shape=[1, 1, 1], name=name + "_conv"),
            helper.make_node("Reshape", [name + "_taps", name + "_split"], [name + "_split_out"], name=name + "_split"),
            helper.make_node("Transpose", [name + "_split_out"], [name + "_shuffled"], perm=[0, 1, 5, 2, 6, 3, 7, 4], name=name + "_shuffle"),
            helper.make_node("Reshape", [name + "_shuffled", name + "_merge"], [node.output[0]], name=name + "_merge"),
        ]
        graph.initializer.remove(initializers[node.input[1]])
        graph.initializer.remove(initializers[node.input[2]])
    del graph.node[:]
    graph.node.extend(nodes)
    del graph.value_info[:]
    return model


def store_half_precision(model):
    graph = model.graph
    casts = []
    for initializer in list(graph.initializer):
        value = numpy_helper.to_array(initializer)
        if value.dtype != np.float32 or value.size < 1024:
            continue
        half = numpy_helper.from_array(value.astype(np.float16), initializer.name + "_f16")
        graph.initializer.remove(initializer)
        graph.initializer.append(half)
        casts.append(helper.make_node("Cast", [half.name], [initializer.name], to=TensorProto.FLOAT, name=initializer.name + "_cast"))
    for cast in reversed(casts):
        graph.node.insert(0, cast)
    return model


def run_ort(path, x):
    return ort.InferenceSession(str(path), providers=["CPUExecutionProvider"]).run(None, {"input": x})[0]


def main():
    checkpoint_path = Path(sys.argv[1])
    output_path = Path(sys.argv[2])
    x = np.random.default_rng(0).standard_normal(PATCH_SHAPE).astype(np.float32)

    net_orig = load_aurora(checkpoint_path, decompose_mish=False)
    net_dec = load_aurora(checkpoint_path, decompose_mish=True)
    with torch.no_grad():
        torch_logits = net_orig(torch.from_numpy(x)).numpy()
        dec_logits = net_dec(torch.from_numpy(x)).numpy()
    assert float(np.abs(torch_logits - dec_logits).max()) < 1e-5, "DecomposedMish diverged from nn.Mish"

    with tempfile.TemporaryDirectory() as scratch:
        raw = Path(scratch) / "raw.onnx"
        rewritten = Path(scratch) / "conv.onnx"
        torch.onnx.export(net_dec, torch.zeros(PATCH_SHAPE), str(raw), input_names=["input"], output_names=["logits"], opset_version=17, dynamo=False)
        ref_logits = run_ort(raw, x)
        assert float(np.abs(ref_logits - torch_logits).max()) < 5e-4 * float(np.abs(torch_logits).max())
        onnx.save(replace_transposed_convolutions(onnx.load(str(raw))), str(rewritten))
        conv_logits = run_ort(rewritten, x)
        assert float(np.abs(conv_logits - ref_logits).max()) < 5e-4 * float(np.abs(ref_logits).max())
        final_model = store_half_precision(onnx.load(str(rewritten)))
        onnx.checker.check_model(final_model)
        onnx.save(final_model, str(output_path))

    final_logits = run_ort(output_path, x)
    change = float(np.abs(final_logits - torch_logits).max())
    assert change < 5e-4 * float(np.abs(torch_logits).max())
    print(json.dumps({
        "id": "t1c-o_best",
        "filename": output_path.name,
        "bytes": output_path.stat().st_size,
        "sha256": sha256(output_path),
        "checkpoint_sha256": sha256(checkpoint_path),
        "float16_max_logit_change": round(change, 5),
        "ops": sorted({n.op_type for n in final_model.graph.node}),
    }))


if __name__ == "__main__":
    main()
