"""Build WebGPU-compatible float16 ONNX graphs from Raidionics-models v1.3.0-rc.

    python export_model.py <input model.onnx> <output.onnx> [--id <asset_id>]

Raidionics v1.3 AGU-Net models contain 3D ConvTranspose nodes with
kernel=[3,3,3], strides=[2,2,2], pads=[1,1,1,1,1,1], output_padding=[1,1,1].
ONNX Runtime Web's WebGPU backend does not support 3D ConvTranspose and rejects
asymmetric 3D Conv padding (and its graph optimizer fuses an explicit asymmetric
Pad back into Conv).

This script applies two verified transformations:
1. Rewrite each 3D ConvTranspose(k=3, s=2, p=1, op=1) as a bit-exact polyphase
   2x2x2 Conv with symmetric pads=[1,1,1,1,1,1], followed by Slice([1:D+1,
   1:H+1, 1:W+1]) and a 3D depth-to-space Reshape/Transpose/Reshape.
2. Store large float32 initializers (>=1024 elements) as float16 with a Cast to
   float32 in the graph, cutting download size while keeping float32 arithmetic.

Each step is checked against ONNX Runtime CPU on a random input tensor. Prints
one JSON summary line with digests, size, shape and float16 max logit change.
"""
import argparse
import hashlib
import json
import tempfile
from pathlib import Path

import numpy as np
import onnx
import onnxruntime as ort
from onnx import TensorProto, helper, numpy_helper, shape_inference


def sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def attr_value(node, name, default=None):
    for attr in node.attribute:
        if attr.name == name:
            return helper.get_attribute_value(attr)
    return default


def rewrite_conv_transpose_webgpu(model: onnx.ModelProto) -> onnx.ModelProto:
    model = shape_inference.infer_shapes(model)
    graph = model.graph
    initializers = {i.name: i for i in graph.initializer}
    shapes = {}
    for value in list(graph.input) + list(graph.value_info) + list(graph.output):
        shapes[value.name] = [d.dim_value for d in value.type.tensor_type.shape.dim]

    nodes = []
    for node in graph.node:
        if node.op_type != 'ConvTranspose':
            nodes.append(node)
            continue
        kernel = list(attr_value(node, 'kernel_shape'))
        strides = list(attr_value(node, 'strides'))
        pads = list(attr_value(node, 'pads'))
        output_padding = list(attr_value(node, 'output_padding', [0, 0, 0]))
        group = attr_value(node, 'group', 1)
        assert (
            kernel == [3, 3, 3]
            and strides == [2, 2, 2]
            and pads == [1, 1, 1, 1, 1, 1]
            and output_padding == [1, 1, 1]
            and group == 1
        ), f'Unsupported ConvTranspose config on {node.name}: {(kernel, strides, pads, output_padding, group)}'

        weight = numpy_helper.to_array(initializers[node.input[1]])  # [C_in, C_out, 3, 3, 3]
        bias = numpy_helper.to_array(initializers[node.input[2]]) if len(node.input) > 2 else None
        c_in, c_out = weight.shape[0], weight.shape[1]
        n, _, d, h, w = shapes[node.input[0]]

        # Polyphase decomposition: output y[2*i + p] reads x[i + o] with tap = 1 + p - 2*o in {0, 1, 2}.
        poly = np.zeros((c_out, 2, 2, 2, c_in, 2, 2, 2), dtype=np.float32)
        for p0 in (0, 1):
            for p1 in (0, 1):
                for p2 in (0, 1):
                    for o0 in (0, 1):
                        t0 = 1 + p0 - 2 * o0
                        if not (0 <= t0 <= 2):
                            continue
                        for o1 in (0, 1):
                            t1 = 1 + p1 - 2 * o1
                            if not (0 <= t1 <= 2):
                                continue
                            for o2 in (0, 1):
                                t2 = 1 + p2 - 2 * o2
                                if not (0 <= t2 <= 2):
                                    continue
                                poly[:, p0, p1, p2, :, o0, o1, o2] = weight[:, :, t0, t1, t2].T

        conv_weight = poly.reshape(c_out * 8, c_in, 2, 2, 2)
        name = node.name.strip('/').replace('/', '_')
        graph.initializer.extend([
            numpy_helper.from_array(conv_weight, name + '_w'),
            numpy_helper.from_array(np.array([1, 1, 1], np.int64), name + '_starts'),
            numpy_helper.from_array(np.array([d + 1, h + 1, w + 1], np.int64), name + '_ends'),
            numpy_helper.from_array(np.array([2, 3, 4], np.int64), name + '_axes'),
            numpy_helper.from_array(np.array([n, c_out, 2, 2, 2, d, h, w], np.int64), name + '_split'),
            numpy_helper.from_array(np.array([n, c_out, d * 2, h * 2, w * 2], np.int64), name + '_merge'),
        ])
        conv_inputs = [node.input[0], name + '_w']
        if bias is not None:
            graph.initializer.append(numpy_helper.from_array(np.repeat(bias, 8).astype(np.float32), name + '_b'))
            conv_inputs.append(name + '_b')

        nodes += [
            helper.make_node(
                'Conv',
                conv_inputs,
                [name + '_conv_out'],
                kernel_shape=[2, 2, 2],
                strides=[1, 1, 1],
                pads=[1, 1, 1, 1, 1, 1],
                name=name + '_conv',
            ),
            helper.make_node(
                'Slice',
                [name + '_conv_out', name + '_starts', name + '_ends', name + '_axes'],
                [name + '_sliced'],
                name=name + '_slice',
            ),
            helper.make_node(
                'Reshape',
                [name + '_sliced', name + '_split'],
                [name + '_split_out'],
                name=name + '_split',
            ),
            helper.make_node(
                'Transpose',
                [name + '_split_out'],
                [name + '_shuf_out'],
                perm=[0, 1, 5, 2, 6, 3, 7, 4],
                name=name + '_shuf',
            ),
            helper.make_node(
                'Reshape',
                [name + '_shuf_out', name + '_merge'],
                [node.output[0]],
                name=name + '_merge',
            ),
        ]
        graph.initializer.remove(initializers[node.input[1]])
        if bias is not None:
            graph.initializer.remove(initializers[node.input[2]])

    del graph.node[:]
    graph.node.extend(nodes)
    del graph.value_info[:]
    return model


def store_half_precision(model: onnx.ModelProto) -> onnx.ModelProto:
    graph = model.graph
    casts = []
    for initializer in list(graph.initializer):
        arr = numpy_helper.to_array(initializer)
        if arr.dtype != np.float32 or arr.size < 1024:
            continue
        half = numpy_helper.from_array(arr.astype(np.float16), initializer.name + '_f16')
        graph.initializer.remove(initializer)
        graph.initializer.append(half)
        casts.append(
            helper.make_node(
                'Cast',
                [half.name],
                [initializer.name],
                to=TensorProto.FLOAT,
                name=initializer.name + '_cast',
            )
        )
    for cast in reversed(casts):
        graph.node.insert(0, cast)
    return model


def run_logits(path: Path, shape: tuple[int, ...], threads: int = 4) -> np.ndarray:
    opts = ort.SessionOptions()
    opts.intra_op_num_threads = threads
    opts.inter_op_num_threads = 1
    x = np.random.default_rng(0).standard_normal(shape).astype(np.float32)
    sess = ort.InferenceSession(str(path), sess_options=opts, providers=['CPUExecutionProvider'])
    in_name = sess.get_inputs()[0].name
    return sess.run(None, {in_name: x})[0]


def main() -> None:
    parser = argparse.ArgumentParser(description='Convert Raidionics v1.3 ONNX to WebGPU-ready float16 storage')
    parser.add_argument('input', type=Path)
    parser.add_argument('output', type=Path)
    parser.add_argument('--id', default='')
    parser.add_argument('--threads', type=int, default=4)
    args = parser.parse_args()

    src_model = onnx.load(args.input)
    shape = tuple(d.dim_value for d in src_model.graph.input[0].type.tensor_type.shape.dim)
    reference = run_logits(args.input, shape, args.threads)

    with tempfile.TemporaryDirectory() as scratch:
        rewritten_path = Path(scratch) / 'rewritten.onnx'
        rewritten = rewrite_conv_transpose_webgpu(src_model)
        onnx.checker.check_model(rewritten)
        onnx.save(rewritten, rewritten_path)
        rewritten_logits = run_logits(rewritten_path, shape, args.threads)
        rewrite_diff = float(np.abs(rewritten_logits - reference).max())
        assert rewrite_diff < 5e-4 * max(1.0, float(np.abs(reference).max())), f'ConvTranspose rewrite drift {rewrite_diff}'

        fp16_model = store_half_precision(onnx.load(rewritten_path))
        onnx.checker.check_model(fp16_model)
        args.output.parent.mkdir(parents=True, exist_ok=True)
        onnx.save(fp16_model, args.output)

    fp16_logits = run_logits(args.output, shape, args.threads)
    fp16_diff = float(np.abs(fp16_logits - reference).max())
    print(json.dumps({
        'id': args.id or args.output.stem,
        'filename': args.output.name,
        'bytes': args.output.stat().st_size,
        'sha256': sha256(args.output),
        'source_sha256': sha256(args.input),
        'input_shape': list(shape),
        'rewrite_max_logit_change': round(rewrite_diff, 6),
        'float16_max_logit_change': round(fp16_diff, 5),
    }))


if __name__ == '__main__':
    main()
