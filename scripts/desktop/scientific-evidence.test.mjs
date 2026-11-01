import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmod, copyFile, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { decodeTraceValue, verifyCatalogReports, verifyPlaywright, verifySynthseg } from './scientific-evidence.mjs';

const successfulTest = () => ({ suites: [{ specs: [{ title: 'required scientific case', tests: [{ expectedStatus: 'passed', status: 'expected', results: [{ status: 'passed' }] }] }] }], errors: [] });

test('skipped, absent, retried and unexpected-failure tests cannot complete a stage', () => {
  verifyPlaywright(successfulTest(), ['required scientific case']);
  for (const mutate of [
    (report) => { report.suites[0].specs = []; },
    (report) => { report.suites[0].specs[0].tests[0].results[0].status = 'skipped'; },
    (report) => { report.suites[0].specs[0].tests[0].results.push({ status: 'passed' }); },
    (report) => { report.suites[0].specs[0].tests[0].expectedStatus = 'failed'; },
    (report) => { report.errors.push({ message: 'Worker crashed' }); },
  ]) {
    const report = successfulTest();
    mutate(report);
    assert.throws(() => verifyPlaywright(report, ['required scientific case']));
  }
});

test('native evidence requires all eight CPU/Metal cases and the probe preserves the validated cap', () => {
  const native = { selected_devices: ['cpu','metal'], failures: [], results: ['cpu','metal'].flatMap((device) => ['T1_head','T1_head_2mm'].flatMap((input) => ['fast','default'].map((mode) => ({ device, input, mode, pass: true })))) };
  verifySynthseg('native', native);
  native.results.pop();
  assert.throws(() => verifySynthseg('native', native));
  const probe = { requireHardware: true, adapter: { info: { vendor: 'apple' }, isFallbackAdapter: false }, results: [], bufferProbe: [{ allocated: false, validatedLimitBytes: 2 ** 31 - 1 }, { allocated: false, validatedLimitBytes: 2 ** 31 - 1 }] };
  verifySynthseg('probe', probe);
  probe.bufferProbe[1].validatedLimitBytes = 2 ** 32;
  assert.throws(() => verifySynthseg('probe', probe));
});

test('the trace decoder preserves false, null and shared JSON values', () => {
  const value = { o: [{ k: 'state', v: { s: 'succeeded' } }, { k: 'report', v: { o: [{ k: 'partial', v: { b: false } }, { k: 'mask', v: { v: 'null' } }], id: 2 } }, { k: 'same', v: { ref: 2 } }], id: 1 };
  const decoded = decodeTraceValue(value);
  assert.deepEqual(decoded.report, { partial: false, mask: null });
  assert.equal(decoded.same, decoded.report);
});

test('a partial tractogram is incomplete even when its browser test passes', () => {
  const report = { app: 'dwi2trx', status: 'succeeded', artifacts: Object.fromEntries(['fa','v1','tracts'].map((role) => [role, { role, sha256: 'a'.repeat(64), bytes: 10 }])), measurements: { streamlines: 10, partial: false } };
  verifyCatalogReports('dwi2trx', [report]);
  report.measurements.partial = true;
  assert.throws(() => verifyCatalogReports('dwi2trx', [report]), /incomplete/);
});

test('the shell stops on a preparation failure, saves incomplete status and restores the previous native report', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'neurodesk-macos-runner-test-'));
  const bin = join(directory, 'bin');
  for (const path of ['packages/components/src/net','scripts/desktop','packages/synthseg','packages/topofit','exes/synthseg/validation','scratch','bin']) await mkdir(join(directory, path), { recursive: true });
  for (const file of ['verify-scientific-macos.sh','scientific-evidence.mjs']) await copyFile(new URL(file, import.meta.url), join(directory, 'scripts/desktop', file));
  await copyFile(new URL('../../packages/components/src/net/fetchWithRetry.js', import.meta.url), join(directory, 'packages/components/src/net/fetchWithRetry.js'));
  for (const path of ['packages/synthseg/model.manifest.json','packages/topofit/model.manifest.json']) await writeFile(join(directory, path), '{}');
  await writeFile(join(directory, 'pnpm-lock.yaml'), 'fixture: true\n');
  const original = '{"previous":"hardware evidence"}\n';
  const nativeReport = join(directory, 'exes/synthseg/validation/report.json');
  await writeFile(nativeReport, original);
  const commands = {
    uname: '#!/bin/sh\nif [ "$1" = -s ]; then echo Darwin; else echo arm64; fi\n',
    system_profiler: '#!/bin/sh\necho "{\\"SPHardwareDataType\\":[{\\"chip_type\\":\\"test fixture\\",\\"serial_number\\":\\"omit-me\\"}]}"\n',
    git: '#!/bin/sh\nif [ "$1" = rev-parse ]; then echo test-commit; fi\n',
    pnpm: '#!/bin/sh\necho test-pnpm\n',
    make: '#!/bin/sh\necho "deliberate preparation failure"\nexit 17\n',
  };
  for (const [name, source] of Object.entries(commands)) {
    const path = join(bin, name);
    await writeFile(path, source);
    await chmod(path, 0o755);
  }
  const result = spawnSync('bash', [join(directory, 'scripts/desktop/verify-scientific-macos.sh'), 'native'], { encoding: 'utf8', env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, TMPDIR: join(directory, 'scratch') } });
  assert.equal(result.status, 17, result.stderr || result.stdout);
  const evidence = result.stdout.match(/Evidence directory: ([^\n]+)/)[1];
  const stages = JSON.parse(await readFile(join(evidence, 'stages.json')));
  assert.equal(stages.status, 'incomplete');
  assert.equal(stages.stages.native.status, 'failed');
  assert.equal(stages.stages.catalog.status, 'not-requested');
  assert.equal(await readFile(nativeReport, 'utf8'), original);
  await assert.rejects(readFile(join(evidence, 'native-parity.json')), { code: 'ENOENT' });
  assert.doesNotMatch(await readFile(join(evidence, 'hardware.json'), 'utf8'), /omit-me/);
});
