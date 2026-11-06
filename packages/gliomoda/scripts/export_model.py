"""Build gliomoda-<model>.onnx from the GlioMODA weights v1.0.2.

    python export_model.py <weights_v1.0.2 directory> <model> <output.onnx>

<model> is a folder of the weights archive, such as t1c-t2f-t1n-t2w or t1c-t2f-t1n-t2w_ResEncL.
Needs torch, dynamic_network_architectures 0.3.1 (the version nnU-Net 2.5.2 in the GlioMODA
container resolves), onnx and onnxruntime.

Three steps, each checked against ONNX Runtime on a random patch:
1. Export the fold_all network at the plans' patch size, without deep supervision, built from the
   plans' architecture the way nnU-Net's get_network_from_plans builds it.
2. Rewrite every ConvTranspose (kernel == stride, no padding) as a 1x1x1 Conv followed by
   depth-to-space. ONNX Runtime's WebGPU backend runs 3D Conv but not 3D ConvTranspose.
3. Store the convolution weights as float16 with a Cast to float32 in the graph. The download
   halves; arithmetic stays float32.

Prints one JSON line with the model's plan (channels, patch, mirroring axes, regions) and digests,
which models/gliomoda.manifest.json records.
"""
import hashlib, json, pydoc, sys, tempfile
from pathlib import Path

import numpy as np, onnx, onnxruntime as ort, torch
from onnx import helper, numpy_helper, shape_inference, TensorProto


def sha256(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def build(root):
    plans = json.loads((root / 'plans.json').read_text())['configurations']['3d_fullres']
    dataset = json.loads((root / 'dataset.json').read_text())
    architecture = plans['architecture']
    kwargs = dict(architecture['arch_kwargs'])
    for key in architecture['_kw_requires_import']:
        if kwargs[key] is not None:
            kwargs[key] = pydoc.locate(kwargs[key])
    network_class = pydoc.locate(architecture['network_class_name'])
    channels = list(dataset['channel_names'].values())
    regions = dataset['regions_class_order']
    net = network_class(input_channels=len(channels), num_classes=len(regions), deep_supervision=False, **kwargs)
    checkpoint_path = root / 'fold_all' / 'checkpoint_final.pth'
    checkpoint = torch.load(checkpoint_path, map_location='cpu', weights_only=False)
    net.load_state_dict(checkpoint['network_weights'])
    net.eval()
    plan = {
        'channels': channels,
        'patch': plans['patch_size'],
        'spacing': plans['spacing'],
        'transpose_forward': json.loads((root / 'plans.json').read_text())['transpose_forward'],
        'normalization': plans['normalization_schemes'],
        'use_mask_for_norm': plans['use_mask_for_norm'],
        'mirror_axes': list(checkpoint['inference_allowed_mirroring_axes']),
        'regions': [dataset['labels'][name] for name in ('whole tumor', 'tumor core', 'enhancing tumor')],
        'regions_class_order': regions,
        'network': architecture['network_class_name'].split('.')[-1],
        'checkpoint_sha256': sha256(checkpoint_path),
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


# Float32 rounding between runtimes, relative to logits that reach 30 to 40 on a random patch.
# The plain networks stay under 1e-4; the deeper ResEncL reaches 1.5e-4 with no sign change.
def close(a, b):
    return np.abs(a - b).max() < 5e-4 * np.abs(b).max()


def logits(path, shape):
    x = np.random.default_rng(0).standard_normal(shape).astype(np.float32)
    return ort.InferenceSession(str(path)).run(None, {'input': x})[0]


def main():
    root = Path(sys.argv[1]) / sys.argv[2]
    output = Path(sys.argv[3])
    net, plan = build(root)
    shape = (1, len(plan['channels']), *plan['patch'])
    with tempfile.TemporaryDirectory() as scratch:
        exported = Path(scratch) / 'model.onnx'
        torch.onnx.export(net, torch.zeros(shape), exported, input_names=['input'], output_names=['logits'], opset_version=17, dynamo=False)
        with torch.no_grad():
            torch_logits = net(torch.from_numpy(np.random.default_rng(0).standard_normal(shape).astype(np.float32))).numpy()
        reference = logits(exported, shape)
        assert close(reference, torch_logits), 'ONNX export differs from torch'
        rewritten = Path(scratch) / 'model-conv.onnx'
        onnx.save(replace_transposed_convolutions(onnx.load(exported)), rewritten)
        assert close(logits(rewritten, shape), reference), 'ConvTranspose rewrite changed the output'
        model = store_half_precision(onnx.load(rewritten))
        onnx.checker.check_model(model)
        onnx.save(model, output)
    change = float(np.abs(logits(output, shape) - reference).max())
    print(json.dumps({'model': sys.argv[2], 'filename': output.name, 'bytes': output.stat().st_size, 'sha256': sha256(output), 'float16_max_logit_change': round(change, 5), **plan}))


if __name__ == '__main__':
    main()
