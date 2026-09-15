import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import { join, resolve } from 'node:path';
import { readFile } from 'node:fs/promises';
import { prepareReleaseFiles } from './release-files.mjs';
import { fileHash, verifyBundle } from '../../packages/desktop/src/bundle.js';

const root = resolve(import.meta.dirname, '../..');
const projectDir = join(root, 'packages/desktop');
const require = createRequire(join(projectDir, 'package.json'));
const { build } = require('electron-builder');
await verifyBundle(join(projectDir, 'resources'));
const artifacts = await build({ projectDir, publish: 'never', config: { executableName: 'neurodesk-webapps' } });
const executable = process.platform === 'darwin'
  ? join(projectDir, 'release/mac-arm64/neurodesk-webapps.app/Contents/MacOS/neurodesk-webapps')
  : process.platform === 'win32'
    ? join(projectDir, 'release/win-unpacked/neurodesk-webapps.exe')
    : join(projectDir, 'release/linux-unpacked/neurodesk-webapps');
const report = process.env.NEURODESK_TEST_REPORT || join(projectDir, 'release/test-report');
const packagedResources = process.platform === 'darwin'
  ? resolve(executable, '../../Resources/offline')
  : join(resolve(executable, '..'), 'resources/offline');
await verifyBundle(packagedResources);
await new Promise((resolve, reject) => {
  const child = spawn(process.execPath, [join(root, 'scripts/desktop/smoke.mjs')], {
    stdio: 'inherit',
    env: { ...process.env, NEURODESK_EXECUTABLE: executable, NEURODESK_BUNDLE: packagedResources, NEURODESK_TEST_REPORT: report },
  });
  child.on('error', reject);
  child.on('exit', code => code === 0 ? resolve() : reject(new Error(`Packaged application test failed: ${code}`)));
});
const version = JSON.parse(await readFile(join(projectDir, 'package.json'))).version;
const platform = { darwin: 'macos-arm64', linux: 'linux-x64', win32: 'windows-x64' }[process.platform];
for (const path of artifacts.filter(path => /\.(zip|tar\.gz)$/.test(path))) {
  console.log(await prepareReleaseFiles(path, join(projectDir, 'release/github'), { version, platform }));
}
