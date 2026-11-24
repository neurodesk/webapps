import { createHash } from 'node:crypto';
import reference from './container-reference.json' with { type: 'json' };

const FILES = Object.freeze({
  'BEAMSTER_A_038_brain.nii.gz': '5a28bc0a77ba12f7d25c60d024b94a9d611a76a5de9b7b0c6ee50cef83889224',
  'BEAMSTER_A_038_tumour.nii.gz': 'dd2b55afe782beb56774d0116f8a639a59754d82294581b688fbdb79b4615b7e',
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
