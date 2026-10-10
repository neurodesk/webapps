import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
const root = new URL('../', import.meta.url);
const filenames = [
  'preprocessing.js',
  'preprocessing_bg.wasm',
  'preprocessing.d.ts',
  'preprocessing_bg.wasm.d.ts',
];
const files = [];
for (const filename of filenames) {
  const bytes = await readFile(new URL(`preprocessing/${filename}`, root));
  files.push({
    filename,
    bytes: bytes.length,
    sha256: createHash('sha256').update(bytes).digest('hex'),
  });
}
const manifest = new URL('preprocessing/artifact.json', root);
if (process.argv.includes('--record')) {
  await writeFile(
    manifest,
    JSON.stringify(
      {
        rust: '1.98.0',
        wasmPack: '0.13.1',
        wasmBindgen: '0.2.114',
        wasmOpt: false,
        qsmCommit: '3aa02ca2ba77b4cc069366a7db9847d6b0c9d19d',
        files,
      },
      null,
      2
    ) + '\n'
  );
} else {
  const pinned = JSON.parse(await readFile(manifest, 'utf8'));
  if (JSON.stringify(pinned.files) !== JSON.stringify(files))
    throw new Error('Required VesselBoost preprocessing artifact failed checksum verification');
}
console.log('Verified required VesselBoost preprocessing artifact');
