// Brain mask with MindGrab on the CPU, through @neurodesk/node-drivers.
// Usage: node mindgrab-mask.mjs <in.nii[.gz]> <mask-out.nii[.gz]> [brain-out.nii[.gz]]
import { readFile, writeFile } from 'node:fs/promises';
import { gunzipSync, gzipSync } from 'node:zlib';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { loadMindgrabCpu } from '../../../packages/node-drivers/src/mindgrab.js';

const [input, maskOut, brainOut] = process.argv.slice(2);
const gz = (b) => b[0] === 0x1f && b[1] === 0x8b;
const encode = (buffer, path) => {
  const bytes = new Uint8Array(buffer);
  const raw = gz(bytes) ? gunzipSync(bytes) : bytes;
  return path.endsWith('.gz') ? gzipSync(raw) : raw;
};

const require = createRequire(new URL('../../../packages/node-drivers/package.json', import.meta.url));
const modelPackage = pathToFileURL(require.resolve('@brainchop/mindgrab/package.json'));
const mindgrab = await loadMindgrabCpu(modelPackage);
const { image, mask } = await mindgrab.segment(await readFile(input), { model: 'mindgrab', mask: true });
await writeFile(maskOut, encode(mask, maskOut));
if (brainOut) await writeFile(brainOut, encode(image, brainOut));
