// The cases that the browser reference (browser-reference.mjs) records and the release check
// (cli-check.mjs) replays; browser-reference.json pins what the browser wrote.
//
// The subject is the pipeline tests' synthetic head (test/syn-fixture.js): an 8-volume 3 mm DWI
// series stretched along j and a 2 mm T1w. Both brain masks come from MindGrab and the prior is
// off, so the case runs every step but the T1w-to-MNI affine: N4, DenoiseImage, MindGrab twice,
// epi2anat, SyN, the field fit and the unwarp, in about 6 minutes. The full-brain example takes
// 1.5 hours, longer than a release job; sdc-registration-gate.yml holds that run to sdcflows.
import { createHash } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { synthetic } from '../test/syn-fixture.js';

export const REFERENCE_URL = new URL('./browser-reference.json', import.meta.url);

export const CASES = [{ id: 'synthetic-mindgrab-no-prior', prior: false }];

const DWI = 'sub-01_dir-AP_dwi';

/** The case's input files by name. */
export function caseInputs() {
  const subject = synthetic();
  return {
    [`${DWI}.nii.gz`]: subject.dwi,
    [`${DWI}.bval`]: new TextEncoder().encode(subject.bval),
    [`${DWI}.bvec`]: new TextEncoder().encode(subject.bvec),
    [`${DWI}.json`]: new TextEncoder().encode(JSON.stringify(subject.sidecar)),
    'sub-01_T1w.nii.gz': subject.t1w,
  };
}

/** Writes the inputs into `directory`; returns the command line's arguments before OUTPUT_DIR. */
export async function writeCaseInputs(directory) {
  for (const [name, bytes] of Object.entries(caseInputs())) await writeFile(join(directory, name), bytes);
  return { dwi: join(directory, `${DWI}.nii.gz`), t1w: join(directory, 'sub-01_T1w.nii.gz') };
}

export const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

/**
 * The SHA-256 of every output, of the decompressed bytes for a .gz: Node's zlib and the browser's
 * CompressionStream may compress the same image differently.
 */
export function measureOutputs(files) {
  return Object.fromEntries([...files.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([name, bytes]) => [name, sha256(name.endsWith('.gz') ? gunzipSync(bytes) : bytes)]));
}

/** [passed, line] for each output against the pinned one. */
export function compareOutputs(measured, expected) {
  const names = [...new Set([...Object.keys(measured), ...Object.keys(expected)])].sort();
  return names.map((name) => [measured[name] === expected[name], `${name} ${measured[name] === expected[name] ? 'equals' : `differs from (${measured[name] ?? 'missing'} against ${expected[name] ?? 'not pinned'})`} the browser's`]);
}
