// Glue for ./hmc.wasm (exes/dwi/hmc-wasm): a plain C ABI, no wasm-bindgen, as packages/noddi.
// Every typed-array view is taken again after an export call, because a call that grows the
// heap detaches the previous ArrayBuffer.
//
// A transform is { parameters, fixed }: ITK's 12 parameters (the 3x3 matrix row by row, then the
// translation) and its 3 fixed parameters (the centre), LPS, as antsRegistration writes them.
// A grid is { shape: [nx, ny, nz], affine }: the voxel-to-RAS matrix as 4 rows of 4 numbers.

/** The methods whose b0 rule, b-vector rule and motion columns the module applies. */
export const METHODS = Object.freeze({ nifreeze: 0, shoreline: 1 });

const TRANSFORM_VALUES = 15;
const MOTION_VALUES = 12;

// NIfTI datatype codes of the typed arrays advanced_clip takes.
const DATATYPES = new Map([
  [Uint8Array, 2],
  [Int16Array, 4],
  [Int32Array, 8],
  [Float32Array, 16],
  [Float64Array, 64],
  [Int8Array, 256],
  [Uint16Array, 512],
  [Uint32Array, 768],
]);

/** @param source a Response, a Promise of one, an ArrayBuffer/TypedArray or a WebAssembly.Module */
export async function loadHmc(source) {
  const wasm = await instantiate(await source);
  const decoder = new TextDecoder();
  const text = () => decoder.decode(new Uint8Array(wasm.memory.buffer, wasm.text_ptr(), wasm.text_len()).slice());

  /** Copies a typed array into module memory; returns its pointer and a function that frees it. */
  const copyIn = (values) => {
    const bytes = values.byteLength;
    const ptr = wasm.alloc(Math.max(bytes, 1));
    new Uint8Array(wasm.memory.buffer, ptr, bytes).set(new Uint8Array(values.buffer, values.byteOffset, bytes));
    return { ptr, free: () => wasm.dealloc(ptr, Math.max(bytes, 1)) };
  };
  const reserve = (bytes) => {
    const ptr = wasm.alloc(Math.max(bytes, 1));
    return { ptr, free: () => wasm.dealloc(ptr, Math.max(bytes, 1)) };
  };
  const withMemory = (parts, body) => {
    try {
      return body();
    } finally {
      for (const part of parts) part.free();
    }
  };

  const methodCode = (method) => {
    if (!Object.hasOwn(METHODS, method)) throw new Error(`Unknown head-motion method ${JSON.stringify(method)}: use nifreeze or shoreline.`);
    return METHODS[method];
  };
  const flatTransforms = (transforms) => {
    const flat = new Float64Array(TRANSFORM_VALUES * transforms.length);
    transforms.forEach(({ parameters, fixed }, i) => {
      if (parameters?.length !== 12 || fixed?.length !== 3) throw new Error(`Transform ${i} needs 12 parameters and 3 fixed parameters.`);
      flat.set(parameters, TRANSFORM_VALUES * i);
      flat.set(fixed, TRANSFORM_VALUES * i + 12);
    });
    return flat;
  };
  const flatAffine = (affine) => {
    const flat = new Float64Array(16);
    for (let i = 0; i < 4; i++) for (let j = 0; j < 4; j++) flat[4 * i + j] = affine[i][j];
    return flat;
  };
  const gridArrays = ({ shape, affine }) => {
    if (shape?.length !== 3 || !shape.every((n) => Number.isInteger(n) && n > 0)) throw new Error("A grid shape is three positive whole numbers (nx, ny, nz).");
    return [copyIn(Uint32Array.from(shape)), copyIn(flatAffine(affine))];
  };
  const gradientArrays = (bvals, bvecs) => {
    const n = bvals.length;
    if (bvecs.length !== 3 || bvecs.some((row) => row.length !== n)) throw new Error("bvecs must be three rows (x, y, z) with one value per volume.");
    const flat = new Float64Array(3 * n);
    for (let i = 0; i < n; i++) for (let axis = 0; axis < 3; axis++) flat[3 * i + axis] = bvecs[axis][i];
    return { n, bvals: copyIn(Float64Array.from(bvals)), bvecs: copyIn(flat) };
  };

  /** Reads a .mat transform file. @returns {{ parameters: number[], fixed: number[], precision: 'float'|'double' }} */
  function readMat(bytes) {
    const input = copyIn(bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes));
    const out = reserve(8 * TRANSFORM_VALUES);
    return withMemory([input, out], () => {
      const kind = wasm.mat_read(input.ptr, bytes.byteLength, out.ptr);
      if (kind === 0) throw new Error(text());
      const values = Array.from(new Float64Array(wasm.memory.buffer, out.ptr, TRANSFORM_VALUES));
      return { parameters: values.slice(0, 12), fixed: values.slice(12), precision: kind === 1 ? "float" : "double" };
    });
  }

  /** The .mat bytes of a transform, in float precision (as antsRegistration --float 1) unless told otherwise. */
  function writeMat(transform, { precision = "float" } = {}) {
    const input = copyIn(flatTransforms([transform]));
    return withMemory([input], () => {
      const length = wasm.mat_write(input.ptr, precision === "double" ? 1 : 0);
      return new Uint8Array(wasm.memory.buffer, wasm.bytes_ptr(), length).slice();
    });
  }

  /**
   * QSIPrep's get_ras_motion_params of each transform on `grid` (RAS+).
   * @returns {{ scale: number[], shear: number[], rotation: number[], translation: number[] }[]}
   */
  function motionParams(transforms, grid) {
    const flat = copyIn(flatTransforms(transforms));
    const out = reserve(8 * MOTION_VALUES * transforms.length);
    const [shape, affine] = gridArrays(grid);
    return withMemory([flat, out, shape, affine], () => {
      wasm.motion_params(flat.ptr, transforms.length, shape.ptr, affine.ptr, out.ptr);
      const values = new Float64Array(wasm.memory.buffer, out.ptr, MOTION_VALUES * transforms.length);
      return transforms.map((_, i) => {
        const row = Array.from(values.subarray(MOTION_VALUES * i, MOTION_VALUES * (i + 1)));
        return { scale: row.slice(0, 3), shear: row.slice(3, 6), rotation: row.slice(6, 9), translation: row.slice(9, 12) };
      });
    });
  }

  /** The motion TSV, one row per transform: rigid columns, then scale columns for "affine". */
  function motionTsv(transforms, grid, { columns = "rigid" } = {}) {
    const flat = copyIn(flatTransforms(transforms));
    const [shape, affine] = gridArrays(grid);
    return withMemory([flat, shape, affine], () => {
      wasm.motion_table(flat.ptr, transforms.length, shape.ptr, affine.ptr, columns === "affine" ? 1 : 0);
      return text();
    });
  }

  /** Whether each volume is a b0 under the method's rule. */
  function b0Flags(method, bvals, bvecs) {
    const code = methodCode(method);
    const g = gradientArrays(bvals, bvecs);
    const out = reserve(g.n);
    return withMemory([g.bvals, g.bvecs, out], () => {
      if (wasm.b0_flags(code, g.bvals.ptr, g.bvecs.ptr, g.n, out.ptr) !== 0) throw new Error(text());
      return Array.from(new Uint8Array(wasm.memory.buffer, out.ptr, g.n), (flag) => flag === 1);
    });
  }

  /**
   * Rotates the gradient table with one transform per volume by the method's rule. NiFreeze's
   * rule needs the image's voxel-to-RAS affine.
   * @returns {{ bvec: string, bval: string, b0: boolean[] }} the file texts and the b0 volumes
   */
  function rotateGradients(method, bvals, bvecs, transforms, imageAffine) {
    const code = methodCode(method);
    const g = gradientArrays(bvals, bvecs);
    if (transforms.length !== g.n) throw new Error(`There are ${transforms.length} transforms for ${g.n} volumes.`);
    const flat = copyIn(flatTransforms(transforms));
    const affine = copyIn(flatAffine(imageAffine));
    return withMemory([g.bvals, g.bvecs, flat, affine], () => {
      if (wasm.rotate_table(code, g.bvals.ptr, g.bvecs.ptr, g.n, flat.ptr, affine.ptr) !== 0) throw new Error(text());
      const result = JSON.parse(text());
      return { bvec: result.bvec, bval: result.bval, b0: result.b0.map((flag) => flag === 1) };
    });
  }

  const datatypeOf = (data) => {
    const code = DATATYPES.get(data?.constructor);
    if (!code) throw new Error(`advanced_clip does not take ${data?.constructor?.name ?? typeof data}.`);
    return code;
  };
  const clipShape = (data, dims) => {
    const [nx, ny, nz] = dims;
    if (nx * ny * nz !== data.length) throw new Error(`${data.length} values do not fill a ${dims.join("x")} volume.`);
    return [nz, ny, nx];
  };

  /**
   * NiFreeze's advanced_clip(data, inplace=True) on one volume (`dims` = [nx, ny, nz], NIfTI
   * order). A Float32Array or Float64Array is overwritten with the 0-255 map, as NiFreeze
   * overwrites a float array; an integer array is left unchanged.
   * @returns {{ input: 'float'|'integer', mutated: boolean, aMin: number, aMax: number }}
   */
  function advancedClipInPlace(data, dims) {
    const code = datatypeOf(data);
    const [nz, ny, nx] = clipShape(data, dims);
    const buffer = copyIn(data);
    return withMemory([buffer], () => {
      if (wasm.clip_in_place(code, buffer.ptr, nz, ny, nx) !== 0) throw new Error(text());
      const report = JSON.parse(text());
      if (report.mutated) data.set(new data.constructor(wasm.memory.buffer, buffer.ptr, data.length));
      return report;
    });
  }

  /** NiFreeze's advanced_clip(data) (inplace=False): the 0-255 map as an Int16Array. */
  function advancedClip(data, dims) {
    const code = datatypeOf(data);
    const [nz, ny, nx] = clipShape(data, dims);
    const buffer = copyIn(data);
    const out = reserve(2 * data.length);
    return withMemory([buffer, out], () => {
      if (wasm.clip_copy_i16(code, buffer.ptr, nz, ny, nx, out.ptr) !== 0) throw new Error(text());
      return new Int16Array(wasm.memory.buffer, out.ptr, data.length).slice();
    });
  }

  /** NiFreeze's model data, with the Rust split, float64 median, GP fit and data-mask rule. */
  function createNifreezeModel({ data, dims, frames, bvals, bvecs, mask, model = "gp" }) {
    const voxels = dims[0] * dims[1] * dims[2];
    if (!["gp", "trivial"].includes(model)) throw new Error("Use gp or trivial for NiFreeze.");
    if (dims.length !== 3 || !dims.every(n => Number.isInteger(n) && n > 0) || data.length !== voxels * frames || bvals.length !== frames) {
      throw new Error("NiFreeze data and gradients must fill the series grid.");
    }
    if (mask && mask.length !== voxels) throw new Error("The NiFreeze mask is not on the image grid.");
    const gradients = gradientArrays(bvals.map(Math.fround), bvecs.map(row => row.map(Math.fround)));
    const input = copyIn(data instanceof Float32Array ? data : Float32Array.from(data));
    const brain = copyIn(mask ? Uint8Array.from(mask, value => value ? 1 : 0) : new Uint8Array(voxels).fill(1));
    const metadata = withMemory([input, brain, gradients.bvals, gradients.bvecs], () => {
      if (wasm.nifreeze_init(input.ptr, ...dims, frames, gradients.bvals.ptr, gradients.bvecs.ptr, brain.ptr, model === "gp" ? 1 : 0) !== 0) throw new Error(text());
      return JSON.parse(text());
    });
    const bzero = reserve(8 * voxels);
    const registrationMask = reserve(voxels);
    const arrays = withMemory([bzero, registrationMask], () => {
      wasm.nifreeze_arrays(bzero.ptr, registrationMask.ptr);
      return {
        bzero: metadata.hasBzero ? new Float64Array(wasm.memory.buffer, bzero.ptr, voxels).slice() : null,
        mask: new Uint8Array(wasm.memory.buffer, registrationMask.ptr, voxels).slice(),
      };
    });
    let released = false;
    return {
      ...metadata, ...arrays,
      predict(index) {
        if (released) throw new Error("The NiFreeze model has been released.");
        if (!Number.isInteger(index) || index < 0 || index >= metadata.dwiVolumes.length) throw new Error("The prediction index is not a DWI volume.");
        const output = reserve(8 * voxels);
        return withMemory([output], () => {
          if (wasm.nifreeze_predict(index, output.ptr) !== 0) throw new Error(text());
          return { volume: new Float64Array(wasm.memory.buffer, output.ptr, voxels).slice(), fit: JSON.parse(text()) };
        });
      },
      release() {
        if (!released) wasm.nifreeze_release();
        released = true;
      },
    };
  }

  function nifreezeArguments(seed = 1234) {
    if (!Number.isInteger(seed) || seed < 1 || seed > 0x7fffffff) throw new Error("The NiFreeze seed must be a positive 32-bit signed integer.");
    wasm.nifreeze_registration_args(seed);
    return JSON.parse(text());
  }

  return { readMat, writeMat, motionParams, motionTsv, b0Flags, rotateGradients, advancedClipInPlace, advancedClip, createNifreezeModel, nifreezeArguments };
}

/** The identity transform about the origin. */
export const IDENTITY = Object.freeze({ parameters: Object.freeze([1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0]), fixed: Object.freeze([0, 0, 0]) });

async function instantiate(source) {
  if (source instanceof WebAssembly.Module) return (await WebAssembly.instantiate(source, {})).exports;
  const bytes = typeof Response !== "undefined" && source instanceof Response ? await source.arrayBuffer() : source;
  return (await WebAssembly.instantiate(bytes, {})).instance.exports;
}
