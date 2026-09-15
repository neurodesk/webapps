import { cp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { fileHash } from '../../packages/desktop/src/bundle.js';

export async function stagePython({ destination, apps, sources, lock, cache, root, assets }) {
  if (!apps.some(app => ['dicompare', 'seedseg', 'qsmbly'].includes(app.id))) return;
  const directory = join(destination, 'site/_offline/python');
  await mkdir(join(directory, 'wheels'), { recursive: true });
  for (const source of sources.apps.dicompare) {
    if (!source.url.startsWith(sources.python.base) && source.kind !== 'python-wheel') continue;
    const asset = lock.assets[source.url];
    if (!asset) throw new Error(`Python asset is not locked: ${source.url}`);
    const path = join(directory, source.kind === 'python-wheel' ? 'wheels' : '', basename(new URL(source.url).pathname));
    await cp(join(cache, asset.sha256), path);
  }
  await writeFile(join(destination, 'site/_offline/python.json'), `${JSON.stringify(sources.python, null, 2)}\n`);
  // Embedded consumers request this public URL. Ship the worker built from this
  // checkout so it selects the same offline Python installation as dicompare.
  const url = 'https://dicompare.neurodesk.org/embed/dicompare-worker.js';
  if (assets[url]) {
    const worker = join(root, 'apps/dicompare/public/embed/dicompare-worker.js');
    const sha256 = await fileHash(worker);
    const bytes = (await readFile(worker)).length;
    await cp(worker, join(destination, 'assets', sha256));
    assets[url] = { path: `assets/${sha256}`, sha256, bytes, kind: 'built-runtime', contentType: 'text/javascript' };
  }
}
