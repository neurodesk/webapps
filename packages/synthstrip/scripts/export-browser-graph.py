#!/usr/bin/env python3
"""Export image operators and exact initializer spans from the pinned browser ONNX."""
import argparse
from collections import Counter
import hashlib
import json
from pathlib import Path
import struct

EXPECTED_HASH = 'dc9e11999b58d7949d77ddf1b2ed2910df66f8725c078a6b46ae08b8ebcc2800'
IMAGE_OPS = {'Conv', 'LeakyRelu', 'MaxPool', 'Resize', 'Add'}


def require(condition, message):
    if not condition:
        raise ValueError(message)


def varint(blob, offset):
    value = shift = 0
    while True:
        byte = blob[offset]
        offset += 1
        value |= (byte & 127) << shift
        if byte < 128:
            return value, offset
        shift += 7


def fields(blob, start=0, end=None):
    end = len(blob) if end is None else end
    result = {}
    while start < end:
        tag, start = varint(blob, start)
        number, wire = tag >> 3, tag & 7
        if wire == 0:
            value, start = varint(blob, start)
        elif wire == 2:
            length, start = varint(blob, start)
            value = (start, start + length)
            start += length
        elif wire in (1, 5):
            length = 8 if wire == 1 else 4
            value = (start, start + length)
            start += length
        else:
            raise ValueError(f'Unsupported protobuf wire type {wire}')
        require(start <= end, 'Truncated protobuf field')
        result.setdefault(number, []).append(value)
    return result


def export(source):
    blob = source.read_bytes()
    digest = hashlib.sha256(blob).hexdigest()
    require(digest == EXPECTED_HASH, 'Unexpected SynthStrip browser model checksum')

    def payload(span):
        return blob[span[0]:span[1]]

    def text(span):
        return payload(span).decode('utf-8')

    def message(span):
        return fields(blob, *span)

    root = fields(blob)
    graph = message(root[7][0])
    opset = message(root[8][0])[2][0]
    tensors = {}
    for span in graph[5]:
        tensor = message(span)
        name = text(tensor[8][0])
        require(tensor[2] == [1], f'Non-float weight {name}')
        dims = tensor[1]
        require(all(isinstance(dim, int) for dim in dims), 'Packed weight dimensions unsupported')
        count = 1
        for dim in dims:
            count *= dim
        require(len(payload(tensor[9][0])) == count * 4, f'Invalid weight size {name}')
        tensors[name] = {'dims': dims, 'protoOffset': span[0], 'protoBytes': span[1] - span[0]}

    nodes = []
    constants = {}
    for span in graph[1]:
        source_node = message(span)
        attrs = {}
        types = {}
        for span in source_node.get(5, []):
            attr = message(span)
            name = text(attr[1][0])
            kind = attr[20][0]
            types[name] = kind
            if kind == 1:
                attrs[name] = struct.unpack('<f', payload(attr[2][0]))[0]
            elif kind == 2:
                attrs[name] = attr[3][0]
            elif kind == 3:
                attrs[name] = text(attr[4][0])
            elif kind == 7:
                attrs[name] = attr.get(8, [])
            elif kind == 4:
                tensor = message(attr[5][0])
                require(tensor[2] == [7], 'Shape constants must be int64')
                data = payload(tensor[9][0])
                values = list(struct.unpack('<' + 'q' * (len(data) // 8), data))
                attrs[name] = values if tensor.get(1) else values[0]
            else:
                raise ValueError(f'Unsupported ONNX attribute type {kind}')
        node = {
            'op': text(source_node[4][0]),
            'name': text(source_node[3][0]),
            'inputs': [text(value) for value in source_node.get(1, [])],
            'output': text(source_node[2][0]),
            'attrs': attrs,
            'attributeTypes': types,
        }
        require(len(source_node[2]) == 1, 'Only single-output operators are supported')
        nodes.append(node)
        if node['op'] == 'Constant':
            constants[node['output']] = attrs['value']

    by_output = {node['output']: node for node in nodes}

    def shape_value(name):
        if name in constants:
            return constants[name]
        node = by_output[name]
        inputs = node['inputs']
        attrs = node['attrs']
        op = node['op']
        if op == 'Shape':
            require(not attrs, 'Sliced Shape is unsupported')
            require(by_output[inputs[0]]['op'] in IMAGE_OPS, 'Shape must reference an image')
            return [(inputs[0], axis) for axis in range(5)]
        if op == 'Gather':
            require(attrs == {'axis': 0}, 'Unexpected shape Gather')
            index = shape_value(inputs[1])
            require(isinstance(index, int), 'Shape Gather index must be scalar')
            return shape_value(inputs[0])[index]
        if op == 'Unsqueeze':
            require(not attrs and shape_value(inputs[1]) == [0], 'Unexpected shape Unsqueeze')
            return [shape_value(inputs[0])]
        if op == 'Concat':
            require(attrs == {'axis': 0}, 'Unexpected shape Concat')
            return [value for name in inputs for value in shape_value(name)]
        if op == 'Cast':
            require(attrs == {'to': 7}, 'Shape Cast must preserve int64')
            return shape_value(inputs[0])
        if op == 'Slice':
            require(not attrs and len(inputs) == 4, 'Unexpected shape Slice')
            start, end, axes = [shape_value(name) for name in inputs[1:]]
            require(axes == [0] and len(start) == len(end) == 1, 'Unexpected shape Slice axes')
            return shape_value(inputs[0])[start[0]:end[0]]
        raise ValueError(f'Unsupported shape expression {op}')

    image_nodes = []
    for node in nodes:
        if node['op'] not in IMAGE_OPS:
            continue
        if node['op'] == 'Resize':
            source, roi, scales, sizes = node['inputs']
            require(not roi and not scales, 'Expected sizes-based Resize')
            value = shape_value(sizes)
            require(len(value) == 5 and value[:2] == [(source, 0), (source, 1)], 'Resize changed batch/channels')
            reference = value[2][0]
            require(value[2:] == [(reference, axis) for axis in (2, 3, 4)], 'Resize must use one skip geometry')
            attrs = node['attrs']
            require(attrs['mode'] == 'nearest' and attrs['coordinate_transformation_mode'] == 'asymmetric'
                    and attrs['nearest_mode'] == 'floor', 'Unexpected Resize sampling')
            node['inputs'] = [source]
            node['sizesInput'] = sizes
            node['resizeLike'] = reference
        image_nodes.append(node)
    require(Counter(node['op'] for node in image_nodes) == {
        'Conv': 33, 'LeakyRelu': 26, 'MaxPool': 6, 'Resize': 6, 'Add': 6,
    }, 'Unexpected image operator counts')
    require(len(nodes) - len(image_nodes) == 138, 'Unexpected shape graph')
    return {
        'sha256': digest,
        'bytes': len(blob),
        'opset': opset,
        'input': text(message(graph[11][0])[1][0]),
        'output': text(message(graph[12][0])[1][0]),
        'tensors': tensors,
        'nodes': image_nodes,
    }


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('source', type=Path)
    parser.add_argument('output', type=Path)
    args = parser.parse_args()
    args.output.write_text(json.dumps(export(args.source), indent=2) + '\n')
