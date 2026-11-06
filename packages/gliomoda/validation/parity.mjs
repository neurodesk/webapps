// Runs src/pipeline.js with ONNX Runtime (Node, CPU) on the example for every segmentation the
// GlioMODA container recorded on Hugging Face (container.sh) and compares the labels.
//
//   node validation/parity.mjs <onnx dir> <example dir> [model ...] [--threads=N] [--write]
//
// <onnx dir> holds the manifest's gliomoda-<model>.onnx files (scripts/export_model.py) and
// <example dir> the example's images, named as in apps/gliomoda/examples.json. A recorded file
// <model>.nii.gz ran with mirroring, <model>_nomirror.nii.gz without. Prints one JSON line per
// run; --write stores them as the runs of container-reference.json, which the browser tests read,
// and rewrites the table in README.md from them.
import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import * as ort from 'onnxruntime-node';
import { readVolume } from '@neurodesk/synthsr';
import { segmentGlioma } from '../src/pipeline.js';
import { compareLabels, labelCounts } from '../src/results.js';
import { modelById } from '../src/models.js';
import { readContainerReference } from './reference.mjs';

const referenceUrl = new URL('./container-reference.json', import.meta.url);
const reference = JSON.parse(await readFile(referenceUrl, 'utf8'));
const args = process.argv.slice(2);
const flags = Object.fromEntries(args.filter((a) => a.startsWith('--')).map((a) => a.slice(2).split('=')));
const [onnxDir, exampleDir, ...only] = args.filter((a) => !a.startsWith('--'));
const examples = JSON.parse(await readFile(new URL('../../../apps/gliomoda/examples.json', import.meta.url), 'utf8'));
const files = Object.fromEntries(examples[0].files.map(({ role, name }) => [role, join(exampleDir, name)]));

const recorded = reference.runs.map(({ file, model, mirror }) => ({ file, model, mirror }));

const runs = [];
for (const run of recorded.filter(({ model }) => !only.length || only.includes(model))) {
  const model = modelById(run.model);
  const volumes = {};
  for (const role of model.channels) volumes[role] = readVolume((await readFile(files[role])).buffer);
  const session = await ort.InferenceSession.create(join(onnxDir, model.filename), { intraOpNumThreads: Number(flags.threads || 8) });
  const { labels } = await segmentGlioma({
    volumes,
    model,
    mirror: run.mirror,
    runPatch: async (tile) => (await session.run({ input: new ort.Tensor('float32', tile, [1, model.channels.length, ...model.patch]) })).logits.data,
  });
  await session.release();
  const bytes = await readContainerReference(run.file);
  const container = Uint8Array.from(readVolume(gunzipSync(bytes).buffer).data);
  const { dice, differing } = compareLabels(labels, container);
  const result = {
    ...run,
    sha256: createHash('sha256').update(bytes).digest('hex'),
    containerCounts: labelCounts(container),
    node: { dice, differing },
  };
  console.log(JSON.stringify(result));
  runs.push(result);
}

function table(all) {
  const lines = [
    '| Model | Mirroring | Container voxels 1 / 2 / 3 | Dice WT / TC / ET | Differing voxels |',
    '| --- | --- | --- | --- | --- |',
  ];
  for (const run of all) {
    const dice = ['WT', 'TC', 'ET'].map((region) => run.node.dice[region].toFixed(5)).join(' / ');
    lines.push(`| ${run.model} | ${run.mirror ? 'yes' : 'no'} | ${run.containerCounts.slice(1).join(' / ')} | ${dice} | ${run.node.differing} |`);
  }
  return lines.join('\n');
}

if ('write' in flags) {
  const kept = (reference.runs ?? []).filter((old) => !runs.some((r) => r.file === old.file));
  reference.runs = [...kept, ...runs].sort((a, b) => a.file.localeCompare(b.file));
  await writeFile(referenceUrl, `${JSON.stringify(reference, null, 2)}\n`);
  const readmeUrl = new URL('../README.md', import.meta.url);
  const readme = await readFile(readmeUrl, 'utf8');
  const marker = /<!-- parity-table -->[\s\S]*?<!-- \/parity-table -->|<!-- parity-table -->/;
  await writeFile(readmeUrl, readme.replace(marker, `<!-- parity-table -->\n${table(reference.runs)}\n<!-- /parity-table -->`));
}
