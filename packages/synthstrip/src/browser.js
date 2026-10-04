import model from './browser-model.json' with { type: 'json' };
import { createStreamedSession } from '@neurodesk/runtime-support/streamed-onnx';

export const WASM_IMPLEMENTATION = 'synthstrip-streamed-fp32-v1';
const same = (left, right) => left.join() === right.join();

export function planStripGraph(dims) {
  if (dims.length !== 3 || dims.some(value => !Number.isSafeInteger(value) || value < 64 || value % 64)) {
    throw new Error('SynthStrip dimensions must be positive multiples of 64.');
  }
  const shapes = new Map([[model.input, { channels: 1, dims: [...dims] }]]);
  const nodes = [];
  for (const source of model.nodes) {
    const node = { ...source };
    const input = shapes.get(node.inputs[0]);
    const attrs = node.attrs;
    const shape = { channels: input.channels, dims: [...input.dims] };
    if (node.op === 'Conv') {
      const [channels, inputChannels, ...kernel] = model.tensors[node.inputs[1]].dims;
      if (inputChannels !== input.channels || !same(kernel, [3, 3, 3]) ||
          !same(attrs.pads, [1, 1, 1, 1, 1, 1]) || !same(attrs.strides, [1, 1, 1]) ||
          !same(attrs.dilations, [1, 1, 1]) || attrs.group !== 1) {
        throw new Error(`Unsupported SynthStrip convolution: ${node.name}`);
      }
      shape.channels = channels;
      node.kernel = 3;
    } else if (node.op === 'MaxPool') {
      if (!same(attrs.kernel_shape, [2, 2, 2]) || !same(attrs.strides, [2, 2, 2]) ||
          !same(attrs.pads, [0, 0, 0, 0, 0, 0]) || !same(attrs.dilations, [1, 1, 1]) || attrs.ceil_mode !== 0) {
        throw new Error(`Unsupported SynthStrip pooling: ${node.name}`);
      }
      shape.dims = input.dims.map(value => value / 2);
    } else if (node.op === 'Resize') {
      const reference = shapes.get(node.resizeLike);
      if (!reference || !same(reference.dims, input.dims.map(value => value * 2)) ||
          attrs.mode !== 'nearest' || attrs.coordinate_transformation_mode !== 'asymmetric' ||
          attrs.nearest_mode !== 'floor') {
        throw new Error(`Unsupported SynthStrip resize: ${node.name}`);
      }
      shape.dims = [...reference.dims];
    } else if (node.op === 'Add') {
      const other = shapes.get(node.inputs[1]);
      if (!other || other.channels !== input.channels || !same(other.dims, input.dims)) {
        throw new Error(`SynthStrip Add shape mismatch: ${node.name}`);
      }
    } else if (node.op !== 'LeakyRelu') {
      throw new Error(`Unsupported SynthStrip operator: ${node.op}`);
    }
    node.inputShape = input;
    node.shape = shape;
    shapes.set(node.output, shape);
    nodes.push(node);
  }
  const output = shapes.get(model.output);
  if (output.channels !== 1 || !same(output.dims, dims)) {
    throw new Error('SynthStrip output does not match its input geometry.');
  }
  return nodes;
}

export function createBrowserSession(raw, dims, ort, options = {}) {
  return createStreamedSession(raw, dims, ort, {
    ...options,
    model,
    nodes: planStripGraph(dims),
    implementation: WASM_IMPLEMENTATION,
  });
}
