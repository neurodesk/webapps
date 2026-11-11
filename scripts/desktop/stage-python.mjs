import { cp, mkdir, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';

export async function stagePython({ destination, apps, sources, assetPath }) {
  if (!apps.some(app => ['dicompare', 'seedseg', 'qsmbly', 'dicomview'].includes(app.id))) return;
  const directory = join(destination, 'site/_offline/python');
  await mkdir(join(directory, 'wheels'), { recursive: true });
  for (const source of sources.apps.dicompare) {
    if (!source.url.startsWith(sources.python.base) && source.kind !== 'python-wheel') continue;
    const path = join(directory, source.kind === 'python-wheel' ? 'wheels' : '', basename(new URL(source.url).pathname));
    await cp(await assetPath(source.url), path);
  }
  await writeFile(join(destination, 'site/_offline/python.json'), `${JSON.stringify(sources.python, null, 2)}\n`);
}
