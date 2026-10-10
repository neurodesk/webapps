// CPU-only lifecycle fixture: no shader execution or numerical parity is implied.
export function fakeGpuDevice() {
  const popResults = [];
  const device = {
    limits: { maxBufferSize: 2 ** 30, maxStorageBufferBindingSize: 2 ** 30 },
    features: new Set(),
    lost: new Promise(() => {}),
    scopes: 0,
    popped: 0,
    popResults,
    queue: { writeBuffer() {}, submit() {} },
    addEventListener() {},
    destroy() {},
    pushErrorScope() { this.scopes++; },
    popErrorScope() {
      this.scopes--;
      this.popped++;
      const result = popResults.shift();
      if (result?.synchronousError) throw result.synchronousError;
      if (result instanceof Error) return Promise.reject(result);
      return Promise.resolve(result ?? null);
    },
    createBuffer({ size }) {
      return { size, destroy() {}, unmap() {}, async mapAsync() {}, getMappedRange() { return new ArrayBuffer(size); } };
    },
    createShaderModule() { return { async getCompilationInfo() { return { messages: [] }; } }; },
    async createComputePipelineAsync() { return { getBindGroupLayout() { return {}; } }; },
    createBindGroupLayout() { return {}; },
    createPipelineLayout() { return {}; },
    createBindGroup() { return {}; },
    createCommandEncoder() {
      return { copyBufferToBuffer() {}, clearBuffer() {}, finish() { return {}; } };
    },
  };
  return device;
}

export function installGpuConstants() {
  globalThis.GPUBufferUsage = { STORAGE: 1, COPY_DST: 2, COPY_SRC: 4, MAP_READ: 8, UNIFORM: 16 };
  globalThis.GPUShaderStage = { COMPUTE: 1 };
  globalThis.GPUMapMode = { READ: 1 };
}
