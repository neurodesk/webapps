import { cp, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

// Only the composite GitHub Pages site needs this bridge. Standalone builds
// keep their existing routing and deployment-base behavior.
export async function stageDicompareRoutes({ repoRoot, siteDist }) {
  const index = join(siteDist, 'dicompare', 'index.html');
  const html = await readFile(index, 'utf8');
  const restore = '<script src="/dicompare-routes.js"></script>';
  if (!html.includes(restore)) {
    // Runtime-cache staging can prepend relative scripts before the base tag.
    // Establish the fixed asset base before restoring a nested document URL.
    const base = html.match(/<base\b[^>]*>/i)?.[0];
    if (!base || !/href=["']\/dicompare\/["']/.test(base)) {
      throw new Error('Dicompare Pages routing requires a /dicompare/ document base');
    }
    await writeFile(index, html.replace(base, '').replace('<head>', `<head>\n  ${base}\n  ${restore}`));
  }
  for (const file of ['404.html', 'dicompare-routes.js']) {
    await cp(join(repoRoot, 'site', file), join(siteDist, file));
  }
}
