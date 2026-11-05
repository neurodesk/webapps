import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MEMORY_BUDGET, MemoryBudgetError, checkFusionMemory, checkSolverMemory, fusionBytes, pairBytes, registrationWorkers, solverBytes, tileBytes } from '../src/core/memory.js';
import { planPairs } from '../src/core/pipeline.js';
import { gridPositions } from '../src/core/tile-layout.js';

const GiB = 2 ** 30;

test('a pair is charged its float64 regions and four padded float64 FFT frames', () => {
  // A 52 × 512 × 256 overlap pads to a 64 × 1024 × 512 frame.
  const { bytes, size } = pairBytes([512, 512, 256], [512, 512, 256], [460, 0, 0]);
  assert.deepEqual(size, [52, 512, 256]);
  assert.equal(bytes, 16 * 52 * 512 * 256 + 32 * 64 * 1024 * 512);
  // Two whole 512 × 512 × 256 stacks pad to 1024 × 1024 × 512: 16 GiB of FFT buffers.
  assert.ok(pairBytes([512, 512, 256], [512, 512, 256], [0, 0, 0]).bytes > 16 * GiB);
  assert.equal(pairBytes([10, 10], [10, 10], [20, 0]).bytes, 0);
});

test('a pair whose FFT buffers exceed the budget is refused before allocation, by name', () => {
  const job = { shapes: [[512, 512, 256], [512, 512, 256]], dtype: 'uint8', pairs: [{ i: 0, j: 1, approximateOffset: [0, 0, 0] }], names: ['a.tif', 'b.tif'], shared: true, wanted: 4 };
  assert.throws(() => registrationWorkers(job), (error) => error instanceof MemoryBudgetError && /a\.tif and b\.tif/.test(error.message) && /512 × 512 × 256 pixel overlap/.test(error.message) && /4\.00 GB working memory/.test(error.message));
});

test('worker concurrency is bounded by the budget, and copied tiles count once per worker', () => {
  const shapes = [[512, 512, 256], [512, 512, 256]];
  const pairs = [{ i: 0, j: 1, approximateOffset: [460, 0, 0] }];
  const tiles = tileBytes(shapes, 'uint8');
  const pair = pairBytes(shapes[0], shapes[1], [460, 0, 0]).bytes;
  const shared = registrationWorkers({ shapes, dtype: 'uint8', pairs, shared: true, wanted: 6 });
  assert.equal(shared, Math.floor((MEMORY_BUDGET - tiles) / pair));
  assert.ok(shared >= 1 && shared < 6, `${shared}`);
  const copied = registrationWorkers({ shapes, dtype: 'uint8', pairs, shared: false, wanted: 6 });
  assert.equal(copied, Math.floor((MEMORY_BUDGET - tiles) / (pair + tiles)));
  assert.ok(tiles + shared * pair <= MEMORY_BUDGET);
});

test('the 4 × 4 example registers in every worker it asks for', () => {
  const shapes = Array.from({ length: 16 }, () => [512, 512]);
  const approximate = gridPositions({ count: 16, columns: 4, rows: 4, overlap: 0.18, type: 'row', start: 'top-left', shape: [512, 512] });
  const pairs = planPairs(shapes, approximate);
  assert.equal(registrationWorkers({ shapes, dtype: 'uint16', pairs, shared: true, wanted: 6 }), 6);
});

test('fusion is charged its accumulators and four sample-type copies, and refused over budget', () => {
  assert.equal(fusionBytes([100, 100], 'uint8'), 1e4 * (2 * 4 + 4));
  assert.equal(fusionBytes([100, 100], 'uint32'), 1e4 * (2 * 8 + 4 * 4));
  assert.equal(fusionBytes([100, 100], 'float64'), 1e4 * (2 * 8 + 4 * 8));
  const shapes = [[1024, 1024, 100], [1024, 1024, 100]];
  assert.doesNotThrow(() => checkFusionMemory({ shapes, dtype: 'uint8', shape: [1900, 1024, 100], shared: true }));
  assert.throws(() => checkFusionMemory({ shapes, dtype: 'float64', shape: [1900, 1024, 100], shared: true }), (error) => error instanceof MemoryBudgetError && /1900 × 1024 × 100/.test(error.message));
});

test('a 20,000-tile chain is refused for its dense global solve before anything is allocated', () => {
  // Registration and fusion fit: 64 × 64 uint8 tiles overlapping by half along one row.
  const count = 20000;
  const shapes = Array.from({ length: count }, () => [64, 64]);
  const pairs = Array.from({ length: count - 1 }, (_, i) => ({ i, j: i + 1, approximateOffset: [32, 0] }));
  assert.doesNotThrow(() => checkFusionMemory({ shapes, dtype: 'uint8', shape: [(count - 1) * 32 + 64, 64], shared: true }));
  assert.ok(registrationWorkers({ shapes, dtype: 'uint8', pairs, shared: true, wanted: 6 }) >= 1);
  // The solve holds a 19,999 × 19,999 float64 matrix and its Cholesky copy: 6.4 GB.
  assert.deepEqual(solverBytes(count, pairs), { bytes: 2 * 8 * (count - 1) ** 2, tiles: count });
  assert.throws(
    () => checkSolverMemory({ shapes, dtype: 'uint8', pairs }),
    (error) => error instanceof MemoryBudgetError && /20000 linked tiles/.test(error.message) && /6\.40 GB/.test(error.message) && /4\.00 GB working memory/.test(error.message),
  );
});

test('the solver is charged per connected component: separate rows of 2,000 tiles fit', () => {
  const shapes = Array.from({ length: 20000 }, () => [64, 64]);
  const pairs = [];
  for (let i = 0; i < 20000; i++) if ((i + 1) % 2000) pairs.push({ i, j: i + 1, approximateOffset: [32, 0] });
  assert.deepEqual(solverBytes(shapes.length, pairs), { bytes: 2 * 8 * 1999 ** 2, tiles: 2000 });
  assert.doesNotThrow(() => checkSolverMemory({ shapes, dtype: 'uint8', pairs }));
});
