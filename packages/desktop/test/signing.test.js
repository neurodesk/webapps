import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';

const require = createRequire(import.meta.url);
const builder = createRequire(require.resolve('electron-builder'));
const appBuilder = createRequire(builder.resolve('app-builder-lib'));
const signer = createRequire(appBuilder.resolve('@electron/osx-sign'));

test('the macOS signer bounds protobuf lengths while scanning model data', () => {
  const dependency = signer.resolve('isbinaryfile');
  // A model prefix can look like a protobuf record with an enormous length.
  // Run with a small memory limit so a dependency regression fails safely.
  const source = `const { isBinaryFileSync } = require(${JSON.stringify(dependency)}); const data = Buffer.concat([Buffer.from([0x72, 0xff, 0xff, 0xff, 0xff, 0x07]), Buffer.from('a'.repeat(506))]); process.stdout.write(String(typeof isBinaryFileSync(data, data.length)));`;
  assert.equal(execFileSync(process.execPath, ['--max-old-space-size=64', '-e', source], { timeout: 3000, encoding: 'utf8' }), 'boolean');
});
