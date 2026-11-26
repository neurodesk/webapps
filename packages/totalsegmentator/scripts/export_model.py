"""Build TotalSegmentator ONNX models from upstream nnU-Net v2 checkpoints.

    python export_model.py <extracted-dataset-dir> <model-id> <source-url> <output.onnx>

Needs torch, dynamic_network_architectures 0.3.1, onnx and onnxruntime.

Three steps, each verified against ONNX Runtime on a random patch:
1. Reconstruct the nnU-Net v2 PlainConvUNet from plans.json + dataset.json and load fold_0
   checkpoint weights without deep supervision.
2. Rewrite every ConvTranspose (kernel == stride, no padding) as a 1x1x1 Conv followed by
   depth-to-space so ONNX Runtime WebGPU runs 3D decoding natively.
3. Store convolution weights (>= 1024 elements) as float16 with a Cast to float32 in the graph,
   halving download size while keeping float32 arithmetic.

Prints one JSON object describing the model's plan, normalization properties, classes and digests.
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
from dynamic_network_architectures.architectures.unet import PlainConvUNet
from onnx import TensorProto, helper, numpy_helper, shape_inference


def sha256(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def resolve_config(plans, cfg_name):
    cfg = dict(plans['configurations'][cfg_name])
    if 'inherits_from' in cfg:
        base = resolve_config(plans, cfg['inherits_from'])
        base.update(cfg)
        base.pop('inherits_from', None)
        return base
    return cfg


def build(dataset_dir):
    plans_path = next(Path(dataset_dir).rglob('plans.json'))
    model_dir = plans_path.parent
    cfg_name = model_dir.name.split('__')[-1]
    plans = json.loads(plans_path.read_text())
    dataset = json.loads((model_dir / 'dataset.json').read_text())
    cfg = resolve_config(plans, cfg_name)

    strides = cfg['pool_op_kernel_sizes']
    n_stages = len(strides)
    base_features = cfg['UNet_base_num_features']
    max_features = cfg['unet_max_num_features']
    features = [min(base_features * (2 ** i), max_features) for i in range(n_stages)]

    # Labels are {name: index}; TotalSegmentator models are mutually exclusive classes 0..N-1.
    labels = {int(v): k for k, v in dataset['labels'].items()}
    num_classes = max(labels.keys()) + 1

    net = PlainConvUNet(
        input_channels=1,
        n_stages=n_stages,
        features_per_stage=features,
        conv_op=torch.nn.Conv3d,
        kernel_sizes=cfg['conv_kernel_sizes'],
        strides=strides,
        n_conv_per_stage=cfg['n_conv_per_stage_encoder'],
        num_classes=num_classes,
        n_conv_per_stage_decoder=cfg['n_conv_per_stage_decoder'],
        conv_bias=True,
        norm_op=torch.nn.InstanceNorm3d,
        norm_op_kwargs={'eps': 1e-5, 'affine': True},
        dropout_op=None,
        dropout_op_kwargs=None,
        nonlin=torch.nn.LeakyReLU,
        nonlin_kwargs={'inplace': True},
        deep_supervision=False,
    )

    checkpoint_path = model_dir / 'fold_0' / 'checkpoint_final.pth'
    checkpoint = torch.load(checkpoint_path, map_location='cpu', weights_only=False)
    net.load_state_dict(checkpoint['network_weights'])
    net.eval()

    norm_scheme = cfg['normalization_schemes'][0]
    intensity = plans['foreground_intensity_properties_per_channel']['0']
    plan = {
        'configuration': cfg_name,
        'network': 'PlainConvUNet',
        'patch': cfg['patch_size'],
        'spacing': cfg['spacing'],
        'transpose_forward': plans['transpose_forward'],
        'normalization': norm_scheme,
        'use_mask_for_norm': bool(cfg['use_mask_for_norm'][0]),
        'num_classes': num_classes,
        'mirror_axes': list(checkpoint['inference_allowed_mirroring_axes']) if checkpoint.get('inference_allowed_mirroring_axes') else [],
        'checkpoint_sha256': sha256(checkpoint_path),
    }
    if norm_scheme == 'CTNormalization':
        plan['ct_intensity'] = {
            'mean': intensity['mean'],
            'std': intensity['std'],
            'percentile_00_5': intensity['percentile_00_5'],
            'percentile_99_5': intensity['percentile_99_5'],
        }
    return net, plan


def attribute(node, name):
    return next(helper.get_attribute_value(a) for a in node.attribute if a.name == name)


def replace_transposed_convolutions(model):
    model = shape_inference.infer_shapes(model)
    graph = model.graph
    initializers = {i.name: i for i in graph.initializer}
    shapes = {v.name: [d.dim_value for d in v.type.tensor_type.shape.dim] for v in graph.value_info}
    nodes = []
    for node in graph.node:
        if node.op_type != 'ConvTranspose':
            nodes.append(node)
            continue
        kernel = attribute(node, 'kernel_shape')
        assert kernel == attribute(node, 'strides') and not any(attribute(node, 'pads')) and attribute(node, 'group') == 1, node.name
        weight = numpy_helper.to_array(initializers[node.input[1]])
        bias = numpy_helper.to_array(initializers[node.input[2]])
        inputs, outputs = weight.shape[:2]
        taps = int(np.prod(kernel))
        n, _, d, h, w = shapes[node.input[0]]
        name = node.name.strip('/').replace('/', '_')
        graph.initializer.extend([
            numpy_helper.from_array(weight.reshape(inputs, outputs * taps).T.reshape(outputs * taps, inputs, 1, 1, 1), name + '_weight'),
            numpy_helper.from_array(np.repeat(bias, taps), name + '_bias'),
            numpy_helper.from_array(np.array([n, outputs, *kernel, d, h, w], np.int64), name + '_split'),
            numpy_helper.from_array(np.array([n, outputs, d * kernel[0], h * kernel[1], w * kernel[2]], np.int64), name + '_merge'),
        ])
        nodes += [
            helper.make_node('Conv', [node.input[0], name + '_weight', name + '_bias'], [name + '_taps'], kernel_shape=[1, 1, 1], name=name + '_conv'),
            helper.make_node('Reshape', [name + '_taps', name + '_split'], [name + '_split_out'], name=name + '_split'),
            helper.make_node('Transpose', [name + '_split_out'], [name + '_shuffled'], perm=[0, 1, 5, 2, 6, 3, 7, 4], name=name + '_shuffle'),
            helper.make_node('Reshape', [name + '_shuffled', name + '_merge'], [node.output[0]], name=name + '_merge'),
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
        half = numpy_helper.from_array(value.astype(np.float16), initializer.name + '_f16')
        graph.initializer.remove(initializer)
        graph.initializer.append(half)
        casts.append(helper.make_node('Cast', [half.name], [initializer.name], to=TensorProto.FLOAT, name=initializer.name + '_cast'))
    for cast in reversed(casts):
        graph.node.insert(0, cast)
    return model


def close(a, b):
    return np.abs(a - b).max() < 5e-4 * np.abs(b).max()


def logits(path, shape):
    x = np.random.default_rng(0).standard_normal(shape).astype(np.float32)
    return ort.InferenceSession(str(path), providers=['CPUExecutionProvider']).run(None, {'input': x})[0]


def main():
    dataset_dir = Path(sys.argv[1])
    model_id = sys.argv[2]
    source_url = sys.argv[3]
    output = Path(sys.argv[4])

    net, plan = build(dataset_dir)
    shape = (1, 1, *plan['patch'])
    with tempfile.TemporaryDirectory() as scratch:
        exported = Path(scratch) / 'model.onnx'
        torch.onnx.export(net, torch.zeros(shape), exported, input_names=['input'], output_names=['logits'], opset_version=17, dynamo=False)
        with torch.no_grad():
            torch_logits = net(torch.from_numpy(np.random.default_rng(0).standard_normal(shape).astype(np.float32))).numpy()
        reference = logits(exported, shape)
        assert close(reference, torch_logits), f'{model_id}: ONNX export differs from torch'
        rewritten = Path(scratch) / 'model-conv.onnx'
        onnx.save(replace_transposed_convolutions(onnx.load(exported)), rewritten)
        assert close(logits(rewritten, shape), reference), f'{model_id}: ConvTranspose rewrite changed the output'
        model = store_half_precision(onnx.load(rewritten))
        onnx.checker.check_model(model)
        onnx.save(model, output)
    change = float(np.abs(logits(output, shape) - reference).max())
    entry = {
        'id': model_id,
        'filename': output.name,
        'bytes': output.stat().st_size,
        'sha256': sha256(output),
        'float16_max_logit_change': round(change, 5),
        'source_url': source_url,
        **plan,
    }
    print(json.dumps(entry))


if __name__ == '__main__':
    main()
