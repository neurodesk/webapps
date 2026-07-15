import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

export async function writeCoiServiceWorker({ repoRoot, destination, config }) {
  const source = await readFile(
    join(repoRoot, 'packages', 'runtime-support', 'src', 'coi-serviceworker.js'),
    'utf8',
  );
  const options = config === true ? {} : config;
  const rendered = source.replace('/*__COI_RUNTIME_CONFIG__*/ {}', JSON.stringify(options));
  if (rendered === source) throw new Error('COI service-worker configuration marker is missing');
  await writeFile(destination, rendered);
}
