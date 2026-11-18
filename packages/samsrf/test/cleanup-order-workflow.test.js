import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { runInNewContext } from 'node:vm';
import test from 'node:test';
import { parse } from 'yaml';

const flow = parse(readFileSync(new URL('../../../.github/workflows/samsrf-native.yml', import.meta.url), 'utf8'));
const inputs = flow.on.workflow_dispatch.inputs;
const recording = flow.jobs['cleanup-order-reference'];

test('cleanup diagnostic adds a choice without adding a dispatch input or changing defaults', () => {
  assert.equal(Object.keys(inputs).length, 25);
  assert.equal(inputs.probes.default, 'none');
  assert.ok(inputs.probes.options.includes('cleanup-order-1'));
  assert.equal(inputs.include_matrix.default, true);
  assert.equal(inputs.record_matlab.default, false);
  assert.deepEqual(flow.permissions, { contents: 'read' });
  assert.equal(recording.permissions, undefined);
  assert.equal(recording.needs, undefined);
  assert.deepEqual(recording.strategy.matrix, { host: ['ubuntu-22.04', 'ubuntu-24.04'] });
  assert.equal(recording.strategy['fail-fast'], false);
  assert.equal(recording['timeout-minutes'], 15);
});

test('cleanup jobs execute two separate MATLAB processes and preserve the actual environment contract', () => {
  assert.deepEqual(recording.env, { MKL_CBWR: 'COMPATIBLE', MKL_NUM_THREADS: '1', OMP_NUM_THREADS: '1', MKL_DYNAMIC: 'FALSE', OMP_DYNAMIC: 'FALSE' });
  const calls = recording.steps.filter(step => step.uses?.startsWith('matlab-actions/run-command@'));
  assert.equal(calls.length, 2);
  assert.match(calls[0].with.command, /record_cleanup_order\(.*?,1\)$/);
  assert.match(calls[1].with.command, /record_cleanup_order\(.*?,2\)$/);
  const setup = recording.steps.findIndex(step => step.uses?.startsWith('matlab-actions/setup-matlab@'));
  const prepare = recording.steps.findIndex(step => step.run?.includes('/prepare.py'));
  assert.ok(prepare < setup);
  assert.equal(recording.steps[setup].with.release, 'R2023bU11');
  assert.equal(recording.steps[prepare].env.CLEANUP_REQUESTED_RUNNER, '${{ matrix.host }}');
  const check = recording.steps.find(step => step.run?.includes('/evaluate.py'));
  assert.match(check.run, /--commit "\$GITHUB_SHA" --runner "\$CLEANUP_REQUESTED_RUNNER"/);
  assert.equal(check.env.CLEANUP_REQUESTED_RUNNER, '${{ matrix.host }}');
  assert.ok(recording.steps.some(step => step.if === 'always()' && step.uses?.startsWith('actions/upload-artifact@')));
  for (const step of recording.steps) assert.doesNotMatch(JSON.stringify(step), /secrets\.|continue-on-error|retry/i);
});

test('cleanup selector isolates its two MATLAB jobs and leaves other events on their previous routes', () => {
  for (const event of ['workflow_dispatch', 'push', 'pull_request']) {
    for (const selected of [false, true]) {
      const context = { github: { event_name: event }, inputs: { ...Object.fromEntries(Object.entries(inputs).map(([key, value]) => [key, value.default])), record_matlab: true, include_matrix: false, probes: selected ? 'cleanup-order-1' : 'none' }, needs: { gate: { outputs: { run: 'true' } } } };
      assert.equal(runInNewContext(recording.if, context), event === 'workflow_dispatch' && selected);
      assert.equal(runInNewContext(flow.jobs['matlab-reference'].if, context), event === 'workflow_dispatch' && !selected);
      assert.equal(runInNewContext(flow.jobs['recorder-smoke'].if, context), event !== 'workflow_dispatch' || !selected);
      if (event === 'workflow_dispatch' && selected) {
        for (const name of ['test', 'wasm-source', 'matlab-controls', 'runtime-cli', 'runtime-image']) {
          if (flow.jobs[name]) assert.equal(Boolean(runInNewContext(flow.jobs[name].if, context)), false, name);
        }
      }
    }
  }
});


test('preparation accepts the complete actual dispatch input schema and rejects its default full matrix', () => {
  const folder = fileURLToPath(new URL('../validation/matlab/cleanup-order-1/', import.meta.url));
  const payload = Object.fromEntries(Object.entries(inputs).map(([key, value]) => [key, String(value.default)]));
  Object.assign(payload, { record_matlab: 'true', probes: 'cleanup-order-1', include_matrix: 'false' });
  const script = `import sys,json
sys.path.insert(0,sys.argv[1])
import prepare
x=json.load(sys.stdin)
assert set(x)==prepare.INPUTS
e=dict(prepare.ENVIRONMENT,GITHUB_EVENT_NAME='workflow_dispatch',GITHUB_RUN_ATTEMPT='1',GITHUB_SHA='a'*40,GITHUB_RUN_ID='123',GITHUB_REPOSITORY='neurodesk/webapps',GITHUB_WORKFLOW_REF='neurodesk/webapps/.github/workflows/samsrf-native.yml@refs/heads/test')
prepare.make_context(e,{'inputs':x},'ubuntu-22.04',prepare.contract())
`;
  const run = (value) => spawnSync('python3', ['-c', script, folder], { input: JSON.stringify(value), encoding: 'utf8', env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' } });
  const good = run(payload);
  assert.equal(good.status, 0, good.stderr);
  const wrong = run({ ...payload, include_matrix: 'true' });
  assert.notEqual(wrong.status, 0);
  assert.match(wrong.stderr, /incompatible workflow input: include_matrix/);
});
