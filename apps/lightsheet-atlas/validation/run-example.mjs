// Run the app's pipeline on a pinned example in Node, with the same Greedy WebAssembly bytes the
// browser worker runs (@neurodesk/greedy wasm-single). Downloads are checked against their
// sha256 and cached in $LIGHTSHEET_ATLAS_CACHE (default: $TMPDIR/lightsheet-atlas).
//
//   node validation/run-example.mjs brainreg-test-brain OUT_DIR   writes the outputs and prints hashes
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { loadGreedySingleThread } from '@neurodesk/greedy/single';
import { createNiftiFromData, readNiftiImageData } from '@neurodesk/webapp-components/file-io/nifti';
import { openMicroscopyStack } from '@neurodesk/webapp-components/file-io/microscopy-stack';
import { runPipeline } from '../src/pipeline.js';
import { gridNifti } from '../src/registration.js';
import { EXAMPLE_SETTINGS } from '../src/config.js';

const read = async (url) => JSON.parse(await readFile(new URL(url, import.meta.url), 'utf8'));
const examples = await read('../examples.json');
const manifest = await read('../../../models/lightsheet-atlas.manifest.json');
const cache = process.env.LIGHTSHEET_ATLAS_CACHE ?? join(process.env.TMPDIR ?? tmpdir(), 'lightsheet-atlas');

export const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

export async function fetchPinned({ url, sha256: expected, name, filename }) {
  await mkdir(cache, { recursive: true });
  const path = join(cache, `${expected.slice(0, 12)}-${name ?? filename}`);
  let bytes = await readFile(path).catch(() => null);
  if (!bytes || sha256(bytes) !== expected) {
    const response = await fetch(url);
    if (!response.ok) throw new Error(`${url}: HTTP ${response.status}`);
    bytes = Buffer.from(await response.arrayBuffer());
    if (sha256(bytes) !== expected) throw new Error(`${url}: checksum mismatch`);
    await writeFile(path, bytes);
  }
  return bytes;
}

export async function loadAtlas() {
  const get = async (id) => fetchPinned(manifest.assets.find((entry) => entry.id === id));
  const template = gunzipSync(await get('template'));
  const annotation = gunzipSync(await get('annotation'));
  const structures = JSON.parse((await get('structures')).toString());
  return { template, annotation, structures, annotationData: readNiftiImageData(annotation, Uint16Array).data };
}

/** Run one example as its page settings do; returns the pipeline result. */
export async function runExample(id, { onLog = () => {} } = {}) {
  const example = examples.find((entry) => entry.id === id);
  const file = example.files[0];
  const bytes = await fetchPinned(file);
  const stack = await openMicroscopyStack([new File([bytes], file.name)]);
  const settings = EXAMPLE_SETTINGS[id];
  const voxelSizeUm = [stack.voxelSizeUm.z, stack.voxelSizeUm.y, stack.voxelSizeUm.x];
  const greedy = settings.register ? await loadGreedySingleThread() : null;
  const result = await runPipeline({ stack, voxelSizeUm, orientation: settings.orientation, register: settings.register, detect: settings.detect, loadAtlas, greedy, onLog });
  return { ...result, voxelSizeUm };
}

/** The voxel bytes of the registered-atlas download (Allen ids, uint32), as the worker writes it. */
export function registeredAtlasVoxels(result) {
  const ids = new Uint32Array(result.labels.length);
  for (let i = 0; i < ids.length; i++) ids[i] = result.labels[i] ? result.table.byIndex.get(result.labels[i]).id : 0;
  const nifti = Buffer.from(gridNifti(ids, result.grid.shape, result.atlasTemplate));
  return nifti.subarray(nifti.readFloatLE(108));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const [id, out] = process.argv.slice(2);
  const started = Date.now();
  const result = await runExample(id, { onLog: console.log });
  console.log(`${id}: ${((Date.now() - started) / 1000).toFixed(0)} s`);
  if (result.labels) {
    await mkdir(out, { recursive: true });
    await writeFile(join(out, 'labels.u16'), Buffer.from(result.labels.buffer));
    for (let i = 0; i < 3; i++) await writeFile(join(out, `coord${i}.f32`), Buffer.from(result.coordinates[i].buffer));
    await writeFile(join(out, 'meta.json'), JSON.stringify({ shape: result.grid.shape, matrix: result.matrix }));
    await writeFile(join(out, 'regions.csv'), result.regionCsv);
    await writeFile(join(out, 'sample.nii'), Buffer.from(createNiftiFromData(result.grid.data, result.atlasTemplate, { dims: result.grid.shape })));
    console.log(JSON.stringify({ registeredAtlasSha256: sha256(registeredAtlasVoxels(result)), regionsCsvSha256: sha256(result.regionCsv), regionRows: result.rows.length }));
  }
  if (result.cells) console.log(`${result.cells.length} cells`);
}
