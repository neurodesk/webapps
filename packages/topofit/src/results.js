import { midSurface } from './patches.js';

const encoder = new TextEncoder();

export function writeFreeSurfer(vertices, faces, sourceName = 'topofit-web') {
  const stamp = encoder.encode(`created by ${sourceName}\n\n`);
  const volumeInfo = encoder.encode(
    'valid = 1  # volume info valid\n' +
      'filename = vol.nii\n' +
      'volume = 256 256 256\n' +
      'voxelsize = 1 1 1\n' +
      'xras   = -1 0 0\n' +
      'yras   = 0 0 -1\n' +
      'zras   = 0 1 0\n' +
      'cras   = 0 0 0\n',
  );
  const bytes = 3 + stamp.length + 8 + vertices.length * 4 + faces.length * 4 + 12 + volumeInfo.length;
  const buffer = new ArrayBuffer(bytes);
  const output = new Uint8Array(buffer);
  output.set([255, 255, 254]);
  output.set(stamp, 3);
  const view = new DataView(buffer);
  let offset = 3 + stamp.length;
  view.setInt32(offset, vertices.length / 3, false);
  view.setInt32(offset + 4, faces.length / 3, false);
  offset += 8;
  for (const value of vertices) {
    view.setFloat32(offset, value, false);
    offset += 4;
  }
  for (const value of faces) {
    view.setInt32(offset, value, false);
    offset += 4;
  }
  for (const value of [2, 0, 20]) {
    view.setInt32(offset, value, false);
    offset += 4;
  }
  output.set(volumeInfo, offset);
  return buffer;
}

export function readInt32Asset(bytes) {
  if (bytes.byteLength % 4) throw new Error('Invalid TopoFit integer asset.');
  const view = new DataView(bytes);
  const output = new Int32Array(bytes.byteLength / 4);
  for (let i = 0; i < output.length; i += 1) output[i] = view.getInt32(i * 4, true);
  return output;
}

export function readFloat32Asset(bytes) {
  if (bytes.byteLength % 4) throw new Error('Invalid TopoFit float asset.');
  const view = new DataView(bytes);
  const output = new Float32Array(bytes.byteLength / 4);
  for (let i = 0; i < output.length; i += 1) output[i] = view.getFloat32(i * 4, true);
  return output;
}

export function writeSurfaceFiles(vertices, faces) {
  return ['lh', 'rh'].flatMap((hemisphere) => {
    const surfaces = {
      white: vertices[`${hemisphere}.white`],
      mid: midSurface(vertices[`${hemisphere}.white`], vertices[`${hemisphere}.pial`]),
      pial: vertices[`${hemisphere}.pial`],
      registration: vertices[`${hemisphere}.registration`],
    };
    return Object.entries(surfaces).map(([surface, points]) => ({
      id: `${hemisphere}-${surface}`,
      name: `${hemisphere}.${surface === 'mid' ? 'mid.white' : surface}`,
      mediaType: 'application/vnd.freesurfer.surface',
      bytes: writeFreeSurfer(points, faces[hemisphere]),
    }));
  });
}

// FreeSurfer .annot with an embedded colour table (version -2), as nibabel's
// write_annot writes it. `table[i]` describes label value i; label 0 is written
// as annotation 0, which Freeview leaves uncoloured.
export function writeAnnotation(labels, table) {
  const names = table.map(({ name }) => encoder.encode(`${name}\0`));
  const tableName = encoder.encode('NOFILE\0');
  const tableBytes = names.reduce((sum, name) => sum + 24 + name.length, 0);
  const buffer = new ArrayBuffer(4 + labels.length * 8 + 16 + tableName.length + 4 + tableBytes);
  const view = new DataView(buffer);
  const bytes = new Uint8Array(buffer);
  let offset = 0;
  const write = (value) => {
    view.setInt32(offset, value, false);
    offset += 4;
  };
  const writeBytes = (value) => {
    write(value.length);
    bytes.set(value, offset);
    offset += value.length;
  };
  const colours = table.map(({ rgb }) => rgb[0] + rgb[1] * 256 + rgb[2] * 65536);
  write(labels.length);
  for (let vertex = 0; vertex < labels.length; vertex += 1) {
    if (labels[vertex] >= table.length) throw new Error(`Label ${labels[vertex]} has no colour.`);
    write(vertex);
    write(labels[vertex] ? colours[labels[vertex]] : 0);
  }
  write(1);
  write(-2);
  write(table.length);
  writeBytes(tableName);
  write(table.length);
  for (const [index, { rgb }] of table.entries()) {
    write(index);
    writeBytes(names[index]);
    for (const value of [...rgb, 0]) write(value);
  }
  return buffer;
}
