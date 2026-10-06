import { readFileSync } from 'node:fs';
import { FileIOController } from './FileIOController.js';
import { DicomController } from './DicomController.js';

const base = '_MGE_phaseimage_lowres_20250905141342';
function batch() {
  const files = [];
  for (let echo = 6; echo >= 1; echo--) {
    for (const phase of [false, true]) {
      const name = `${base}_${phase ? '90002' : '90001'}_e${echo}${phase ? '_ph' : ''}`;
      files.push({ name: name + '.nii' });
      files.push({ name: name + '.json', text: async () => JSON.stringify({
        Manufacturer: 'Bruker', ImageType: ['ORIGINAL', 'PRIMARY', 'MULTIECHO', 'NONE', ...(phase ? ['PHASE'] : [])],
        EchoNumber: echo, EchoTime: (1.7 + 2 * (echo - 1)) / 1000, MagneticFieldStrength: 11.7521
      }) });
    }
  }
  return files;
}

test('offline Bruker echoes use sidecars instead of phaseimage in the protocol name', async () => {
  const io = new FileIOController({});
  await io.addFiles(batch());
  expect(io.buckets.magnitude).toHaveLength(6);
  expect(io.buckets.phase).toHaveLength(6);
  expect(io.buckets.extra).toHaveLength(0);
  expect(io.buckets.magnitude.map(e => e.echoNumber)).toEqual([1, 2, 3, 4, 5, 6]);
});

test('converted Bruker magnitude without an M marker is recognized', async () => {
  const files = batch();
  const result = await new DicomController({ updateOutput: () => {} })._classifyBatch(
    files.filter(f => f.name.endsWith('.nii')), files.filter(f => f.name.endsWith('.json')));
  expect(result.magnitude).toHaveLength(6);
  expect(result.phase).toHaveLength(6);
  expect(result.extras).toHaveLength(0);
  expect(result.echoTimes).toHaveLength(6);
});

test('dcm2niix suffixes distinguish echoes without sidecars', async () => {
  const io = new FileIOController({});
  await io.addFiles(batch().filter(f => f.name.endsWith('.nii')));
  expect(io.buckets.magnitude).toHaveLength(6);
  expect(io.buckets.phase).toHaveLength(6);
});

test('explicit metadata wins, while unrelated images stay uncategorized', async () => {
  const io = new FileIOController({});
  await io.addFiles([
    { name: 'phase.nii.gz' },
    { name: 'phase.json', text: async () => JSON.stringify({ImageType: ['ORIGINAL', 'PRIMARY', 'M']}) },
    { name: 'localizer.nii' },
    { name: 'localizer.json', text: async () => JSON.stringify({ImageType: ['ORIGINAL', 'PRIMARY', 'LOCALIZER']}) }
  ]);
  expect(io.buckets.magnitude.map(e => e.name)).toEqual(['phase.nii.gz']);
  expect(io.buckets.extra.map(e => e.name)).toEqual(['localizer.nii']);
});

test('BIDS part- entities classify Bruker echoes whose sidecar has no component', async () => {
  const files = [];
  for (let echo = 1; echo <= 3; echo++) {
    for (const part of ['mag', 'phase']) {
      const name = `sub-1_acq-3dmgeqsm_run-01_echo-0${echo}_part-${part}_MEGRE`;
      files.push({ name: name + '.nii' });
      files.push({ name: name + '.json', text: async () => JSON.stringify({
        Manufacturer: 'Bruker', ImageType: ['ORIGINAL', 'PRIMARY', 'OTHER'],
        EchoNumber: echo, EchoTime: 0.002 * echo, MagneticFieldStrength: 16.419
      }) });
    }
  }
  const io = new FileIOController({});
  await io.addFiles(files);
  expect(io.buckets.magnitude).toHaveLength(3);
  expect(io.buckets.phase).toHaveLength(3);
  expect(io.buckets.extra).toHaveLength(0);
  expect(io.buckets.phase.map(e => e.echoNumber)).toEqual([1, 2, 3]);
});

test('native file pickers allow the final gzip extension', () => {
  const html = readFileSync(new URL('../../index.html', import.meta.url), 'utf8');
  for (const id of ['maskFiles', 'unifiedFiles']) {
    const input = html.match(new RegExp(`<input[^>]*id="${id}"[^>]*>`))[0];
    expect(input.match(/accept="([^"]+)"/)[1].split(',')).toContain('.gz');
  }
});
