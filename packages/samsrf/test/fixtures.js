// Small files in the formats the readers take, written from scratch.

const encoder = new TextEncoder();

function concat(parts) {
  const out = new Uint8Array(parts.reduce((total, part) => total + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

function dataArray({ intent = 'NIFTI_INTENT_NONE', dataType = 'NIFTI_TYPE_FLOAT32', dims, values }) {
  const dimAttributes = dims.map((dim, axis) => `Dim${axis}="${dim}"`).join(' ');
  return [
    `<DataArray Intent="${intent}" DataType="${dataType}" ArrayIndexingOrder="RowMajorOrder"`,
    ` Dimensionality="${dims.length}" ${dimAttributes} Encoding="ASCII" Endian="LittleEndian">`,
    `<Data>${values.join(' ')}</Data>`,
    '</DataArray>',
  ].join('\n');
}

/** An ASCII GIFTI with one DataArray per entry of `arrays`. */
export function gifti(arrays) {
  const text = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    `<GIFTI Version="1.0" NumberOfDataArrays="${arrays.length}">`,
    ...arrays.map(dataArray),
    '</GIFTI>',
  ].join('\n');
  return encoder.encode(text);
}

/** A functional run: `courses[v]` is vertex v's time course; one DataArray per volume. */
export function giftiRun(courses) {
  const volumes = courses[0].length;
  const arrays = [];
  for (let volume = 0; volume < volumes; volume += 1) {
    arrays.push({ intent: 'NIFTI_INTENT_TIME_SERIES', dims: [courses.length], values: courses.map((course) => course[volume]) });
  }
  return gifti(arrays);
}

/** A GIFTI mesh from row-major vertex triples and face triples. */
export function giftiSurface(vertices, faces) {
  return gifti([
    { intent: 'NIFTI_INTENT_POINTSET', dims: [vertices.length / 3, 3], values: vertices },
    { intent: 'NIFTI_INTENT_TRIANGLE', dataType: 'NIFTI_TYPE_INT32', dims: [faces.length / 3, 3], values: faces },
  ]);
}

function bigEndian(values, write, width) {
  const view = new DataView(new ArrayBuffer(values.length * width));
  values.forEach((value, index) => write.call(view, index * width, value, false));
  return new Uint8Array(view.buffer);
}

function u24(value) {
  return Uint8Array.of((value >> 16) & 0xff, (value >> 8) & 0xff, value & 0xff);
}

/** A FreeSurfer triangle surface (`lh.white`). */
export function freeSurferSurface(vertices, faces) {
  return concat([
    u24(16777214),
    encoder.encode('created by fixtures on today\n\n'),
    bigEndian([vertices.length / 3, faces.length / 3], DataView.prototype.setInt32, 4),
    bigEndian(vertices, DataView.prototype.setFloat32, 4),
    bigEndian(faces, DataView.prototype.setInt32, 4),
  ]);
}

/** A FreeSurfer new-format curvature file (`lh.curv`, `lh.area`). */
export function freeSurferCurv(values, faces = 0) {
  return concat([
    u24(16777215),
    bigEndian([values.length, faces, 1], DataView.prototype.setInt32, 4),
    bigEndian(values, DataView.prototype.setFloat32, 4),
  ]);
}

const MI_INT8 = 1;
const MI_INT32 = 5;
const MI_UINT32 = 6;
const MI_DOUBLE = 9;
const MI_MATRIX = 14;
const MX_DOUBLE_CLASS = 6;

function element(kind, data) {
  const padded = Math.ceil(data.length / 8) * 8;
  const out = new Uint8Array(8 + padded);
  const view = new DataView(out.buffer);
  view.setUint32(0, kind, true);
  view.setUint32(4, data.length, true);
  out.set(data, 8);
  return out;
}

function littleEndian(values, TypedArray) {
  return new Uint8Array(TypedArray.from(values).buffer);
}

/** A MAT v5 file of double arrays: `{ name: { dims, data } }`, data column-major. */
export function matFile(variables) {
  const header = new Uint8Array(128).fill(0x20);
  header.set(encoder.encode('MATLAB 5.0 MAT-file'));
  header.fill(0, 116, 124);
  header.set([0x00, 0x01, 0x49, 0x4d], 124);
  const matrices = Object.entries(variables).map(([name, { dims, data }]) => element(MI_MATRIX, concat([
    element(MI_UINT32, littleEndian([MX_DOUBLE_CLASS, 0], Uint32Array)),
    element(MI_INT32, littleEndian(dims, Int32Array)),
    element(MI_INT8, encoder.encode(name)),
    element(MI_DOUBLE, littleEndian(data, Float64Array)),
  ])));
  return concat([header, ...matrices]);
}
