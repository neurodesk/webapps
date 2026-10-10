import { deformationShader } from './shader.js';
import { OPTIMIZER_SHADER } from '../gpu/shaders.js';

export async function createGPUDeformation(device, model, { microbatchSize = 32 } = {}) {
  if (!Number.isInteger(microbatchSize) || microbatchSize < 1) throw new Error('Invalid deformation microbatch size');
  const resources = [];
  const storage = GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC;
  const buffer = (size, usage, data) => {
    if (size > device.limits.maxBufferSize || ((usage & GPUBufferUsage.STORAGE) && size > device.limits.maxStorageBufferBindingSize)) throw new Error('Deformation buffer exceeds WebGPU limits');
    const value = device.createBuffer({ size: Math.max(4, size), usage });
    resources.push(value);
    if (data) device.queue.writeBuffer(value, 0, data);
    return value;
  };
  let disposed = false;
  let busy = false;
  let validGradients = false;
  let poisoned = null;
  device.lost.then(info => { poisoned = new Error(`Deformation GPU device lost: ${info.message}`); });
  const values = new Float32Array(model.count);
  model.parameters.forEach((p, i) => values.set(p.values, model.offsets[i]));
  if (!values.every(Number.isFinite)) throw new Error('Non-finite deformation parameters');
  let parameters, gradients, first, second, queries, io, failure, config, optimizerConfig, pipeline, bindings, optimizer, optimizerBindings;
  try {
    parameters = buffer(values.byteLength, storage, values);
    gradients = buffer(values.byteLength, storage);
    first = buffer(values.byteLength, storage);
    second = buffer(values.byteLength, storage);
    queries = buffer(microbatchSize * 16, storage);
    io = buffer(microbatchSize * 48, storage);
    failure = buffer(4, storage);
    config = buffer(16, GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST);
    optimizerConfig = buffer(16, GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST);
    const compile = async (code, entryPoint) => {
      const module = device.createShaderModule({ code });
      const errors = (await module.getCompilationInfo()).messages.filter(m => m.type === 'error');
      if (errors.length) throw new Error(errors.map(m => `${m.lineNum}: ${m.message}`).join('\n'));
      return device.createComputePipelineAsync({ layout: 'auto', compute: { module, entryPoint } });
    };
    pipeline = await compile(deformationShader(model), 'run');
    optimizer = await compile(OPTIMIZER_SHADER, 'step');
    const bind = (p, buffers) => device.createBindGroup({ layout: p.getBindGroupLayout(0), entries: buffers.map((b, binding) => ({ binding, resource: { buffer: b } })) });
    bindings = bind(pipeline, [parameters, gradients, queries, io, failure, config]);
    optimizerBindings = bind(optimizer, [parameters, gradients, first, second, optimizerConfig, failure]);
  } catch (error) {
    resources.forEach(r => r.destroy());
    throw error;
  }
  const read = async (source, bytes = source.size) => {
    const destination = device.createBuffer({ size: bytes, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
    try {
      const encoder = device.createCommandEncoder();
      encoder.copyBufferToBuffer(source, 0, destination, 0, bytes);
      device.queue.submit([encoder.finish()]);
      await destination.mapAsync(GPUMapMode.READ);
      const result = destination.getMappedRange().slice(0);
      destination.unmap();
      return result;
    } finally { destination.destroy(); }
  };
  const check = () => {
    if (disposed) throw new Error('Deformation engine disposed');
    if (poisoned) throw poisoned;
  };
  const exclusive = async fn => {
    check();
    if (busy) throw new Error('Concurrent deformation calls are unsupported');
    busy = true;
    device.pushErrorScope('validation');
    let result;
    let operationError;
    let failed = false;
    try {
      result = await fn();
    } catch (error) {
      failed = true;
      operationError = error;
    }
    try {
      const error = await device.popErrorScope();
      if (error) poisoned = new Error(error.message);
    } catch (error) {
      poisoned = error;
    } finally {
      busy = false;
    }
    // Scope failures poison future calls, but must not replace the operation's error.
    if (failed) throw operationError;
    if (poisoned) throw poisoned;
    return result;
  };
  const dispatch = (p, b, count, rows = 1) => {
    const encoder = device.createCommandEncoder();
    const pass = encoder.beginComputePass();
    pass.setPipeline(p);
    pass.setBindGroup(0, b);
    pass.dispatchWorkgroups(count, rows);
    pass.end();
    device.queue.submit([encoder.finish()]);
  };
  const split = values => model.parameters.map((p, i) => values.slice(model.offsets[i], model.offsets[i] + p.values.length));
  const compute = async ({ xyz, sliceIndices, xyzGradient, regularizationWeights }, backward, { accumulate = false, readGradients = false, signal } = {}) => {
    if (!(xyz instanceof Float32Array) || !(sliceIndices instanceof Uint32Array) || xyz.length !== 3 * sliceIndices.length || !sliceIndices.length || !xyz.every(Number.isFinite) || sliceIndices.some(s => s >= model.slices)) throw new Error('Invalid deformation queries');
    if (backward && (!(xyzGradient instanceof Float32Array) || xyzGradient.length !== xyz.length || !xyzGradient.every(Number.isFinite))) throw new Error('Invalid deformation cotangents');
    if (regularizationWeights && (!(regularizationWeights instanceof Float32Array) || regularizationWeights.length !== sliceIndices.length || !regularizationWeights.every(Number.isFinite))) throw new Error('Invalid deformation regularization weights');
    if (backward) {
      if (accumulate && !validGradients) throw new Error('No valid deformation gradients to accumulate');
      validGradients = false;
      if (!accumulate) {
        const encoder = device.createCommandEncoder();
        encoder.clearBuffer(gradients);
        device.queue.submit([encoder.finish()]);
      }
    }
    const result = { xyz: new Float32Array(xyz.length), regularization: new Float32Array(sliceIndices.length), xyzGradient: backward ? new Float32Array(xyz.length) : undefined };
    for (let start = 0; start < sliceIndices.length; start += microbatchSize) {
      signal?.throwIfAborted();
      check();
      const count = Math.min(microbatchSize, sliceIndices.length - start);
      const data = new ArrayBuffer(count * 16);
      const floats = new Float32Array(data);
      const integers = new Uint32Array(data);
      const input = new Float32Array(count * 12);
      for (let q = 0; q < count; q++) {
        floats.set(xyz.subarray((start + q) * 3, (start + q + 1) * 3), q * 4);
        integers[q * 4 + 3] = sliceIndices[start + q];
        if (backward) {
          input.set(xyzGradient.subarray((start + q) * 3, (start + q + 1) * 3), q * 12);
          input[q * 12 + 3] = regularizationWeights?.[start + q] ?? 0;
        }
      }
      device.queue.writeBuffer(queries, 0, data);
      device.queue.writeBuffer(io, 0, input);
      device.queue.writeBuffer(failure, 0, new Uint32Array([0]));
      device.queue.writeBuffer(config, 0, new Uint32Array([count, backward ? 1 : 0, 0, 0]));
      dispatch(pipeline, bindings, Math.ceil(count / 32));
      const output = new Float32Array(await read(io, count * 48));
      if (new Uint32Array(await read(failure))[0]) throw new Error('Non-finite deformation calculation');
      for (let q = 0; q < count; q++) {
        result.xyz.set(output.subarray(q * 12 + 4, q * 12 + 7), (start + q) * 3);
        result.regularization[start + q] = output[q * 12 + 7];
        if (backward) result.xyzGradient.set(output.subarray(q * 12 + 8, q * 12 + 11), (start + q) * 3);
      }
    }
    if (backward) {
      validGradients = true;
      if (readGradients) result.gradients = split(new Float32Array(await read(gradients)));
    }
    return result;
  };
  return {
    model,
    forward: (input, options) => exclusive(() => compute(input, false, options)),
    backward: (input, options) => exclusive(() => compute(input, true, options)),
    step: (step, learningRate = 0.005) => exclusive(async () => {
      if (!validGradients || !Number.isInteger(step) || step < 1 || !Number.isFinite(learningRate) || learningRate <= 0) throw new Error('Invalid deformation optimizer step');
      const data = new ArrayBuffer(16);
      new Uint32Array(data)[0] = model.count;
      new Float32Array(data).set([learningRate, 1 - 0.9 ** step, 1 - 0.99 ** step], 1);
      device.queue.writeBuffer(optimizerConfig, 0, data);
      device.queue.writeBuffer(failure, 0, new Uint32Array([0]));
      const groups = Math.ceil(model.count / 64);
      const width = Math.min(groups, device.limits.maxComputeWorkgroupsPerDimension);
      dispatch(optimizer, optimizerBindings, width, Math.ceil(groups / width));
      validGradients = false;
      if (new Uint32Array(await read(failure))[0]) { poisoned = new Error('Deformation optimizer produced non-finite values'); throw poisoned; }
    }),
    readParameters: () => exclusive(async () => split(new Float32Array(await read(parameters)))),
    dispose: () => {
      if (busy) throw new Error('Cannot dispose a running deformation engine');
      if (!disposed) resources.forEach(r => r.destroy());
      disposed = true;
    },
  };
}
