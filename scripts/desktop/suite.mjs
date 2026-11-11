import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { findCatalog, loadAppsRegistry, primaryCatalog } from '../lib/apps-registry.mjs';

/** The catalogue a desktop script builds the suite of, from its `--catalog` value: the primary catalogue by default. */
export function suiteCatalog(registry, id) {
  return id === undefined ? primaryCatalog(registry) : findCatalog(registry, id);
}

/** The GitHub release tag of a catalogue's suite. */
export function suiteTag(catalog, version) {
  return `${catalog.desktop.release}-v${version}`;
}

// The Apptainer SIF wraps the primary catalogue's Linux build only.
export function suitePlatforms(registry, catalog) {
  const platforms = ['macos-arm64', 'linux-x64', 'windows-x64'];
  return catalog.id === primaryCatalog(registry).id ? [...platforms, 'linux-x64-apptainer'] : platforms;
}

/**
 * electron-builder settings that give a catalogue's suite its own identity, so
 * suites install side by side: bundle id, product name, executable and archives.
 * Electron names the profile directory after the packaged package.json, so every
 * suite but the primary one gets its own `productName` there. The primary suite
 * keeps the `@neurodesk/desktop` profile its installed copies already use.
 */
export function builderConfig(registry, catalog) {
  const { desktop } = catalog;
  const primary = catalog.id === primaryCatalog(registry).id;
  return {
    appId: desktop.app_id,
    productName: desktop.product_name,
    executableName: desktop.executable,
    artifactName: `${desktop.release}-\${version}-\${os}-\${arch}.\${ext}`,
    ...(primary ? {} : { extraMetadata: { productName: desktop.product_name } }),
  };
}

// The standalone workflow's matrix: one suite per catalogue, and the catalogue that also ships the Apptainer image.
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const registry = await loadAppsRegistry();
  console.log(`suites=${JSON.stringify(registry.site.catalogs.map(catalog => ({ catalog: catalog.id, release: catalog.desktop.release })))}`);
  console.log(`primary=${primaryCatalog(registry).id}`);
}
