// ITK writes a .mat transform as MATLAB level 4 matrices: the transform parameters, then the
// fixed parameters (the centre of rotation). Works on bytes, so it runs in a browser too.

/**
 * @param {Uint8Array} bytes a .mat file such as antsRegistration's 0GenericAffine.mat
 * @returns {{ transform: string, parameters: number[], fixed: number[] }}
 */
export function readMatTransform(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const matrices = new Map();
  let offset = 0;
  while (offset < bytes.byteLength) {
    if (offset + 20 > bytes.byteLength) throw new Error("Truncated MATLAB matrix header.");
    const [type, rows, columns, imaginary, nameLength] = [0, 1, 2, 3, 4].map((i) => view.getInt32(offset + 4 * i, true));
    // Type is M*1000 + O*100 + P*10 + T: little-endian (M 0), full numeric matrix (T 0).
    if (type < 0 || type > 99 || type % 10 !== 0 || imaginary !== 0) throw new Error(`Unsupported MATLAB matrix type ${type}.`);
    const size = { 0: 8, 1: 4 }[Math.floor(type / 10)];
    if (!size) throw new Error(`Unsupported MATLAB precision in type ${type}.`);
    if (nameLength < 1) throw new Error("Invalid MATLAB matrix name length.");
    if (rows < 0 || columns < 0) throw new Error("Invalid MATLAB matrix dimensions.");
    if (nameLength > bytes.byteLength - offset - 20) throw new Error("Truncated MATLAB matrix name.");
    const start = offset + 20 + nameLength;
    if (bytes[start - 1] !== 0) throw new Error("Invalid MATLAB matrix name: expected a terminating NUL.");
    const name = new TextDecoder("latin1").decode(bytes.subarray(offset + 20, start - 1));
    const count = rows * columns;
    if (!Number.isSafeInteger(count) || count > Math.floor((bytes.byteLength - start) / size)) throw new Error(`Truncated MATLAB matrix ${name}.`);
    const values = [];
    for (let i = 0; i < count; i++) values.push(size === 8 ? view.getFloat64(start + 8 * i, true) : view.getFloat32(start + 4 * i, true));
    matrices.set(name, values);
    offset = start + count * size;
  }
  const fixed = matrices.get("fixed");
  const transform = [...matrices.keys()].find((name) => name !== "fixed");
  if (!transform || !fixed) throw new Error("Not an ITK transform file.");
  return { transform, parameters: matrices.get(transform), fixed };
}

/**
 * The inverse of readMatTransform: MATLAB level 4 double matrices, the parameters then `fixed`, as
 * ITK writes them. antsRegistration and --apply read the result like their own .mat files.
 * @param {{ transform: string, parameters: number[], fixed: number[] }} transform
 * @returns {Uint8Array}
 */
export function writeMatTransform({ transform, parameters, fixed }) {
  const matrices = [[transform, parameters], ["fixed", fixed]];
  const size = matrices.reduce((total, [name, values]) => total + 20 + name.length + 1 + 8 * values.length, 0);
  const bytes = new Uint8Array(size);
  const view = new DataView(bytes.buffer);
  let offset = 0;
  for (const [name, values] of matrices) {
    if (!/^[\x20-\x7e]+$/.test(name)) throw new Error(`Invalid MATLAB matrix name ${name}.`);
    if (!values.every(Number.isFinite)) throw new Error(`MATLAB matrix ${name} has a value that is not finite.`);
    // Type 0: little-endian full double matrix, one column, as ITK writes parameters.
    [0, values.length, 1, 0, name.length + 1].forEach((value, i) => view.setInt32(offset + 4 * i, value, true));
    offset += 20;
    for (let i = 0; i < name.length; i++) bytes[offset + i] = name.charCodeAt(i);
    offset += name.length + 1;
    for (const value of values) {
      view.setFloat64(offset, value, true);
      offset += 8;
    }
  }
  return bytes;
}
