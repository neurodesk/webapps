import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { stageN4Runtime } from '../scripts/stage-nesvor-runtime.mjs';

function makeRecord(file, content) {
  const bytes = Buffer.from(content);
  return {
    file,
    bytes: bytes.length,
    sha256: createHash('sha256').update(bytes).digest('hex'),
    data: bytes,
  };
}

function makeManifest(records) {
  return {
    schema: 1,
    base_url: 'https://huggingface.co/datasets/neurodeskorg/webapps/resolve/0123456789abcdef0123456789abcdef01234567/runtimes/nesvor/n4-test/',
    files: records.map(({ file, bytes, sha256 }) => ({ file, bytes, sha256 })),
  };
}

async function makeTempDirs(t) {
  const scratch = await mkdtemp(join(tmpdir(), 'stage-nesvor-runtime-'));
  t.after(() => rm(scratch, { recursive: true, force: true }));
  return {
    scratch,
    outputDir: join(scratch, 'public/n4'),
    cacheDir: join(scratch, 'cache/n4'),
    sourceDir: join(scratch, 'offline-n4'),
  };
}

test('stageN4Runtime retries transient ECONNRESET and HTTP 503 failures and caches verified bytes atomically', async (t) => {
  const { outputDir, cacheDir } = await makeTempDirs(t);
  const loader = makeRecord('nesvor-n4.mjs', 'export const n4 = "ok";\n');
  const wasm = makeRecord('nesvor-n4.wasm', '\0asm\x01\x00\x00\x00nesvor-wasm');
  const manifest = makeManifest([loader, wasm]);

  const attempts = new Map();
  const logs = [];
  const fetchImpl = async (url) => {
    const name = new URL(url).pathname.split('/').pop();
    const count = (attempts.get(name) ?? 0) + 1;
    attempts.set(name, count);
    if (name === 'nesvor-n4.mjs' && count === 1) {
      throw new TypeError('fetch failed', {
        cause: Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' }),
      });
    }
    if (name === 'nesvor-n4.wasm' && count === 1) {
      return new Response('Service Unavailable', { status: 503 });
    }
    const record = name === loader.file ? loader : wasm;
    return new Response(record.data, { status: 200 });
  };

  await stageN4Runtime({
    manifest,
    outputDir,
    cacheDir,
    fetchImpl,
    baseDelay: 0,
    maxDelay: 0,
    log: (message) => logs.push(message),
  });

  assert.equal(attempts.get(loader.file), 2);
  assert.equal(attempts.get(wasm.file), 2);
  assert.equal(logs.length, 2);
  assert.match(logs[0], /nesvor-n4\.mjs.*network error/);
  assert.match(logs[1], /nesvor-n4\.wasm.*HTTP 503/);

  assert.deepEqual(await readFile(join(outputDir, loader.file)), loader.data);
  assert.deepEqual(await readFile(join(outputDir, wasm.file)), wasm.data);
  assert.ok((await readFile(join(outputDir, 'NOTICE'), 'utf8')).length > 0);
  assert.ok((await readFile(join(outputDir, 'LICENSE.Apache-2.0'), 'utf8')).length > 0);
  assert.ok((await readFile(join(outputDir, 'LICENSE.MIT'), 'utf8')).length > 0);

  const cacheEntries = (await readdir(cacheDir)).sort();
  assert.deepEqual(cacheEntries, [
    `${loader.sha256}-${loader.file}`,
    `${wasm.sha256}-${wasm.file}`,
  ].sort());
  assert.deepEqual(await readFile(join(cacheDir, `${loader.sha256}-${loader.file}`)), loader.data);
  assert.deepEqual(await readFile(join(cacheDir, `${wasm.sha256}-${wasm.file}`)), wasm.data);
});

test('stageN4Runtime rejects checksum and size mismatches without polluting the cache or output', async (t) => {
  const { outputDir, cacheDir } = await makeTempDirs(t);
  const loader = makeRecord('nesvor-n4.mjs', 'export const n4 = "expected";\n');
  const manifest = makeManifest([loader]);

  // Same byte length, wrong SHA-256.
  const wrongHash = Buffer.from('export const n4 = "corrupt!";\n');
  assert.equal(wrongHash.length, loader.bytes);
  await assert.rejects(
    stageN4Runtime({
      manifest,
      outputDir,
      cacheDir,
      fetchImpl: async () => new Response(wrongHash, { status: 200 }),
      baseDelay: 0,
      log: () => {},
    }),
    /N4 asset verification failed: nesvor-n4\.mjs/,
  );
  assert.deepEqual(await readdir(cacheDir), []);
  assert.deepEqual(await readdir(outputDir), []);

  // Wrong byte length.
  await assert.rejects(
    stageN4Runtime({
      manifest,
      outputDir,
      cacheDir,
      fetchImpl: async () => new Response(Buffer.from('short'), { status: 200 }),
      baseDelay: 0,
      log: () => {},
    }),
    /N4 asset verification failed: nesvor-n4\.mjs/,
  );
  assert.deepEqual(await readdir(cacheDir), []);
  assert.deepEqual(await readdir(outputDir), []);
});

test('stageN4Runtime reuses valid cached bytes without network fetches and replaces corrupt cache entries', async (t) => {
  const { outputDir, cacheDir } = await makeTempDirs(t);
  const loader = makeRecord('nesvor-n4.mjs', 'export const cached = true;\n');
  const manifest = makeManifest([loader]);

  await mkdir(cacheDir, { recursive: true });
  const cachePath = join(cacheDir, `${loader.sha256}-${loader.file}`);
  await writeFile(cachePath, loader.data);

  let fetches = 0;
  await stageN4Runtime({
    manifest,
    outputDir,
    cacheDir,
    fetchImpl: async () => {
      fetches++;
      throw new Error('should not fetch when cache is valid');
    },
    baseDelay: 0,
    log: () => {},
  });
  assert.equal(fetches, 0);
  assert.deepEqual(await readFile(join(outputDir, loader.file)), loader.data);

  // Corrupt cached bytes should trigger a fresh verified fetch and atomic replacement.
  await writeFile(cachePath, Buffer.from('corrupt'));
  await stageN4Runtime({
    manifest,
    outputDir,
    cacheDir,
    fetchImpl: async () => {
      fetches++;
      return new Response(loader.data, { status: 200 });
    },
    baseDelay: 0,
    log: () => {},
  });
  assert.equal(fetches, 1);
  assert.deepEqual(await readFile(cachePath), loader.data);
  assert.deepEqual(await readdir(cacheDir), [`${loader.sha256}-${loader.file}`]);
});

test('stageN4Runtime stages verified offline files from sourceDir without network or cache access', async (t) => {
  const { outputDir, cacheDir, sourceDir } = await makeTempDirs(t);
  const loader = makeRecord('nesvor-n4.mjs', 'export const offline = true;\n');
  const wasm = makeRecord('nesvor-n4.wasm', '\0asm\x01\x00\x00\x00offline');
  const manifest = makeManifest([loader, wasm]);

  await mkdir(sourceDir, { recursive: true });
  await writeFile(join(sourceDir, loader.file), loader.data);
  await writeFile(join(sourceDir, wasm.file), wasm.data);

  let fetches = 0;
  await stageN4Runtime({
    manifest,
    outputDir,
    cacheDir,
    sourceDir,
    fetchImpl: async () => {
      fetches++;
      throw new Error('offline staging must not fetch');
    },
    log: () => {},
  });

  assert.equal(fetches, 0);
  assert.deepEqual(await readFile(join(outputDir, loader.file)), loader.data);
  assert.deepEqual(await readFile(join(outputDir, wasm.file)), wasm.data);
  await assert.rejects(readdir(cacheDir), { code: 'ENOENT' });

  // Corrupt offline source fails verification.
  await writeFile(join(sourceDir, wasm.file), Buffer.from('tampered'));
  await assert.rejects(
    stageN4Runtime({
      manifest,
      outputDir,
      cacheDir,
      sourceDir,
      log: () => {},
    }),
    /N4 asset verification failed: nesvor-n4\.wasm/,
  );
});

test('stageN4Runtime fails immediately on non-retryable HTTP status without polluting cache', async (t) => {
  const { outputDir, cacheDir } = await makeTempDirs(t);
  const loader = makeRecord('nesvor-n4.mjs', 'export const missing = false;\n');
  const manifest = makeManifest([loader]);

  let calls = 0;
  await assert.rejects(
    stageN4Runtime({
      manifest,
      outputDir,
      cacheDir,
      fetchImpl: async () => {
        calls++;
        return new Response('Not Found', { status: 404 });
      },
      baseDelay: 0,
      log: () => {},
    }),
    /404/,
  );

  assert.equal(calls, 1);
  assert.deepEqual(await readdir(cacheDir), []);
  assert.deepEqual(await readdir(outputDir), []);
});
