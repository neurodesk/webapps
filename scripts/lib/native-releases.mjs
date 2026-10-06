// Which apps publish native command-line archives, and which workflow builds, signs and attaches them.
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { repoRoot } from './apps-registry.mjs';

// Rust tools with their own workflow, dispatched by hand: their release jobs publish only into a draft or
// prerelease, and SynthSR and SynthSEG follow their Cargo.toml version rather than the app's.
const RUST_RELEASES = Object.freeze({
  greedy: { workflow: 'greedy-native.yml', startsWithAppRelease: false },
  synthsr: { workflow: 'synthsr-native.yml', startsWithAppRelease: false },
  synthseg: { workflow: 'synthseg-native.yml', startsWithAppRelease: false },
});

// exes/node-cli tools: one release.json per package, naming the app it belongs to.
export async function portableSpecs(root = repoRoot) {
  const specs = new Map();
  for (const entry of await readdir(join(root, 'packages'), { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const packageDir = `packages/${entry.name}`;
    let spec;
    try {
      spec = JSON.parse(await readFile(join(root, packageDir, 'release.json'), 'utf8'));
    } catch (error) {
      if (error.code === 'ENOENT') continue;
      throw error;
    }
    if (specs.has(spec.app)) throw new Error(`${spec.app}: release.json in both ${specs.get(spec.app).packageDir} and ${packageDir}`);
    specs.set(spec.app, { packageDir, spec });
  }
  return specs;
}

export async function nativeReleases(root = repoRoot) {
  const releases = new Map(Object.entries(RUST_RELEASES).map(([app, release]) => [app, { ...release, spec: null }]));
  for (const [app, { packageDir, spec }] of await portableSpecs(root)) {
    if (releases.has(app)) throw new Error(`${app}: both a Rust and a portable Node release`);
    releases.set(app, { workflow: `${app}-native.yml`, startsWithAppRelease: true, packageDir, spec });
  }
  return releases;
}
