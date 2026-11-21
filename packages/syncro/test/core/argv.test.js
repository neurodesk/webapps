// The WebAssembly core emits the same commands as the native one: each case of exes/syncro/core/tests/argv.rs,
// through an in-memory host with the same stub tools, must reproduce its golden commands.sh byte for byte.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { gzipSync } from 'node:zlib';
import { writeVolume } from '../../../synthsr/src/index.js';
import init, { runSyncro } from '../../wasm/syncro_wasm.js';

const goldens = new URL('../../../../exes/syncro/core/tests/goldens/', import.meta.url);
const identity = [[1, 0, 0, 0], [0, 1, 0, 0], [0, 0, 1, 0], [0, 0, 0, 1]];
const tilted = [[-1, 0, 0, 5], [0, 1, 0, 0], [0, 0.15, 1, 0], [0, 0, 0, 1]];
const template = () => ({
  dims: [10, 10, 10],
  affine: [[-1, 0, 0, 5], [0, 1, 0, -5], [0, 0, 1, -5], [0, 0, 0, 1]],
  data: Float32Array.from({ length: 1000 }, (_, i) => (i % 10 > 1 && i % 10 < 8 ? 50 : 0)),
});
const scan = (affine, offset) => ({ dims: [8, 8, 8], affine, data: Float32Array.from({ length: 512 }, (_, i) => offset + i) });
const bytes = (buffer) => new Uint8Array(buffer);

function memoryHost() {
  const files = new Map();
  const put = (path, data) => files.set(path, bytes(data));
  const image = (path) => {
    const encoded = bytes(writeVolume(template(), 'stub output'));
    put(path, path.endsWith('.gz') ? gzipSync(encoded) : encoded);
  };
  const after = (argv, flag) => argv[argv.indexOf(flag) + 1];
  return {
    files,
    put,
    async run(argv) {
      switch (argv[0]) {
        case 'greedy-rs':
          if (argv.includes('-rm')) image(argv[argv.indexOf('-rm') + 2]);
          else if (argv.includes('-a')) put(after(argv, '-o'), new TextEncoder().encode('1 0 0 0\n0 1 0 0\n0 0 1 0\n0 0 0 1\n'));
          else image(after(argv, '-o'));
          break;
        case 'synthsr': image(argv[2]); break;
        case 'brainchop-mindgrab': image(after(argv, '-o')); image(after(argv, '--mask')); break;
        case 'niimath': image(argv[argv.indexOf('-odt') - 1]); break;
        case 'antsRegistration': {
          const [prefix, warped] = after(argv, '--output').replace(/[[\]]/g, '').split(',');
          image(warped);
          image(`${prefix}1Warp.nii.gz`);
          put(`${prefix}0GenericAffine.mat`, new TextEncoder().encode('affine'));
          break;
        }
        case 'antsApplyTransforms': image(after(argv, '-o')); break;
        default: throw new Error(`unexpected tool ${argv[0]}`);
      }
      return { code: 0, stdout: '', stderr: '' };
    },
    async readRange(path, offset, length) {
      const data = files.get(path);
      if (!data) throw new Error(`${path}: missing`);
      return data.slice(offset, offset + length);
    },
    async readText(path) { return new TextDecoder().decode(files.get(path)); },
    async write(path, data) { put(path, data.slice()); },
    async append(path, data) {
      const previous = files.get(path) ?? new Uint8Array();
      const joined = new Uint8Array(previous.length + data.length);
      joined.set(previous);
      joined.set(data, previous.length);
      put(path, joined);
    },
    exists: (path) => files.has(path),
    stat: (path) => (files.has(path) ? [files.get(path).length, 0] : null),
    list: () => [],
    mkdirs() {},
    remove: (path) => { files.delete(path); },
    rename(from, to) { put(to, files.get(from)); files.delete(from); },
    copy(from, to) { put(to, files.get(from).slice()); },
    now: () => 0,
    localTime: () => '',
    log() {},
  };
}

const cases = [
  { name: 't1', primary: scan(identity, 10) },
  { name: 'ct', primary: scan(tilted, -1024), ct: true },
  { name: 't1-lesion', primary: scan(identity, 10), lesion: true },
  { name: 't1-pathological-lesion', primary: scan(identity, 10), pathological: scan(identity, 3), lesion: true },
];

test('the WebAssembly core emits the native goldens', async () => {
  await init({ module_or_path: await readFile(new URL('../../wasm/syncro_wasm_bg.wasm', import.meta.url)) });
  for (const testCase of cases) {
    for (const normalization of ['greedy', 'ants']) {
      const host = memoryHost();
      host.put('/in/sub-01_T1w.nii.gz', gzipSync(bytes(writeVolume(testCase.primary, 'primary'))));
      host.put('/in/mni.nii.gz', gzipSync(bytes(writeVolume(template(), 'template'))));
      const options = { input: '/in/sub-01_T1w.nii.gz', template: '/in/mni.nii.gz', out: '/out', work: '/work', ct: Boolean(testCase.ct), normalization, threads: 4 };
      if (testCase.pathological) {
        host.put('/in/sub-01_FLAIR.nii', writeVolume(testCase.pathological, 'pathological'));
        options.pathological = '/in/sub-01_FLAIR.nii';
      }
      if (testCase.lesion) {
        const reference = testCase.pathological ?? testCase.primary;
        host.put('/in/lesion.nii', writeVolume({ ...reference, data: Uint8Array.from({ length: 512 }, (_, i) => (i === 300 ? 255 : 0)) }, 'lesion'));
        options.lesion = '/in/lesion.nii';
      }
      const stages = [];
      const provenance = JSON.parse(await runSyncro(host, options, (stage) => stages.push(stage)));
      assert.equal(provenance.desheared.primary, Boolean(testCase.ct));
      assert.equal(stages.at(-1), 'complete');
      const golden = await readFile(new URL(`${testCase.name}-${normalization}.sh`, goldens), 'utf8');
      assert.equal(new TextDecoder().decode(host.files.get('/work/commands.sh')), golden, `${testCase.name}-${normalization}`);
    }
  }
});
