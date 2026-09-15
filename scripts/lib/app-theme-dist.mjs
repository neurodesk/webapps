import { cp, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { injectCompositeTheme } from './composite-theme.mjs';
import { stageStandaloneAssets } from './standalone.mjs';

export async function applyAppTheme({
  app, information, version, measurementId, distDir, themeFile, themeScriptFile, shellFile, shellAdaptersDir, analyticsFile, iconFile,
}) {
  const indexPath = join(distDir, 'index.html');
  const html = await readFile(indexPath, 'utf8');

  const themed = injectCompositeTheme(html, {
    appId: app.id,
    shell: app.shell || 'static-html',
    title: app.title,
    description: app.description,
    version,
    measurementId,
    href: './app-theme.css',
    themeHref: './theme.js',
    shellHref: './app-shell.js',
    analyticsHref: './analytics.js',
    moreAppsHref: '../',
    iconHref: './neurodesk-logo.svg',
    information,
  });
  await writeFile(indexPath, themed);
  await cp(themeFile, join(distDir, 'app-theme.css'));
  await cp(themeScriptFile, join(distDir, 'theme.js'));
  await cp(shellFile, join(distDir, 'app-shell.js'));
  if (shellAdaptersDir) await cp(shellAdaptersDir, join(distDir, 'shell-adapters'), { recursive: true });
  await stageStandaloneAssets(distDir);
  await cp(analyticsFile, join(distDir, 'analytics.js'));
  if (themed.includes('data-neurodesk-app-icon')) {
    await cp(iconFile, join(distDir, 'neurodesk-logo.svg'));
  }
}
