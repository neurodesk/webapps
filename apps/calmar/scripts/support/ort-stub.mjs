// Stand-in for the ONNX Runtime Web bundle. Tests install the model behind
// it with `globalThis.__calmarOrt.create = async (modelBytes, options) =>
// session`, where a session is { inputNames, outputNames, run, release }.

export const env = { wasm: {} };

export class Tensor {
  constructor(type, data, dims) {
    this.type = type;
    this.data = data;
    this.dims = dims;
    this.disposed = false;
  }

  dispose() {
    this.disposed = true;
  }
}

export const InferenceSession = {
  async create(modelBytes, options) {
    const stub = globalThis.__calmarOrt;
    if (!stub || typeof stub.create !== 'function') {
      throw new Error('ort-stub: no model installed (set globalThis.__calmarOrt.create)');
    }
    return stub.create(modelBytes, options);
  }
};
