import { WasmActivation, activationUses, releaseConsumedActivations } from './activation.js';
const product = dims => dims.reduce((a, b) => a * b, 1);
const text = value => new TextEncoder().encode(value);
const concat = parts => {
    const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
    let offset = 0;
    for (const part of parts) {
        out.set(part, offset);
        offset += part.length;
    }
    return out;
};
const varint = value => {
    let n = BigInt.asUintN(64, BigInt(value));
    const bytes = [];
    do {
        bytes.push(Number(n & 127n) | (n > 127n ? 128 : 0));
        n >>= 7n;
    } while (n);
    return Uint8Array.from(bytes);
};
const integer = (field, value) => concat([varint(field * 8), varint(value)]);
const bytes = (field, value) => concat([varint(field * 8 + 2), varint(value.length), value]);
const string = (field, value) => bytes(field, text(value));
const float = (field, value) => {
    const raw = new Uint8Array(4);
    new DataView(raw.buffer).setFloat32(0, value, true);
    return concat([varint(field * 8 + 5), raw]);
};
function attribute(name, value, type) {
    const data = [string(1, name)];
    if (Array.isArray(value))
        data.push(integer(20, 7), ...value.map(v => integer(8, v)));
    else if (typeof value === 'string')
        data.push(integer(20, 3), string(4, value));
    else if (type === 1 || ['alpha', 'epsilon', 'momentum', 'cubic_coeff_a'].includes(name))
        data.push(integer(20, 1), float(2, value));
    else
        data.push(integer(20, 2), integer(3, value));
    return concat(data);
}
function tensorInfo(name, dims, type = 1) {
    const shape = dims.map(d => bytes(1, typeof d === 'string' ? string(2, d) : integer(1, d)));
    return concat([string(1, name), bytes(2, bytes(1, concat([integer(1, type), bytes(2, concat(shape))])))]);
}
export function layerModel(node, raw, model) {
    const initializerNames = node.inputs.filter(name => model.tensors[name]);
    const makeNode = (op, inputs, output, attrs = {}) => concat([
        ...inputs.map(name => string(1, name)), string(2, output), string(4, op),
        ...Object.entries(attrs).map(([name, value]) => bytes(5, attribute(name, value, node.attributeTypes?.[name]))),
    ]);
    const inputs = node.sizesInput ? [node.inputs[0], '', '', node.sizesInput] : node.inputs;
    const nodes = [makeNode(node.op, inputs, node.elu ? 'pre_elu' : node.output, node.attrs)];
    if (node.elu)
        nodes.push(makeNode('Elu', ['pre_elu'], node.output, { alpha: 1 }));
    const graph = concat([
        ...nodes.map(n => bytes(1, n)), string(2, node.name),
        ...initializerNames.map(name => {
            const t = model.tensors[name];
            if (t.protoOffset !== undefined)
                return bytes(5, raw.subarray(t.protoOffset, t.protoOffset + t.protoBytes));
            return bytes(5, concat([
                ...t.dims.map(d => integer(1, d)), integer(2, 1), string(8, name), bytes(9, raw.subarray(t.offset, t.offset + t.bytes)),
            ]));
        }),
        bytes(11, tensorInfo(node.inputs[0], [1, node.inputShape.channels, 'depth', ...node.inputShape.dims.slice(1)])),
        ...(node.sizesInput ? [bytes(11, tensorInfo(node.sizesInput, [5], 7))] : []),
        ...(node.op === 'Add' ? [bytes(11, tensorInfo(node.inputs[1], [1, node.inputShape.channels, 'depth', ...node.inputShape.dims.slice(1)]))] : []),
        bytes(12, tensorInfo(node.output, [1, node.shape.channels, 'output_depth', ...node.shape.dims.slice(1)])),
    ]);
    return concat([integer(1, 8), bytes(7, graph), bytes(8, integer(2, model.opset ?? 13))]);
}
export function slabPlan(node, maxElements = 8 * 1024 * 1024) {
    const [depth, height, width] = node.shape.dims, [inputDepth, ih, iw] = node.inputShape.dims;
    const scale = node.op === 'MaxPool' ? 2 : node.op === 'Resize' ? .5 : 1;
    const halo = node.op === 'Conv' ? Math.floor(node.kernel / 2) : 0;
    const alignment = node.op === 'Resize' ? 2 : 1;
    const perDepth = Math.max(height * width * node.shape.channels, ih * iw * node.inputShape.channels * scale);
    const step = Math.max(alignment, Math.floor((Math.floor(maxElements / perDepth) - 2 * halo) / alignment) * alignment);
    const slabs = [];
    for (let start = 0; start < depth; start += step) {
        const end = Math.min(depth, start + step), inputStart = Math.max(0, start * scale - halo), inputEnd = Math.min(inputDepth, end * scale + halo);
        slabs.push({ start, end, inputStart, inputEnd, outputOffset: halo ? start - inputStart : 0 });
    }
    return slabs;
}
function sliceChannels(source, shape, start, end) {
    const [depth, height, width] = shape.dims, plane = height * width, count = (end - start) * plane;
    const result = new Float32Array(shape.channels * count);
    for (let c = 0; c < shape.channels; c++)
        source.copyTo(result, c * depth * plane + start * plane, c * depth * plane + end * plane, c * count);
    return result;
}
export async function createStreamedSession(raw, dims, ort, { model, nodes, implementation, onProgress = () => { }, maxElements = 8 * 1024 * 1024 }) {
    raw = raw instanceof ArrayBuffer ? new Uint8Array(raw) : new Uint8Array(raw.buffer, raw.byteOffset, raw.byteLength);
    const digest = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', raw)), v => v.toString(16).padStart(2, '0')).join('');
    if (raw.byteLength !== model.bytes || digest !== model.sha256)
        throw new Error('CPU executor requires the validated model.');
    const sessions = [];
    const outputName = nodes.at(-1).output;
    const uses = activationUses(nodes, model.tensors);
    let released = false, running = false;
    try {
        for (const node of nodes)
            sessions.push(await ort.InferenceSession.create(layerModel(node, raw, model), {
                executionProviders: ['wasm'], graphOptimizationLevel: 'all', enableCpuMemArena: false, enableMemPattern: false,
            }));
    }
    catch (error) {
        await Promise.allSettled(sessions.map(s => s.release()));
        throw error;
    }
    return {
        inputNames: [model.input], outputNames: [model.output], implementation,
        async run(feeds) {
            if (released || running)
                throw new Error('CPU session is released or busy.');
            const input = feeds[model.input];
            if (input?.type !== 'float32' || input.dims.join() !== [1, 1, ...dims].join())
                throw new Error('CPU input does not match the session shape.');
            running = true;
            const activation = new Map();
            const remaining = new Map(uses);
            try {
                const inputData = await input.getData();
                if (inputData.length !== product(dims))
                    throw new Error('CPU input size mismatch.');
                activation.set(model.input, new WasmActivation(product(dims)));
                activation.get(model.input).set(inputData);
                for (let i = 0; i < nodes.length; i++) {
                    const node = nodes[i], session = sessions[i];
                    const target = new WasmActivation(product(node.shape.dims) * node.shape.channels);
                    activation.set(node.output, target);
                    onProgress(i + 1, nodes.length);
                    for (const slab of slabPlan(node, maxElements)) {
                        const chunk = sliceChannels(activation.get(node.inputs[0]), node.inputShape, slab.inputStart, slab.inputEnd);
                        const chunkDims = [1, node.inputShape.channels, slab.inputEnd - slab.inputStart, ...node.inputShape.dims.slice(1)];
                        const tensors = {};
                        let outputs;
                        try {
                            tensors[node.inputs[0]] = new ort.Tensor('float32', chunk, chunkDims);
                            if (node.op === 'Add' && node.inputs[1] !== node.inputs[0])
                                tensors[node.inputs[1]] = new ort.Tensor('float32', sliceChannels(activation.get(node.inputs[1]), node.inputShape, slab.inputStart, slab.inputEnd), chunkDims);
                            if (node.sizesInput) {
                                const sizes = [1, node.shape.channels, slab.end - slab.start, ...node.shape.dims.slice(1)];
                                tensors[node.sizesInput] = new ort.Tensor('int64', BigInt64Array.from(sizes, BigInt), [5]);
                            }
                            outputs = await session.run(tensors);
                            const result = outputs[node.output], values = await result.getData();
                            const [, , chunkDepth, height, width] = result.dims, plane = height * width;
                            if (height !== node.shape.dims[1] || width !== node.shape.dims[2] || result.dims[1] !== node.shape.channels || chunkDepth < slab.outputOffset + slab.end - slab.start)
                                throw new Error('CPU layer output shape mismatch.');
                            for (let c = 0; c < node.shape.channels; c++) {
                                const offset = (c * chunkDepth + slab.outputOffset) * plane;
                                target.set(values.subarray(offset, offset + (slab.end - slab.start) * plane), (c * node.shape.dims[0] + slab.start) * plane);
                            }
                        }
                        finally {
                            Object.values(tensors).forEach(t => t.dispose());
                            if (outputs)
                                Object.values(outputs).forEach(t => t.dispose());
                        }
                    }
                    releaseConsumedActivations(activation, remaining, node.inputs);
                }
                const result = new Float32Array(product(dims));
                activation.get(outputName).copyTo(result);
                return { [model.output]: { dims: [1, 1, ...dims], type: 'float32', getData: async () => result, dispose() { } } };
            }
            finally {
                activation.clear();
                running = false;
            }
        },
        async release() { if (!released) {
            released = true;
            await Promise.all(sessions.map(s => s.release()));
        } },
    };
}
