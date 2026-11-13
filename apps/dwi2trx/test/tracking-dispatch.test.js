import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { stripTypeScriptTypes } from 'node:module';

const source = await readFile(new URL('../vendor/gpu-streamlines/src/dispatch.ts', import.meta.url), 'utf8');
const { dispatchBootWindows } = await import(`data:text/javascript,${encodeURIComponent(stripTypeScriptTypes(source))}`);

function gpu({ onComplete = () => {} } = {}) {
  const parameters = new Uint32Array(24).fill(123);
  const commands = [];
  let submitted = null;
  const device = {
    queue: {
      writeBuffer(buffer, offset, data) {
        assert.equal(submitted, null, 'finish the previous GPU command before changing its parameters');
        buffer.set(data, offset / 4);
      },
      submit([command]) {
        assert.equal(submitted, null);
        submitted = { ...command, first: parameters[23] };
      },
      async onSubmittedWorkDone() {
        await Promise.resolve();
        commands.push(submitted);
        submitted = null;
        onComplete();
      },
    },
    createCommandEncoder() {
      const command = { groups: [] };
      return {
        beginComputePass: () => ({
          setPipeline: pipeline => { command.pipeline = pipeline; },
          setBindGroup: (index, group) => { command.groups[index] = group; },
          dispatchWorkgroups: (x, y, z) => { command.counts = [x, y, z]; },
          end() {},
        }),
        finish: () => command,
      };
    },
  };
  return { device, parameters, commands };
}

test('all 5000 logical workgroups execute exactly once in completed windows of at most 32', async () => {
  const f = gpu();
  assert.equal(await dispatchBootWindows(f.device, 'generate', 5000, ['data', 'model', 'output'], f.parameters), true);
  assert.equal(f.commands.length, 157);
  assert.deepEqual(f.commands.at(-1).counts, [8, 1, 1]);
  const logical = f.commands.flatMap(command => {
    assert.equal(command.pipeline, 'generate');
    assert.deepEqual(command.groups, ['data', 'model', 'output']);
    assert.ok(command.counts[0] <= 32);
    return Array.from({ length: command.counts[0] }, (_, group) => command.first + group);
  });
  assert.deepEqual(logical, Array.from({ length: 5000 }, (_, index) => index));
  assert.deepEqual([...f.parameters.slice(0, 23)], new Array(23).fill(123), 'seed/RNG and logical batch fields are untouched');
});

test('physical window size preserves each logical workgroup and its original seed/lane IDs', async () => {
  for (const window of [1, 7, 16, 37]) {
    const f = gpu();
    await dispatchBootWindows(f.device, 'count', 37, [], f.parameters, undefined, window);
    const laneIds = f.commands.flatMap(command => Array.from({ length: command.counts[0] * 64 }, (_, lane) => command.first * 64 + lane));
    assert.deepEqual(laneIds, Array.from({ length: 37 * 64 }, (_, lane) => lane));
  }
});

test('cancellation stops before the next command without treating the logical batch as complete', async () => {
  let completed = 0;
  const f = gpu({ onComplete: () => completed++ });
  assert.equal(await dispatchBootWindows(f.device, 'generate', 100, [], f.parameters, () => completed === 2), false);
  assert.equal(f.commands.length, 2);
});

test('a failed GPU command rejects before submitting more work', async () => {
  const f = gpu({ onComplete() { throw new Error('GPU lost'); } });
  await assert.rejects(dispatchBootWindows(f.device, 'generate', 100, [], f.parameters), /GPU lost/);
  assert.equal(f.commands.length, 1);
});

test('completed commands yield to a queued cancellation, including the final window', async () => {
  for (const count of [1, 100]) {
    let cancelled = false;
    const f = gpu({ onComplete() { setTimeout(() => { cancelled = true; }, 0); } });
    assert.equal(await dispatchBootWindows(f.device, 'generate', count, [], f.parameters, () => cancelled), false);
    assert.equal(f.commands.length, 1);
  }
});

test('a later generation round submits only the windows that still have work', async () => {
  const f = gpu();
  assert.equal(await dispatchBootWindows(f.device, 'generate', 100, [], f.parameters, undefined, 16, first => first === 32 || first === 96), true);
  assert.deepEqual(f.commands.map(command => [command.first, command.counts[0]]), [[32, 16], [96, 4]]);
});
