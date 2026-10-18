import { cp, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

// Only the composite GitHub Pages site needs this bridge. Standalone builds
// keep their existing routing and deployment-base behavior.
export async function stageDicompareRoutes({ repoRoot, siteDist }) {
  const index = join(siteDist, 'dicompare', 'index.html');
  const html = await readFile(index, 'utf8');
  const restore = '<script src="/dicompare-routes.js"></script>';
  if (!html.includes(restore)) {
    // Run before any app module or shared shell inspects the current URL.
    await writeFile(index, html.replace('<head>', `<head>\n  ${restore}`));
  }
  for (const file of ['404.html', 'dicompare-routes.js']) {
    await cp(join(repoRoot, 'site', file), join(siteDist, file));
  }
}
