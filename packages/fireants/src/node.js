import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { availableParallelism } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { checkSupport, register } from '@fireants/fireants';
import { registeredFileName } from './outputs.js';

// The web app's automation operation offers these presets; rigid and affine alone are not exposed.
export const TRANSFORMS = Object.freeze(['greedy', 'syn']);

// The engine requires a limit. A command line run is stopped with Ctrl-C instead, so this only
// catches a stalled module.
const TIMEOUT_MS = 24 * 60 * 60 * 1000;

const require = createRequire(import.meta.url);
const enginePackage = require('@fireants/fireants/package.json');
const engineDirectory = join(dirname(require.resolve('@fireants/fireants/package.json')), 'dist');

export function resolveThreads(value = process.env.SLURM_CPUS_PER_TASK || availableParallelism()) {
  const threads = typeof value === 'string' && /^[1-9]\d*$/.test(value) ? Number(value) : value;
  if (!Number.isSafeInteger(threads) || threads < 1) throw new Error(`Threads must be a positive integer, not "${value}".`);
  return threads;
}

// The engine logs one "<Stage>: <seconds>s (NCC <value>)" line per stage; the last is the result.
export function finalNcc(log) {
  const values = [...log.matchAll(/^\s*\w+: [\d.]+s \(NCC (-?\d+(?:\.\d+)?)\)/gm)].map((match) => Number(match[1]));
  return values.length ? values.at(-1) : null;
}

export async function checkInstallation() {
  const support = checkSupport();
  if (!support.threaded) throw new Error(`Threaded WebAssembly is unavailable: ${support.reasons.join('; ')}`);
  for (const name of ['cfireants-mt.wasm', 'cfireants.wasm']) await WebAssembly.compile(await readFile(join(engineDirectory, name)));
  return {
    platform: process.platform,
    arch: process.arch,
    node: process.version,
    executable: process.execPath,
    engine: `@fireants/fireants ${enginePackage.version}`,
    backend: 'cpu',
    threads: resolveThreads(),
  };
}

async function assertNewOutput(directory) {
  let entries;
  try {
    entries = await readdir(directory);
  } catch (error) {
    if (error.code === 'ENOENT') return;
    throw error;
  }
  if (entries.length) throw new Error(`Output directory ${directory} is not empty. Choose a new or empty directory.`);
}

export async function registerImages({ moving, fixed, output, transform = 'greedy', threads, verbose = 1, onLog = () => {} }) {
  if (!moving || !fixed || !output) throw new Error('A moving image, a fixed image and an output directory are required.');
  if (!TRANSFORMS.includes(transform)) throw new Error(`Transform must be ${TRANSFORMS.join(' or ')}, not "${transform}".`);
  const threadCount = resolveThreads(threads);
  const destination = resolve(output);
  await assertNewOutput(destination);
  const [movingBytes, fixedBytes] = await Promise.all([readFile(moving), readFile(fixed)]);
  const result = await register(fixedBytes, movingBytes, {
    backend: 'cpu',
    transform,
    threads: threadCount,
    worker: false,
    gzip: true,
    verbose,
    timeoutMs: TIMEOUT_MS,
    onLog,
  });
  const name = registeredFileName(basename(moving));
  await mkdir(destination, { recursive: true });
  await writeFile(join(destination, name), new Uint8Array(result.image));
  return {
    output: destination,
    files: [name],
    transform,
    variant: result.variant,
    threads: result.threads,
    engineSeconds: result.elapsedMs / 1000,
    ncc: finalNcc(result.log),
  };
}
