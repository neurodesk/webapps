// Compares the port's slice images with a reference run's slices.json:
// the PNG grey channel med2image wrote and the 224 x 224 image after resize.
//   node validation/compare-slices.mjs <T1w.nii.gz> <slices.json>
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { cropToForeground, extractSlice, greyscale, readVolume, resizeBilinear } from '../src/slices.js';

const [niftiPath, referencePath] = process.argv.slice(2);
const reference = JSON.parse(await readFile(referencePath, 'utf8'));
const volume = cropToForeground(await readVolume(await readFile(niftiPath)));
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');
let png = 0;
let resized = 0;
for (const s of reference.slices) {
  const { rows, cols, values } = extractSlice(volume, s.axis, s.slice);
  if (rows !== s.shape[0] || cols !== s.shape[1]) throw new Error(`${s.axis}${s.slice}: shape ${rows}x${cols}, reference ${s.shape}`);
  const grey = greyscale(values, volume.precision);
  if (sha(grey) !== s.png_gray_sha256) png++;
  if (sha(resizeBilinear(grey, rows, cols)) !== s.resized_gray_sha256) resized++;
}
console.log(JSON.stringify({ slices: reference.slices.length, png_mismatch: png, resized_mismatch: resized, dims: volume.dims, precision: volume.precision }));
if (png || resized) process.exit(1);
