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
