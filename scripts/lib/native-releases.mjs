// Which apps publish native command-line archives, and which workflow builds, signs and attaches them.
import { execFileSync } from 'node:child_process';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

// The release job runs this without installing dependencies, so only Node built-ins may be imported.
const repoRoot = fileURLToPath(new URL('../../', import.meta.url));

// Rust tools with their own workflow, dispatched by hand: their release jobs attach to a draft or
// prerelease, and SynthSR and SynthSEG follow their Cargo.toml version rather than the app's.
const RUST_RELEASES = Object.freeze({
  greedy: { workflow: 'greedy-native.yml', targets: ['linux-x64', 'macos-arm64', 'windows-x64'] },
  synthsr: { workflow: 'synthsr-native.yml', targets: ['linux-x64', 'macos-arm64', 'windows-x64'] },
  synthseg: { workflow: 'synthseg-native.yml', targets: ['macos-arm64'] },
});

// A release.json without an app field predates exes/node-cli (SYNcro before 0.4): it names its package
// directory's app and has no install commands, so its archives are listed without them.
function addSpec(specs, packageDir, text) {
  const spec = JSON.parse(text);
  const app = spec.app ?? packageDir.split('/')[1];
  if (specs.has(app)) throw new Error(`${app}: release.json in both ${specs.get(app).packageDir} and ${packageDir}`);
  specs.set(app, { packageDir, spec, legacy: !spec.app });
}

// exes/node-cli tools: one release.json per package, naming the app it belongs to.
export async function portableSpecs(root = repoRoot) {
  const specs = new Map();
  for (const entry of await readdir(join(root, 'packages'), { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const packageDir = `packages/${entry.name}`;
    let text;
    try {
      text = await readFile(join(root, packageDir, 'release.json'), 'utf8');
    } catch (error) {
      if (error.code === 'ENOENT') continue;
      throw error;
    }
    addSpec(specs, packageDir, text);
  }
  return specs;
}

// The same specs as committed at a release tag, so the catalog describes the binaries that tag built.
export function portableSpecsAt(ref, root = repoRoot) {
  const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8' });
  const specs = new Map();
  for (const path of git('ls-tree', '-r', '--name-only', ref, '--', 'packages').split('\n')) {
    const match = /^(packages\/[^/]+)\/release\.json$/.exec(path);
    if (match) addSpec(specs, match[1], git('show', `${ref}:${path}`));
  }
  return specs;
}

function claim(releases, app, source) {
  const sources = releases.get(app) ?? [];
  for (const other of sources) {
    const shared = source.targets.filter((platform) => other.targets.includes(platform));
    if (shared.length) throw new Error(`${app}: ${shared.join(', ')} claimed by both ${other.workflow} and ${source.workflow}`);
    if (other.workflow === source.workflow) throw new Error(`${app}: two release sources share ${source.workflow}`);
  }
  releases.set(app, [...sources, source]);
}

// Every app's release sources, as { app: [source] }. Each source owns the platforms it builds, and one
// platform never has two owners. A Rust source is dispatched by hand and attaches to the release named by
// its Cargo.toml version; a portable source starts with the app release and builds in release.json's
// workflow (default <app>-native.yml). A source with a macOS installer publishes only by signing it.
export function nativeReleases(specs) {
  const releases = new Map();
  for (const [app, release] of Object.entries(RUST_RELEASES)) {
    claim(releases, app, { ...release, publishInput: 'sign_release', startsWithAppRelease: false, spec: null });
  }
  for (const [app, { packageDir, spec, legacy }] of specs) {
    const targets = Object.keys(spec.targets);
    const installer = targets.some((platform) => spec.targets[platform].archive === 'pkg');
    claim(releases, app, {
      workflow: spec.workflow ?? `${app}-native.yml`,
      targets,
      publishInput: installer ? 'sign_release' : 'publish_release',
      startsWithAppRelease: true,
      packageDir,
      spec: legacy ? null : spec,
    });
  }
  return releases;
}
