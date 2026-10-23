// Write a canonical Volume to an in-memory NIfTI-1 (single file, 'n+1'). This is
// only used to hand the volume to the NiiVue preview; it never touches the
// network and never downloads. Grayscale is written as float32, color as RGB24.

const HEADER = 348;
const VOX_OFFSET = 352;

export function volumeToNifti(vol) {
  const [d0, d1, d2] = vol.dims;
  const isColor = vol.channels === 3;
  const datatype = isColor ? 128 : 16; // RGB24 or FLOAT32
  const bitpix = isColor ? 24 : 32;
  const bytesPerVox = isColor ? 3 : 4;
  const nVox = d0 * d1 * d2;
  const buf = new ArrayBuffer(VOX_OFFSET + nVox * bytesPerVox);
  const view = new DataView(buf);
  const le = true;

  view.setInt32(0, HEADER, le);
  // dim[8]
  view.setInt16(40, 3, le);
  view.setInt16(42, d0, le);
  view.setInt16(44, d1, le);
  view.setInt16(46, d2, le);
  view.setInt16(48, 1, le);
  view.setInt16(50, 1, le);
  view.setInt16(52, 1, le);
  view.setInt16(54, 1, le);
  view.setInt16(70, datatype, le);
  view.setInt16(72, bitpix, le);

  const affine = vol.affine || defaultAffine(d0, d1, d2);
  const vox = voxelSizes(affine);
  view.setFloat32(76, 1, le); // pixdim[0] qfac
  view.setFloat32(80, vox[0], le);
  view.setFloat32(84, vox[1], le);
  view.setFloat32(88, vox[2], le);

  view.setFloat32(108, VOX_OFFSET, le);
  view.setFloat32(112, 1, le); // scl_slope
  view.setFloat32(116, 0, le); // scl_inter

  view.setInt16(252, 0, le);   // qform_code
  view.setInt16(254, 1, le);   // sform_code
  // srow rows 0,1,2
  for (let c = 0; c < 4; c++) view.setFloat32(280 + c * 4, affine[0 * 4 + c], le);
  for (let c = 0; c < 4; c++) view.setFloat32(296 + c * 4, affine[1 * 4 + c], le);
  for (let c = 0; c < 4; c++) view.setFloat32(312 + c * 4, affine[2 * 4 + c], le);

  // magic 'n+1\0'
  view.setUint8(344, 0x6e);
  view.setUint8(345, 0x2b);
  view.setUint8(346, 0x31);
  view.setUint8(347, 0x00);
  // extension flag (4 bytes) already zero.

  const data = vol.data;
  const [n1, n2] = [d1, d2];
  if (isColor) {
    const out = new Uint8Array(buf, VOX_OFFSET);
    let disk = 0;
    // NIfTI wants i-fastest; our data is [d0,d1,d2] C-order (d2 fastest).
    for (let k = 0; k < d2; k++) {
      for (let j = 0; j < d1; j++) {
        for (let i = 0; i < d0; i++) {
          const src = ((i * n1 + j) * n2 + k) * 3;
          out[disk++] = data[src];
          out[disk++] = data[src + 1];
          out[disk++] = data[src + 2];
        }
      }
    }
  } else {
    const out = new Float32Array(buf, VOX_OFFSET);
    let disk = 0;
    for (let k = 0; k < d2; k++) {
      for (let j = 0; j < d1; j++) {
        for (let i = 0; i < d0; i++) {
          out[disk++] = data[(i * n1 + j) * n2 + k];
        }
      }
    }
  }

  return buf;
}

function voxelSizes(affine) {
  const col = (c) => Math.hypot(affine[c], affine[4 + c], affine[8 + c]);
  return [col(0) || 1, col(1) || 1, col(2) || 1];
}

function defaultAffine(d0, d1, d2) {
  return Float64Array.from([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
}
