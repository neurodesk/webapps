import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { findCatalog, loadAppsRegistry, primaryCatalog, repoRoot } from '../lib/apps-registry.mjs';
import { desktopSuite, desktopSuites } from '../lib/standalone.mjs';

/**
 * The desktop suite a script builds: the catalogue named by `--catalog <id>`,
 * else NEURODESK_SUITE, else the primary catalogue's full suite.
 */
export function selectedSuite(registry, argv = process.argv, env = process.env) {
  const index = argv.indexOf('--catalog');
  const id = (index >= 0 ? argv[index + 1] : undefined) || env.NEURODESK_SUITE;
  return desktopSuite(registry, id ? findCatalog(registry, id) : primaryCatalog(registry));
}

/**
 * The electron-builder settings that name a suite's application and archives.
 * Electron names its profile directory (`app.getPath('userData')`: models,
 * missing-asset records, runs) after the packaged package.json's productName,
 * else its name, so an edition writes its own productName there; the full suite
 * keeps the `@neurodesk/desktop` profile its installs already use.
 */
export function builderConfig(suite) {
  return {
    appId: suite.appId,
    productName: suite.title,
    executableName: suite.executable,
    artifactName: `${suite.release}-\${version}-\${os}-\${arch}.\${ext}`,
    ...(suite.primary ? {} : { extraMetadata: { productName: suite.title } }),
  };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const suites = desktopSuites(await loadAppsRegistry());
  if (process.argv.includes('--releases')) {
    const { version } = JSON.parse(await readFile(join(repoRoot, 'packages/desktop/package.json'), 'utf8'));
    console.log(suites.map(suite => `${suite.release}@${version}`).join(' '));
  } else {
    console.log(suites.map(suite => suite.catalog).join('\n'));
  }
}
