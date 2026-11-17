#!/usr/bin/env node
// Download the surface fixtures the e2e suite needs.
//
// These are real cortical surfaces, so they are far too large to commit and
// would breach the artifact budget if they ever reached dist/. They live in
// test/fixtures/, which is gitignored, and are fetched on demand — the same
// pattern spinalcordtoolbox uses for its Hugging Face fixtures.
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

// Node's global fetch ignores http_proxy/https_proxy unless NODE_USE_ENV_PROXY
// is set, and that has to be in place before the runtime starts. Re-exec once
// when a proxy is configured but the flag is not, so the script works the same
// on a developer laptop and behind a corporate proxy.
if ((process.env.https_proxy || process.env.HTTPS_PROXY || process.env.http_proxy ||
     process.env.HTTP_PROXY) && !process.env.NODE_USE_ENV_PROXY) {
  const result = spawnSync(process.execPath, [fileURLToPath(import.meta.url), ...process.argv.slice(2)], {
    stdio: 'inherit',
    env: { ...process.env, NODE_USE_ENV_PROXY: '1', NODE_NO_WARNINGS: '1' }
  });
  process.exit(result.status ?? 1);
}

const here = dirname(fileURLToPath(import.meta.url));
const fixtureDir = join(here, '..', 'test', 'fixtures');

// NiiVue's demo assets: BSD-2-Clause, same licence as NiiVue itself. niivue.com
// stopped serving them, so they come from a NiiVue commit and are checked by hash.
const BASE = 'https://raw.githubusercontent.com/niivue/niivue/f353c3d2a23aa1e32d768820314da858493b2d08/packages/niivue/demos/images';
const FILES = [
  { name: 'lh.pial', sha256: 'ba74c305763c7c5dba5afd0211ac8b784b869daea8819cf37c29ff37750fd5e1' },
  { name: 'lh.curv', sha256: '77bd5c1430c9166f388cc48a62337eb19fa98e5a946fdf7cb7f18a8728bb7269' }
];

const RETRIES = 3;

const sha256 = data => createHash('sha256').update(data).digest('hex');

async function held(path, digest) {
  try { return sha256(await readFile(path)) === digest; } catch { return false; }
}

async function fetchWithRetry(url) {
  let lastError;
  for (let attempt = 1; attempt <= RETRIES; attempt++) {
    try {
      const response = await fetch(url);
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return Buffer.from(await response.arrayBuffer());
    } catch (error) {
      lastError = error;
      if (attempt < RETRIES) await new Promise((r) => setTimeout(r, attempt * 1500));
    }
  }
  throw new Error(`${url}: ${lastError.message}`);
}

await mkdir(fixtureDir, { recursive: true });

for (const file of FILES) {
  const target = join(fixtureDir, file.name);
  if (await held(target, file.sha256) && !process.env.SURFANNOTATE_FIXTURE_FORCE) {
    console.log(`have ${file.name}`);
    continue;
  }
  console.log(`fetching ${file.name}…`);
  const data = await fetchWithRetry(`${BASE}/${file.name}`);
  if (sha256(data) !== file.sha256) {
    throw new Error(`${file.name} has SHA-256 ${sha256(data)}, expected ${file.sha256}`);
  }
  await writeFile(target, data);
  console.log(`  ${file.name}: ${data.length.toLocaleString()} bytes`);
}
