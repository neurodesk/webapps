import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { createComputeClient } from '../../../packages/components/src/compute/index.js';
import { analysisFixture as fixture, ANALYSIS_CASES as cases } from './analysis-fixtures.mjs';
import { SCT_IMAGE, SCT_VERSION } from '../web/js/app/analysis-spec.js';

const run = promisify(execFile);
const baseUrl = process.env.COMPUTE_SERVER_URL;
const code = process.env.COMPUTE_SERVER_TOKEN;
assert.ok(baseUrl && code, 'Set COMPUTE_SERVER_URL and COMPUTE_SERVER_TOKEN for a Docker compute server');
const docker = process.env.DOCKER || 'docker';
const directory = await mkdtemp(join(tmpdir(), 'sct-native-parity-'));
const client = createComputeClient({ baseUrl });
await client.pair(code);
const info = await client.info();
assert.equal(info.simulated, false, 'A simulated server cannot establish SCT parity');
assert.equal(info.runner, 'docker');
assert.equal(info.tools.find(tool => tool.id === 'sct')?.image, SCT_IMAGE);
const { stdout: version } = await run(docker, ['run', '--rm', '--network', 'none', SCT_IMAGE, 'sct_version']);
assert.equal(version.trim(), SCT_VERSION);


try {
  for (const item of cases) {
    const root = join(directory, item.id);
    for (const name of ['in', 'out', 'api']) await mkdir(join(root, name), { recursive: true });
    const suffix = item.compressed === false ? '.nii' : '.nii.gz';
    const spec = { tool: 'sct', command: item.command, options: item.options };
    const files = {};
    for (const [role, kind] of Object.entries(item.roles)) {
      spec[role] = role;
      const bytes = fixture(kind, item.compressed !== false);
      files[role] = new File([bytes], role + suffix);
      await writeFile(join(root, 'in', role + suffix), bytes);
    }
    const receipt = await client.submit(spec, files);
    const result = await client.watch(receipt.id);
    assert.equal(result.status, 'succeeded');
    assert.equal(result.simulated, false);
    await writeFile(join(root, 'receipt.json'), JSON.stringify({ spec, result }, null, 2));
    for (const output of result.outputs) {
      const bytes = Buffer.from(await (await client.output(receipt.id, output.name)).arrayBuffer());
      await writeFile(join(root, 'api', output.name), bytes);
      if (process.env.COMPUTE_SERVER_DATA && output.name !== 'log.txt') {
        const native = await readFile(join(process.env.COMPUTE_SERVER_DATA, 'jobs', receipt.id, 'out', output.name));
        assert.deepEqual(bytes, native, `${item.id}/${output.name} download bytes`);
      }
    }
    const argv = item.command === 'process_segmentation'
      ? ['sct_process_segmentation', '-i', `/job/in/cord${suffix}`, '-o', '/job/out/morphometry.csv', ...item.flags]
      : ['sct_analyze_lesion', '-m', `/job/in/lesion${suffix}`, ...(item.roles.cord ? ['-s', `/job/in/cord${suffix}`] : []), '-ofolder', '/job/out'];
    const user = typeof process.getuid === 'function' ? ['--user', `${process.getuid()}:${process.getgid()}`] : [];
    const direct = await run(docker, ['run', '--rm', '--network', 'none', ...user, '-v', `${root}:/job`, SCT_IMAGE, ...argv], { maxBuffer: 5 * 1024 * 1024 });
    await writeFile(join(root, 'direct.log'), direct.stdout + direct.stderr);
  }
  const comparison = fileURLToPath(new URL('./compare_native_analysis.py', import.meta.url));
  const result = await run(docker, ['run', '--rm', '--network', 'none', '-v', `${directory}:/job:ro`, '-v', `${comparison}:/compare.py:ro`, SCT_IMAGE,
    '/opt/spinalcordtoolbox-7.3.3/python/envs/venv_sct/bin/python3.10', '/compare.py'], { maxBuffer: 1024 * 1024 });
  console.log(result.stdout.trim());
} finally {
  await client.disconnect();
  console.log(`Native reference artifacts: ${directory}`);
}
