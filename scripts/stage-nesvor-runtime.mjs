import { createRequire } from 'node:module';
import { realpathSync } from 'node:fs';
import { readFile, mkdir, copyFile, rename, rm, writeFile } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { downloadBytes } from './lib/download-bytes.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));

function verifyAsset(bytes, record) {
  return bytes.length === record.bytes
    && createHash('sha256').update(bytes).digest('hex') === record.sha256;
}

async function writeFileAtomic(targetPath, bytes) {
  const tempPath = `${targetPath}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await writeFile(tempPath, bytes);
    await rename(tempPath, targetPath);
  } catch (error) {
    await rm(tempPath, { force: true }).catch(() => {});
    throw error;
  }
}

export async function stageN4Runtime({
  manifest,
  outputDir,
  cacheDir,
  sourceDir,
  rootDir = root,
  fetchImpl = globalThis.fetch,
  attempts = 5,
  timeoutMs = 120_000,
  wait,
  log = console.warn,
}) {
  await mkdir(outputDir, { recursive: true });
  if (!sourceDir) {
    await mkdir(cacheDir, { recursive: true });
  }
  for (const record of manifest.files) {
    let bytes;
    if (sourceDir) {
      bytes = await readFile(resolve(sourceDir, record.file));
      if (!verifyAsset(bytes, record)) {
        throw new Error(`N4 asset verification failed: ${record.file}`);
      }
    } else {
      const cached = join(cacheDir, `${record.sha256}-${record.file}`);
      bytes = await readFile(cached).catch(() => null);
      if (!bytes || !verifyAsset(bytes, record)) {
        const url = new URL(record.file, manifest.base_url);
        const downloadOptions = {
          attempts,
          timeoutMs,
          fetcher: fetchImpl,
          log,
        };
        if (wait !== undefined) {
          downloadOptions.wait = wait;
        }
        bytes = await downloadBytes(url, downloadOptions);
        if (!verifyAsset(bytes, record)) {
          throw new Error(`N4 asset verification failed: ${record.file}`);
        }
        await writeFileAtomic(cached, bytes);
      }
    }
    await writeFile(join(outputDir, record.file), bytes);
  }
  await copyFile(join(rootDir, 'packages/nesvor/native-n4/NOTICE'), join(outputDir, 'NOTICE'));
  await copyFile(join(rootDir, 'packages/nesvor/native-n4/LICENSE.Apache-2.0'), join(outputDir, 'LICENSE.Apache-2.0'));
  await copyFile(join(rootDir, 'packages/nesvor/LICENSE'), join(outputDir, 'LICENSE.MIT'));
}

async function main() {
  const require = createRequire(join(root, 'packages/nesvor/package.json'));
  const runtime = dirname(require.resolve('onnxruntime-web/wasm'));
  const output = join(root, 'apps/nesvor/public/ort');
  await rm(output, { recursive: true, force: true });
  await mkdir(output, { recursive: true });
  const runtimeName = 'ort-wasm-simd-threaded.asyncify';
  await copyFile(join(runtime, `${runtimeName}.mjs`), join(output, `${runtimeName}.mjs`));
  await writeFile(join(output, `${runtimeName}.wasm.gz`), gzipSync(await readFile(join(runtime, `${runtimeName}.wasm`)), { level: 9 }));

  const modelOutput = join(root, 'apps/nesvor/public/svort');
  const source = process.env.NESVOR_MODEL_DIR;
  if (source) {
    const manifest = JSON.parse(await readFile(join(root, 'packages/nesvor/src/registration/svort-manifest.json'), 'utf8'));
    for (const record of manifest.models) {
      const bytes = await readFile(resolve(source, record.file));
      if (!verifyAsset(bytes, record)) {
        throw new Error(`SVoRT asset verification failed: ${record.file}`);
      }
    }
    await mkdir(modelOutput, { recursive: true });
    for (const record of manifest.models) {
      await copyFile(resolve(source, record.file), join(modelOutput, record.file));
    }
  } else {
    await rm(modelOutput, { recursive: true, force: true });
    console.log('SVoRT uses pinned hosted models. Set NESVOR_MODEL_DIR to bundle the verified models locally.');
  }

  const n4Manifest = JSON.parse(await readFile(join(root, 'packages/nesvor/src/n4/manifest.json'), 'utf8'));
  const n4Output = join(root, 'apps/nesvor/public/n4');
  const n4Cache = join(process.env.TMPDIR || process.env.RUNNER_TEMP || join(homedir(), '.cache'), 'nesvor-runtime-cache', 'n4');
  await stageN4Runtime({
    manifest: n4Manifest,
    outputDir: n4Output,
    cacheDir: n4Cache,
    sourceDir: process.env.NESVOR_N4_DIR,
  });
  console.log('Staged verified ITK N4 WebAssembly runtime.');
}

function isMainModule(metaUrl) {
  if (!process.argv[1]) return false;
  try {
    return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(metaUrl));
  } catch {
    return pathToFileURL(resolve(process.argv[1])).href === metaUrl;
  }
}

if (isMainModule(import.meta.url)) {
  await main();
}
