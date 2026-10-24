import assert from 'node:assert/strict';
import test from 'node:test';
import { validateBenchmarkReceipt } from '../validation/benchmark-receipts.mjs';
import { benchmarkPins } from '../validation/benchmark-pins.mjs';

function fixture() {
  const expected = {
    host: 'node', data: 'full', model: 'gp', workers: 1, trial: '1',
    sourceHashes: { 'src/pool.js': 'a'.repeat(64) },
    pins: [{ role: 'image', sha256: 'b'.repeat(64), bytes: 1 }],
    machine: { os: 'test', cpu: 'test', cores: 4, memoryBytes: 1000 },
  };
  const receipt = {
    ...structuredClone(expected), mode: 'benchmark; reserve a quiet host', seed: 1234, errors: [],
    runs: [{ verified: true, frames: 101, expectedRegistrations: 90, completed: { register: 90, resample: 90, write: 1 },
      seconds: 1, memory: { peakBytes: 500 }, version: process.version,
      hashes: Object.fromEntries(Array.from({ length: 106 }, (_, i) => [`file${i}`, 'c'.repeat(64)])),
    }],
  };
  return { expected, receipt };
}

test('a complete matching measurement can be resumed without rerunning it', () => {
  const { expected, receipt } = fixture();
  assert.equal(validateBenchmarkReceipt(receipt, expected), receipt);
});

test('resuming rejects changed sources, inputs, configuration, machine or runtime', () => {
  const mutations = [
    receipt => { receipt.sourceHashes['src/pool.js'] = 'd'.repeat(64); },
    receipt => { receipt.pins[0].sha256 = 'd'.repeat(64); },
    receipt => { receipt.workers = 4; },
    receipt => { receipt.trial = '2'; },
    receipt => { receipt.machine.cpu = 'other'; },
    receipt => { receipt.runs[0].version = 'other'; },
  ];
  for (const mutate of mutations) {
    const { expected, receipt } = fixture();
    mutate(receipt);
    assert.throws(() => validateBenchmarkReceipt(receipt, expected), assert.AssertionError);
  }
});

test('preflights, failed or incomplete work and invalid measurements are never resumed as timings', () => {
  const mutations = [
    receipt => { receipt.mode = 'correctness preflight; contention allowed; not a benchmark'; },
    receipt => { receipt.errors = ['cancelled']; },
    receipt => { receipt.runs[0].verified = false; },
    receipt => { receipt.runs[0].completed.resample = 89; },
    receipt => { receipt.runs[0].seconds = NaN; },
    receipt => { receipt.runs[0].memory.peakBytes = 0; },
    receipt => { delete receipt.runs[0].hashes.file0; },
  ];
  for (const mutate of mutations) {
    const { expected, receipt } = fixture();
    mutate(receipt);
    assert.throws(() => validateBenchmarkReceipt(receipt, expected), assert.AssertionError);
  }
});

test('the trial runner and matrix use the same four immutable input roles for each dataset', async () => {
  for (const data of ['full', 'slab']) {
    const pins = await benchmarkPins(data);
    assert.deepEqual(pins.map(pin => pin.role), ['image', 'bval', 'bvec', 'mask']);
    for (const pin of pins) {
      assert.match(pin.url, /\/resolve\/[a-f0-9]{40}\//);
      assert.match(pin.sha256, /^[a-f0-9]{64}$/);
      assert.ok(pin.bytes > 0);
    }
  }
});
