// Which apps publish native command-line archives, and which workflow builds, signs and attaches them.
import { execFileSync } from 'node:child_process';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { portableCommand } from './portable-command.mjs';

// The release job runs this without installing dependencies, so only Node built-ins may be imported.
const repoRoot = fileURLToPath(new URL('../../', import.meta.url));

// Rust tools with their own workflow. The release tooling keeps each Cargo.toml at the app's version
// (EMBEDDED_VERSION_SITES), so the app release tag names the release their archives attach to.
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
    if (shared.length) throw new Error(`${app}: ${shared.join(', ')} claimed by both ${other.workflow ?? other.spec.repository} and ${source.workflow ?? source.spec.repository}`);
    if (other.workflow === source.workflow) throw new Error(`${app}: two release sources share ${source.workflow}`);
  }
  releases.set(app, [...sources, source]);
}

// Every app's release sources, as { app: [source] }. Each source owns the platforms it builds, and one
// platform never has two owners. Every source starts with the app release and attaches to its tag. A Rust
// source builds in its own workflow; a portable source builds in release.json's workflow (default
// <app>-native.yml) and writes exes/node-cli receipts. A source with a macOS installer publishes only by
// signing it. A release.json with a tag is external: another repository builds and releases it, and the
// catalog links its pinned assets (externalCatalog) without building, dispatching or importing anything.
export function nativeReleases(specs) {
  const releases = new Map();
  for (const [app, release] of Object.entries(RUST_RELEASES)) {
    claim(releases, app, { ...release, publishInput: 'sign_release', portable: false, spec: null });
  }
  for (const [app, { packageDir, spec, legacy }] of specs) {
    const targets = Object.keys(spec.targets);
    if (spec.tag) {
      claim(releases, app, { workflow: null, targets, publishInput: null, portable: false, external: true, packageDir, spec });
      continue;
    }
    const installer = targets.some((platform) => spec.targets[platform].archive === 'pkg');
    claim(releases, app, {
      workflow: spec.workflow ?? `${app}-native.yml`,
      targets,
      publishInput: installer ? 'sign_release' : 'publish_release',
      portable: true,
      packageDir,
      spec: legacy ? null : spec,
    });
  }
  return releases;
}

// The Standalone catalog entry for an external release: exact asset URLs with the release.json pins,
// plus its prerequisite note and links. registry/standalone.json must equal it (test/standalone.test.mjs).
export function externalCatalog(spec) {
  const repository = `https://github.com/${spec.repository}`;
  const downloads = Object.entries(spec.targets).map(([platform, target]) => ({
    kind: 'cli',
    platform,
    version: spec.version,
    url: `${repository}/releases/download/${spec.tag}/${target.asset}`,
    sha256: target.sha256,
    bytes: target.bytes,
    command: portableCommand(spec, platform, target.asset),
  }));
  const commandLine = {
    notes: spec.readme.notes,
    links: [
      { label: `${spec.displayName} ${spec.tag} release`, url: `${repository}/releases/tag/${spec.tag}` },
      { label: spec.repository, url: repository },
    ],
  };
  return { downloads, commandLine };
}
