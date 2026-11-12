// Build pinned QSMxT source; retain dcm2niix from the checksum-verified release archive.
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmod, copyFile, mkdir, mkdtemp, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';
import { downloadBytes } from '../../../scripts/lib/download-bytes.mjs';
import { EXAMPLE_ASSETS, MODEL_ASSETS, QSMXT, nativeDirectory, qsmxtVersion, releasePlatform } from '../src/node.js';
import { verifyNativeExamples, verifyNativeWeights } from '../src/native-registry.js';

const platform = process.argv[2] ?? releasePlatform();
const target = QSMXT.targets[platform];
if (!target) throw new Error(`No pinned QSMxT archive for ${platform}`);
async function pinnedSource(pin) {
  const bytes = await downloadBytes(pin.url);
  if (createHash('sha256').update(bytes).digest('hex') !== pin.sha256) {
    throw new Error('The native registry failed checksum verification.');
  }
  return bytes.toString('utf8');
}
const [models, examples] = await Promise.all([QSMXT.modelRegistry, QSMXT.exampleRegistry].map(pinnedSource));
verifyNativeWeights(models, MODEL_ASSETS, QSMXT.weightFiles);
verifyNativeExamples(examples, EXAMPLE_ASSETS);
const directory = nativeDirectory();
// Restage from verified archive bytes on every build, including npm prepack. A stamp
// cannot establish the identity of previously extracted executables.
const bytes = await downloadBytes(target.url);
const digest = createHash('sha256').update(bytes).digest('hex');
if (digest !== target.sha256) throw new Error(`${basename(target.url)} has SHA-256 ${digest}, expected ${target.sha256}`);
await mkdir(join(directory, '..'), { recursive: true });
const work = await mkdtemp(join(directory, '..', '.native-'));
try {
  const archive = join(work, basename(target.url));
  await writeFile(archive, bytes);
  const extracted = join(work, 'extracted');
  await mkdir(extracted);
  // Windows' own bsdtar reads the zip; Git for Windows puts a GNU tar, which cannot, first on PATH.
  const tar = process.platform === 'win32' ? join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe') : 'tar';
  const result = spawnSync(tar, ['-xf', archive, '-C', extracted], { encoding: 'utf8' });
  if (result.status !== 0) throw new Error(`tar could not extract ${archive}: ${result.stderr}`);
  const names = (await readdir(extracted)).sort();
  const expected = [...target.executables, ...target.files].sort();
  if (JSON.stringify(names) !== JSON.stringify(expected)) throw new Error(`${basename(target.url)} contains ${names.join(', ')}, expected ${expected.join(', ')}`);
  for (const name of target.executables) await chmod(join(extracted, name), 0o755);
  if (platform !== releasePlatform()) throw new Error('Build QSMxT on its target platform');
  const sourceBytes = await downloadBytes(QSMXT.build.url);
  if (createHash('sha256').update(sourceBytes).digest('hex') !== QSMXT.build.sha256) {
    throw new Error('QSMxT source checksum mismatch');
  }
  const sourceArchive = join(work, 'source.tar.gz');
  const source = join(work, 'source');
  const targetDirectory = process.env.CARGO_TARGET_DIR ? resolve(process.env.CARGO_TARGET_DIR) : join(source, 'target');
  await writeFile(sourceArchive, sourceBytes);
  await mkdir(source);
  for (const [command, args] of [
    [tar, ['-xf', sourceArchive, '-C', source, '--strip-components=1']],
    ['rustup', ['toolchain', 'install', QSMXT.build.toolchain, '--profile', 'minimal']],
    ['cargo', [`+${QSMXT.build.toolchain}`, 'build', '--locked', '--release', '--target-dir', targetDirectory, '--manifest-path', join(source, 'Cargo.toml')]],
  ]) {
    const result = spawnSync(command, args, { stdio: 'inherit', env: { ...process.env, QSMXT_BUILD_COMMIT: QSMXT.build.commit } });
    if (result.status !== 0) throw new Error(`${command} failed building pinned QSMxT`);
  }
  const executable = platform === 'windows-x64' ? 'qsmxt.exe' : 'qsmxt';
  await copyFile(join(targetDirectory, 'release', executable), join(extracted, executable));
  await writeFile(join(extracted, 'source.json'), `${JSON.stringify(QSMXT.build, null, 2)}\n`);
  await writeFile(join(extracted, 'archive.sha256'), `${target.sha256}\n`);
  await rm(directory, { recursive: true, force: true });
  await rename(extracted, directory);
} finally {
  await rm(work, { recursive: true, force: true });
}
console.log(`Staged QSMxT ${QSMXT.version} for ${platform} in ${directory}`);

if (platform === releasePlatform()) {
  const native = qsmxtVersion();
  if (native.version !== QSMXT.version || native.qsmCore !== QSMXT.qsmCore || native.sourceCommit !== QSMXT.build.commit || !native.deepLearning) {
    throw new Error(`Staged QSMxT reports ${JSON.stringify(native)}`);
  }
}
