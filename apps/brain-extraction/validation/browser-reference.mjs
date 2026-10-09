// The web app's results on the T1 example, recorded in a real browser (browser-reference.json),
// and the checks that hold another run to them. e2e/app.spec.js records and asserts them;
// packages/brain-extraction/validation/cli-check.mjs holds the command line to them.
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { readVolume } from '@neurodesk/synthsr';

export const browserReference = JSON.parse(await readFile(new URL('./browser-reference.json', import.meta.url), 'utf8'));

const NIFTI_HEADER_BYTES = 352;
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const arrayBuffer = (bytes) => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);

// brain and mask are the downloaded NIfTI files' bytes (Uint8Array or Buffer).
export function measure({ brain, mask }) {
  const brainVolume = readVolume(arrayBuffer(brain));
  const maskVolume = readVolume(arrayBuffer(mask));
  const labels = Uint8Array.from(maskVolume.data);
  let maskVoxels = 0;
  let nonBinary = 0;
  let brainSum = 0;
  let brainMax = -Infinity;
  const background = new Set();
  for (let i = 0; i < labels.length; i++) {
    const label = maskVolume.data[i];
    const value = brainVolume.data[i];
    if (label !== 0 && label !== 1) nonBinary++;
    if (label === 1) {
      maskVoxels++;
      brainSum += value;
      brainMax = Math.max(brainMax, value);
    } else {
      background.add(value);
    }
  }
  return {
    dims: brainVolume.dims,
    maskDims: maskVolume.dims,
    brainHeaderSha256: sha256(brain.subarray(0, NIFTI_HEADER_BYTES)),
    maskHeaderSha256: sha256(mask.subarray(0, NIFTI_HEADER_BYTES)),
    maskVoxels,
    maskSha256: sha256(labels),
    brainSha256: sha256(new Uint8Array(brainVolume.data.buffer, brainVolume.data.byteOffset, brainVolume.data.byteLength)),
    nonBinary,
    background: [...background],
    brainMean: Number((brainSum / maskVoxels).toFixed(3)),
    brainMax,
  };
}

// Dice of two binary masks of the same grid.
export function dice(a, b) {
  let inA = 0;
  let inB = 0;
  let both = 0;
  for (let i = 0; i < a.length; i++) {
    inA += a[i] !== 0;
    inB += b[i] !== 0;
    both += a[i] !== 0 && b[i] !== 0;
  }
  return { dice: (2 * both) / (inA + inB), differing: inA + inB - 2 * both };
}

const within = (value, expected, relative) => Math.abs(value - expected) <= relative * Math.abs(expected);

// [passed, line] pairs, so each caller reports them its own way.
export function compareWithBrowser(measured, method) {
  const expected = browserReference.methods[method];
  const { tolerance } = expected;
  const percent = `${tolerance.relative * 100} %`;
  return [
    [measured.brainHeaderSha256 === expected.brainHeaderSha256, `brain NIfTI header identical to the browser's (${measured.dims.join(' x ')})`],
    [measured.maskHeaderSha256 === expected.maskHeaderSha256, `mask NIfTI header identical to the browser's (${measured.maskDims.join(' x ')})`],
    [measured.nonBinary === 0, `mask is binary (${measured.nonBinary} voxels outside {0, 1})`],
    [JSON.stringify(measured.background) === JSON.stringify([expected.background]), `brain is ${expected.background} outside the mask (found ${measured.background.join(', ')})`],
    [within(measured.maskVoxels, expected.maskVoxels, tolerance.relative), `${measured.maskVoxels} mask voxels, browser ${expected.maskVoxels} ± ${percent}`],
    [within(measured.brainMean, expected.brainMean, tolerance.relative), `brain mean ${measured.brainMean} inside the mask, browser ${expected.brainMean} ± ${percent}`],
    [measured.brainMax === expected.brainMax, `brain maximum ${measured.brainMax}, browser ${expected.brainMax}`],
    // Methods whose browser mask the command line must reproduce bit for bit pin the brain voxels too.
    ...(expected.brainSha256 ? [[measured.brainSha256 === expected.brainSha256, `brain voxels identical to the browser's (${measured.brainSha256.slice(0, 16)})`]] : []),
  ];
}
