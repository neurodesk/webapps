import assert from 'node:assert/strict';

/** Reuse only complete measurements from this exact configuration, inputs and runtime. */
export function validateBenchmarkReceipt(receipt, expected) {
  assert.equal(receipt.mode, 'benchmark; reserve a quiet host', 'A correctness preflight is not a timing trial');
  for (const key of ['host', 'data', 'model', 'workers', 'trial']) assert.equal(receipt[key], expected[key], `Receipt ${key} changed`);
  assert.equal(receipt.seed, 1234);
  assert.deepEqual(receipt.sourceHashes, expected.sourceHashes, 'Runtime sources changed; start a separate matrix');
  assert.deepEqual(receipt.pins, expected.pins, 'Input pins changed; start a separate matrix');
  for (const key of ['os', 'cpu', 'cores', 'memoryBytes']) assert.equal(receipt.machine[key], expected.machine[key], `Receipt machine ${key} changed`);
  assert.deepEqual(receipt.errors, [], 'Failed trials cannot be resumed as completed measurements');
  assert.equal(receipt.runs.length, 1);
  const run = receipt.runs[0];
  assert.equal(run.verified, true);
  const frames = expected.data === 'full' ? 101 : 137;
  const registered = expected.data === 'full' ? 90 : 124;
  assert.equal(run.frames, frames);
  assert.equal(run.expectedRegistrations, registered);
  assert.deepEqual(run.completed, { register: registered, resample: registered, write: 1 });
  assert.ok(Number.isFinite(run.seconds) && run.seconds > 0, 'A timing trial must complete with positive finite runtime');
  assert.ok(Number.isFinite(run.memory.peakBytes) && run.memory.peakBytes > 0, 'A timing trial must contain a sampled RSS peak');
  assert.equal(Object.keys(run.hashes).length, frames + 5);
  for (const hash of Object.values(run.hashes)) assert.match(hash, /^[a-f0-9]{64}$/);
  if (expected.host === 'node') assert.equal(run.version, process.version, 'Node runtime changed');
  return receipt;
}
