// SPDX-License-Identifier: Apache-2.0 AND BSD-3-Clause
// SyN field fitting, separate from the GPL PyHySCO runtime in wasm.js.
const encodings = ['i', 'i-', 'j', 'j-', 'k', 'k-'];

/** Load the deterministic sdcflows field kernel. NIfTI stays with the caller. */
export async function loadFieldFit(source = new URL('./sdc-field-fit.wasm', import.meta.url)) {
  source = await source;
  if (source instanceof URL || typeof source === 'string') source = await fetch(source);
  if (source instanceof Response) {
    if (!source.ok) throw new Error(`Field-fit kernel: HTTP ${source.status}`);
    source = await source.arrayBuffer();
  }
  const instantiated = await WebAssembly.instantiate(source, {});
  const wasm = (instantiated instanceof WebAssembly.Instance ? instantiated : instantiated.instance).exports;
  const decoder = new TextDecoder();
  const result = () => new Float32Array(wasm.memory.buffer, wasm.result_ptr(), wasm.result_len()).slice();
  const check = status => {
    if (!status) throw new Error(decoder.decode(new Uint8Array(wasm.memory.buffer, wasm.error_ptr(), wasm.error_len())));
  };
  function memory(body) {
    const allocated = [];
    const copy = values => {
      const ptr = wasm.alloc(values.byteLength);
      if (!ptr) throw new Error('Not enough WebAssembly memory for the field fit');
      allocated.push([ptr, values.byteLength]);
      new Uint8Array(wasm.memory.buffer, ptr, values.byteLength).set(new Uint8Array(values.buffer, values.byteOffset, values.byteLength));
      return ptr;
    };
    try {
      return body(copy);
    } finally {
      for (const [ptr, bytes] of allocated) {
        wasm.dealloc(ptr, bytes);
      }
    }
  }
  function geometry(grid) {
    if (!Array.isArray(grid?.shape) || grid.shape.length !== 3 || !grid.shape.every(value => Number.isSafeInteger(value) && value > 0 && value <= 0xffffffff)) {
      throw new TypeError('A grid needs three positive integer dimensions');
    }
    const affine = Array.from(grid.affine ?? [], row => Array.from(row));
    if (affine.length !== 4 || !affine.every(row => row.length === 4 && row.every(Number.isFinite))) {
      throw new TypeError('A grid needs a finite 4 by 4 voxel-to-RAS affine');
    }
    return new Float64Array(affine.flat());
  }
  function process(kind, values, grid, acquisition) {
    const readout = kind === 2 ? 1 : acquisition?.readout;
    const phaseEncodingDirection = kind === 2 ? 'i' : acquisition?.phaseEncodingDirection;
    if (kind !== 2 && (typeof readout !== 'number' || !Number.isFinite(readout) || readout <= 0)) {
      throw new TypeError('Readout time must be supplied explicitly as finite positive seconds');
    }
    if (!(values instanceof Float32Array)) throw new TypeError('Field arrays must be Float32Array');
    const code = encodings.indexOf(phaseEncodingDirection);
    if (code < 0) throw new TypeError('Phase encoding must be i, i-, j, j-, k or k-');
    const affine = geometry(grid);
    return memory(copy => {
      const ptr = copy(values);
      const matrix = copy(affine);
      check(wasm.process(kind, ptr, values.length, ...grid.shape, matrix, readout, code));
      if (kind !== 2) return result();
      const metadata = new Float64Array(wasm.memory.buffer, wasm.grid_ptr(), 19).slice();
      return {
        field: result(),
        coefficients: new Float32Array(wasm.memory.buffer, wasm.coefficients_ptr(), wasm.coefficients_len()).slice(),
        grid: { shape: Array.from(metadata.slice(0, 3)), affine: Array.from({ length: 4 }, (_, i) => Array.from(metadata.slice(3 + 4 * i, 7 + 4 * i))) },
      };
    });
  }
  return {
    displacementToField: (values, grid, acquisition) => process(0, values, grid, acquisition),
    fieldToDisplacement: (values, grid, acquisition) => process(1, values, grid, acquisition),
    approximate: (values, grid) => process(2, values, grid),
    evaluate(coefficients, control, image) {
      if (!(coefficients instanceof Float32Array)) throw new TypeError('Coefficients must be Float32Array');
      const controlAffine = geometry(control);
      const imageAffine = geometry(image);
      return memory(copy => {
        const values = copy(coefficients);
        const controlMatrix = copy(controlAffine);
        const imageMatrix = copy(imageAffine);
        check(wasm.evaluate(values, coefficients.length, ...control.shape, controlMatrix, ...image.shape, imageMatrix));
        return result();
      });
    },
  };
}
