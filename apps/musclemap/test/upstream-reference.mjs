// Independent reference for the browser pipeline: upstream MuscleMap (PyTorch, whole-body v1.4)
// run on the same body MRI slab. fixtures/upstream-reference/README.md records the command,
// revision and versions. The thresholds are the release gate of scripts/compare_upstream_output.py.
import { createHash } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readNifti } from '../../../packages/components/src/file-io/NiftiUtils.js';
import { dice, labelDice } from '../../../test-utils/dice.mjs';
import { BODY_SLAB, BODY_SOURCE, cutBodySlab } from './body-slab.mjs';

const FIXTURE = {
  url: new URL('./fixtures/upstream-reference/body_mri_s0175_slab_musclemap-wholebody-v1.4_dseg.nii.gz', import.meta.url),
  sha256: 'b23a88ab402a024e217241342edc39a03caddbf56be257c752f008bfe6d121d9',
  labelledVoxels: 45281,
  labels: 26,
};

export const UPSTREAM_GATE = {
  minimumOverallAgreement: 0.99,
  minimumForegroundDice: 0.95,
  minimumLabelDice: 0.95,
};

const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');

async function pinnedSource() {
  const directory = join(process.env.TMPDIR || process.env.RUNNER_TEMP || tmpdir(), 'neurodesk-musclemap-reference');
  await mkdir(directory, { recursive: true });
  const path = join(directory, BODY_SOURCE.name);
  const cached = await readFile(path).catch(() => null);
  if (cached && sha256(cached) === BODY_SOURCE.sha256) return cached;
  const response = await fetch(BODY_SOURCE.url);
  if (!response.ok) throw new Error(`MuscleMap reference input is unavailable: HTTP ${response.status} ${BODY_SOURCE.url}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  if (sha256(bytes) !== BODY_SOURCE.sha256) throw new Error(`${BODY_SOURCE.name} failed SHA-256 verification`);
  const partial = `${path}.${process.pid}.partial`;
  await writeFile(partial, bytes);
  await rename(partial, path);
  return bytes;
}

export async function loadUpstreamReference() {
  const fixture = await readFile(FIXTURE.url);
  if (sha256(fixture) !== FIXTURE.sha256) throw new Error('Upstream MuscleMap reference failed SHA-256 verification');
  const labels = await readNifti(fixture, Uint16Array);
  if (labels.dims.join() !== BODY_SLAB.dims.join()) throw new Error(`Upstream reference grid is ${labels.dims}`);
  const present = new Set(labels.data);
  present.delete(0);
  const labelled = labels.data.reduce((sum, value) => sum + (value ? 1 : 0), 0);
  if (labelled !== FIXTURE.labelledVoxels || present.size !== FIXTURE.labels) throw new Error('Upstream reference content changed');
  return {
    input: { name: BODY_SLAB.name, buffer: await cutBodySlab(await pinnedSource()) },
    dims: BODY_SLAB.dims,
    sourceChunkSize: String(BODY_SLAB.slices),
    labels: labels.data,
    affine: labels.header.affine.map(row => [...row]),
  };
}

// Scores a segmentation NIfTI (official label values) the way compare_upstream_output.py does.
export async function compareWithUpstream(segmentationBytes, reference) {
  const candidate = await readNifti(segmentationBytes, Uint16Array);
  if (candidate.dims.join() !== reference.dims.join()) throw new Error(`Segmentation grid is ${candidate.dims}, upstream is ${reference.dims}`);
  let equal = 0;
  for (let index = 0; index < candidate.data.length; index++) {
    if (candidate.data[index] === reference.labels[index]) equal++;
  }
  const perLabel = labelDice(candidate.data, reference.labels);
  const referenceLabels = Object.entries(perLabel).filter(([, value]) => value.voxelsB > 0);
  const worst = referenceLabels.reduce((low, entry) => (entry[1].dice < low[1].dice ? entry : low));
  return {
    affineMatches: candidate.header.affine.every((row, r) => [...row].every((value, c) => value === reference.affine[r][c])),
    overallAgreement: equal / candidate.data.length,
    foregroundDice: dice(candidate.data, reference.labels),
    referenceLabels: referenceLabels.length,
    worstLabel: Number(worst[0]),
    worstLabelDice: worst[1].dice,
    labelsBelowGate: referenceLabels.filter(([, value]) => value.dice < UPSTREAM_GATE.minimumLabelDice).map(([label, value]) => ({ label: Number(label), ...value })),
    extraLabels: Object.entries(perLabel).filter(([, value]) => value.voxelsB === 0).map(([label, value]) => ({ label: Number(label), voxels: value.voxelsA })),
    perLabel,
  };
}
