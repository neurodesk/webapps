import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cp, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import test from 'node:test';

const run = promisify(execFile);
const repo = new URL('../', import.meta.url);
const bytes = 'complete pinned runtime';
const sha256 = createHash('sha256').update(bytes).digest('hex');

async function fixture(t, fetchSource) {
  const root = await mkdtemp(join(tmpdir(), 'runtime-staging-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, 'scripts'));
  await mkdir(join(root, 'runtime-assets'));
  const destination = join(root, 'public/wasm');
  await mkdir(destination, { recursive: true });
  await cp(new URL('scripts/fetch-app-runtime.mjs', repo), join(root, 'scripts/fetch-app-runtime.mjs'));
  await symlink(new URL('scripts/lib', repo), join(root, 'scripts/lib'), 'dir');
  await writeFile(join(root, 'runtime-assets/manifest.json'), JSON.stringify({
    schema_version: 1, families: [{
      id: 'fixture', version: '1', download_base: 'https://cdn.example/pinned',
      files: [{ name: 'ort-runtime.wasm', sha256 }],
    }],
  }));
  const preload = join(root, 'fetch.mjs');
  await writeFile(preload, `let requests = 0;\nglobalThis.fetch = async () => {\nrequests++;\n${fetchSource}\n};\n`);
  return {
    destination,
    stage: () => run(process.execPath, ['--import', preload, join(root, 'scripts/fetch-app-runtime.mjs'),
      '--dest', destination, 'fixture:ort-runtime.wasm'], { timeout: 20000 }),
  };
}

test('runtime staging retries interrupted downloads, verifies bytes and reuses them without a fetch', async t => {
  const { destination, stage } = await fixture(t, `
    if (requests === 1) return new Response(new ReadableStream({ start(controller) { controller.error(new Error('connection reset')); } }));
    return new Response(${JSON.stringify(bytes)});
  `);
  await writeFile(join(destination, 'ort-obsolete.wasm'), 'obsolete');
  const { stdout, stderr } = await stage();
  assert.match(stdout, /Verified 1 runtime files/);
  assert.match(stderr, /connection reset.*retrying attempt 2\/4/);
  assert.equal(await readFile(join(destination, 'ort-runtime.wasm'), 'utf8'), bytes);
  assert.deepEqual(await readdir(destination), ['ort-runtime.wasm']);
  const cached = await stage();
  assert.match(cached.stdout, /already up to date/);
  assert.equal(cached.stderr, '');
  assert.equal(await readFile(join(destination, 'ort-runtime.wasm'), 'utf8'), bytes);
});

test('corrupt downloads preserve the existing runtime and leave no temporary files', async t => {
  const { destination, stage } = await fixture(t, 'return new Response("corrupt runtime");');
  await writeFile(join(destination, 'ort-runtime.wasm'), 'previous runtime');
  await assert.rejects(stage(), error => {
    assert.match(error.stderr, /Checksum mismatch for https:\/\/cdn\.example\/pinned\/ort-runtime\.wasm/);
    assert.doesNotMatch(error.stderr, /retrying attempt/);
    return true;
  });
  assert.equal(await readFile(join(destination, 'ort-runtime.wasm'), 'utf8'), 'previous runtime');
  assert.deepEqual(await readdir(destination), ['ort-runtime.wasm']);
});
