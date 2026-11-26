import { createHash } from 'node:crypto';
import reference from './container-reference.json' with { type: 'json' };

const FILES = Object.freeze({
  'BEAMSTER_A_038_brain.nii.gz': 'c8fa4c18b3208c9a816cb2dfbc2e2a39e596cf327a0a23621216c4fe84cfa2b6',
  'BEAMSTER_A_038_tumour.nii.gz': 'de7b345ad4ddcfb54f0f742f1fb2d194664261f3ae2043d0dfa6d9cb3b8b00ba',
  'BEAMSTER_A_038_tumour_mni.nii.gz': '32448d04f5302317091069a0406d216b31eaa93fafb290b437e0b65f67d7ce7a',
});

export async function readContainerReference(file) {
  const expected = FILES[file];
  if (!expected) throw new Error(`Unknown container reference: ${file}`);
  const url = new URL(file, reference.baseUrl);
  const response = await fetch(url);
  if (!response.ok) throw new Error(`HTTP ${response.status} fetching ${url.href}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  const actual = createHash('sha256').update(bytes).digest('hex');
  if (actual !== expected) throw new Error(`Container reference checksum mismatch for ${file}`);
  return bytes;
}
