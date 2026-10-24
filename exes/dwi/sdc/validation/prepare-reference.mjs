// NIfTI stays in the shared JavaScript reader; Rust tests consume Float32 arrays.
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { decodeNiftiBuffer, readNiftiFrames } from '../../../../packages/components/src/file-io/NiftiUtils.js';
const [source, destination] = process.argv.slice(2);
if (!source || !destination) {
  throw new Error('Usage: prepare-reference.mjs SDC_REFERENCE OUTPUT_DIRECTORY');
}
const prefix = 'runs/full-2mm-s1234-double-affine/work/sdc_ref/';
const files = {
  image: 'mask/sub-01_dir-AP_run-001_desc-meanb0_dwiref.nii',
  mask: 'mask/sub-01_dir-AP_run-001_desc-mindgrab_mask.nii.gz',
  sampling: `${prefix}syn_preprocessing_wf/sampling_ref/clipped_reference.nii.gz`,
  displacement: `${prefix}syn_sdc_wf/syn/fmap_syn0Warp.nii.gz`,
  extracted: `${prefix}syn_sdc_wf/extract_field/fmap_syn0Warp_Hz.nii.gz`,
  input: `${prefix}syn_sdc_wf/zooms_field/fmap_syn0Warp_Hz_trans.nii.gz`,
  coefficients: `${prefix}syn_sdc_wf/bs_filter/fmap_syn0Warp_Hz_trans_coeff000.nii.gz`,
  field: `${prefix}syn_sdc_wf/bs_filter/fmap_syn0Warp_Hz_trans_field.nii.gz`,
};
await mkdir(destination, { recursive: true });
const metadata = {};
for (const [name, path] of Object.entries(files)) {
  const bytes = await decodeNiftiBuffer(await readFile(join(source, path)));
  const volume = readNiftiFrames(bytes);
  let values = Float32Array.from(volume.data);
  const voxels = volume.dims.reduce((a, b) => a * b, 1);
  if (name === 'displacement') {
    values = new Float32Array(voxels * 3);
    for (let i = 0; i < voxels; i++) {
      for (let axis = 0; axis < 3; axis++) {
        values[3 * i + axis] = volume.data[axis * voxels + i];
      }
    }
  }
  metadata[name] = {
    shape: volume.dims,
    affine: Array.from(volume.header.affine, row => Array.from(row)),
    frames: volume.frames,
  };
  await writeFile(join(destination, `${name}.bin`), new Uint8Array(values.buffer));
}
const sidecar = JSON.parse(await readFile(join(source, 'input/sub-01_dir-AP_run-001_dwi.json')));
metadata.pe = sidecar.PhaseEncodingDirection;
metadata.readout = sidecar.TotalReadoutTime;
await writeFile(join(destination, 'metadata.json'), `${JSON.stringify(metadata, null, 2)}\n`);
console.log(JSON.stringify({
  destination: resolve(destination),
  grids: metadata,
  maximumCsrBytes: metadata.input.shape.reduce((a, b) => a * b, 1) * 64 * 8,
}));
