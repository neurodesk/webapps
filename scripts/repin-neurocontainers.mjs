#!/usr/bin/env node
// Re-pins Neurocontainers images whose .simg Neurocontainers deleted when it
// rebuilt the version. For each container in registry/neurocontainers.json
// served from neurocontainers.neurodesk.workers.dev whose image is gone, reads
// the build the version's release metadata now names
// (neurodesk/neurocontainers releases/<recipe>/<version>.json), and pins that
// build's .simg, Docker tag and digest, and the recipe at the release commit.
// Copies the change into registry/standalone.json. The standalone-links
// workflow runs this after its nightly check fails and opens a pull request.
// NeSVoR and Spinal Cord Toolbox need coordinated compute-server pin updates.
//
//   node scripts/repin-neurocontainers.mjs [--write] [--body body.md]
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkLink } from './check-standalone-links.mjs';

const SIMG_HOST = 'https://neurocontainers.neurodesk.workers.dev/';
const REPO = 'neurodesk/neurocontainers';

// The recipe name, version and build an apptainerName (`<recipe>_<version>_<build>`) encodes.
export function parseApptainerName(name) {
  const match = /^(.+)_([^_]+)_(\d{8})$/.exec(name);
  return match && { recipe: match[1], version: match[2], build: match[3] };
}

// The neurocontainers.json entry pinned to `release` ({ build, digest, releaseSha }).
export function repinnedEntry(entry, release) {
  const { recipe, version } = parseApptainerName(entry.apptainerName);
  const repository = entry.dockerImage.slice(0, entry.dockerImage.lastIndexOf(':'));
  const name = `${recipe}_${version}_${release.build}`;
  return {
    ...entry,
    label: `${recipe} ${version} (${release.build})`,
    buildDate: release.build,
    image: `${repository}@${release.digest}`,
    digest: release.digest,
    source: `https://raw.githubusercontent.com/${REPO}/${release.releaseSha}/recipes/${recipe}/build.yaml`,
    dockerImage: `${repository}:${release.build}`,
    apptainerUrl: `${SIMG_HOST}${name}.simg`,
    apptainerName: name,
  };
}

// Applies `repins` (key -> new neurocontainers.json entry) to both catalogs, in
// place. A Standalone container follows the record whose apptainerName it carries.
export function applyRepins(registry, standalone, repins) {
  for (const [key, entry] of Object.entries(repins)) {
    const previous = registry.containers[key].apptainerName;
    registry.containers[key] = entry;
    for (const app of Object.values(standalone.apps)) {
      for (const container of app.containers ?? []) {
        if (container.apptainerName !== previous) continue;
        for (const field of ['label', 'dockerImage', 'apptainerUrl', 'apptainerName']) container[field] = entry[field];
      }
    }
  }
}

async function json(url, headers = {}) {
  const response = await fetch(url, { headers, signal: AbortSignal.timeout(30_000) });
  if (!response.ok) throw new Error(`${url}: ${response.status}`);
  return response.json();
}

// The build the release metadata names for `recipe` `version`, its Docker
// digest and the release commit, from GitHub and Docker Hub.
async function currentRelease(recipe, version, repository) {
  const headers = process.env.GITHUB_TOKEN ? { authorization: `Bearer ${process.env.GITHUB_TOKEN}` } : {};
  const path = `releases/${recipe}/${version}.json`;
  const [commit] = await json(`https://api.github.com/repos/${REPO}/commits?path=${path}&per_page=1`, headers);
  if (!commit) throw new Error(`${REPO} has no ${path}`);
  const metadata = await json(`https://raw.githubusercontent.com/${REPO}/${commit.sha}/${path}`);
  const build = metadata.apps?.[`${recipe} ${version}`]?.version;
  if (!/^\d{8}$/.test(build ?? '')) throw new Error(`${path} names no build for ${recipe} ${version}`);
  const tag = await json(`https://hub.docker.com/v2/repositories/${repository}/tags/${build}`);
  if (typeof tag?.digest !== 'string' || !/^sha256:[a-f0-9]{64}$/.test(tag.digest)) {
    throw new Error(`${repository}:${build} has no valid SHA-256 digest`);
  }
  return { build, digest: tag.digest, releaseSha: commit.sha };
}

async function main() {
  const args = process.argv.slice(2);
  const bodyPath = args.includes('--body') ? args[args.indexOf('--body') + 1] : null;
  const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
  const registryPath = resolve(root, 'registry/neurocontainers.json');
  const standalonePath = resolve(root, 'registry/standalone.json');
  const registry = JSON.parse(await readFile(registryPath, 'utf8'));
  const standalone = JSON.parse(await readFile(standalonePath, 'utf8'));
  const repins = {};
  const rows = [];
  const unresolved = [];
  for (const [key, entry] of Object.entries(registry.containers)) {
    if (!entry.apptainerUrl?.startsWith(SIMG_HOST)) continue;
    const link = await checkLink(entry.apptainerUrl);
    if (link.ok || link.status !== 404) continue;
    const parsed = parseApptainerName(entry.apptainerName);
    try {
      if (!parsed) throw new Error(`cannot read recipe and version from ${entry.apptainerName}`);
      if (['nesvor', 'spinalcordtoolbox'].includes(parsed.recipe)) {
        throw new Error(`${parsed.recipe} needs a coordinated update of its catalog, compute server, reference server, and documentation pins`);
      }
      const repository = entry.dockerImage.slice(0, entry.dockerImage.lastIndexOf(':'));
      const release = await currentRelease(parsed.recipe, parsed.version, repository);
      if (release.build === parsed.build) throw new Error(`release metadata still names the deleted build ${parsed.build}`);
      const next = repinnedEntry(entry, release);
      const simg = await checkLink(next.apptainerUrl);
      if (!simg.ok) throw new Error(`${next.apptainerUrl}: ${simg.status}`);
      const row = `| ${key} | \`${entry.apptainerName}\` | \`${next.apptainerName}\` | \`${release.digest.slice(0, 19)}…\` | [release](https://github.com/${REPO}/blob/${release.releaseSha}/releases/${parsed.recipe}/${parsed.version}.json) |`;
      repins[key] = next;
      rows.push(row);
    } catch (error) {
      unresolved.push({ key, apptainerName: entry.apptainerName, reason: error.message });
    }
  }
  if (args.includes('--write')) {
    applyRepins(registry, standalone, repins);
    await writeFile(registryPath, `${JSON.stringify(registry, null, 2)}\n`);
    await writeFile(standalonePath, `${JSON.stringify(standalone, null, 2)}\n`);
  }
  if (bodyPath) {
    const body = [
      'Neurocontainers rebuilt these versions and deleted the pinned `.simg`, so the nightly `standalone-links` check failed. This pins the build each version\'s release metadata now names.',
      '',
      '| Container | Deleted | Now | Docker digest | Metadata |',
      '|---|---|---|---|---|',
      ...rows,
      '',
      'Before merging, read the recipe changes between the two builds: a rebuild can change tool versions or outputs. Opened by `scripts/repin-neurocontainers.mjs` from the `standalone-links` workflow.',
      ...(unresolved.length ? ['', 'Not re-pinned, needs a person:', ...unresolved.map((item) => `- ${item.key} (\`${item.apptainerName}\`): ${item.reason}`)] : []),
    ];
    await writeFile(bodyPath, `${body.join('\n')}\n`);
  }
  console.log(JSON.stringify({ repinned: Object.keys(repins), unresolved }, null, 2));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();

