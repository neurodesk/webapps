#!/usr/bin/env node
// Runs a disconnectome command line on every pinned example lesion of the web app, against both
// atlases. Each table must be byte-identical to the native nii2tvx output committed in
// exes/nii2tvx/test (make test-real diffs those against the C tool), header plus that lesion's
// row. A lesion off the atlas grid must be refused with the app's advice and write nothing.
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';

const examples = JSON.parse(await readFile(new URL('../../../apps/disconnectome/examples.json', import.meta.url), 'utf8'));
const GOLDEN = {
  enigma: new URL('../../../exes/nii2tvx/test/expected-examples-enigma.tsv', import.meta.url),
  hcp1065: new URL('../../../exes/nii2tvx/test/expected-examples.tsv', import.meta.url),
};
const WRONG_GRID = fileURLToPath(new URL('../../../exes/nii2tvx/test/fixtures/lesion.nii.gz', import.meta.url));
const { values } = parseArgs({ options: { executable: { type: 'string' } } });
const command = values.executable
  ? [resolve(values.executable)]
  : [process.execPath, fileURLToPath(new URL('../bin/disconnectome.js', import.meta.url))];

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const failures = [];
function check(passed, line) {
  if (!passed) failures.push(line);
  console.log(`${passed ? 'PASS' : 'FAIL'} ${line}`);
}

async function pinned({ name, url, sha256: expected }) {
  const path = join(tmpdir(), 'neurodesk-disconnectome-validation', expected, name);
  const cached = await readFile(path).catch(() => null);
  if (cached && sha256(cached) === expected) return path;
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${url}: HTTP ${response.status}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  if (sha256(bytes) !== expected) throw new Error(`${url}: SHA-256 differs from its pin`);
  await mkdir(join(path, '..'), { recursive: true });
  await writeFile(`${path}.partial`, bytes);
  await rename(`${path}.partial`, path);
  return path;
}

function disconnectome(...args) {
  const started = performance.now();
  const run = spawnSync(command[0], [...command.slice(1), ...args], { stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8' });
  if (run.error) throw run.error;
  return { ...run, seconds: (performance.now() - started) / 1000 };
}

const work = await mkdtemp(join(tmpdir(), 'disconnectome-cli-check-'));
try {
  for (const [atlas, golden] of Object.entries(GOLDEN)) {
    const [header, ...rows] = (await readFile(golden, 'utf8')).trimEnd().split('\n');
    for (const example of examples) {
      const lesion = example.files.find(({ role }) => role === 'image');
      const id = lesion.name.replace(/\.nii(\.gz)?$/i, '');
      const row = rows.find((line) => line.split('\t')[0] === id);
      if (!row) throw new Error(`${golden.pathname} has no row for ${id}`);
      const output = join(work, `${atlas}-${id}`);
      const run = disconnectome(await pinned(lesion), output, '--atlas', atlas);
      if (run.status !== 0) throw new Error(`${command.join(' ')} exited with ${run.status}:\n${run.stderr}`);
      const name = `${id}_${atlas}_disconnectome.tsv`;
      const table = await readFile(join(output, name), 'utf8').catch(() => '');
      const summary = run.stderr.trim().split('\n').at(-1);
      check(table === `${header}\n${row}\n`, `${name} identical to native nii2tvx (${sha256(table).slice(0, 12)}; ${summary}; ${run.seconds.toFixed(1)} s)`);
    }
  }
  const output = join(work, 'wrong-grid');
  const refused = disconnectome(WRONG_GRID, output);
  const advice = refused.stderr.split('\n').find((line) => line.startsWith('Not on the'));
  check(refused.status === 1 && advice === 'Not on the 182 × 218 × 182 MNI152 grid; normalize it with SYNcro first.', `off-grid lesion refused: ${advice}`);
  check(!(await readdir(output).catch(() => null)), 'off-grid lesion wrote nothing');
} finally {
  await rm(work, { recursive: true, force: true });
}
console.log(failures.length ? `FAIL ${failures.length} disconnectome command-line checks` : 'PASS disconnectome command line matches native nii2tvx on every example and atlas');
process.exitCode = failures.length ? 1 : 0;
