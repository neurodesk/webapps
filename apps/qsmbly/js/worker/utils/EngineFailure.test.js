/**
 * EngineFailure Tests
 */
import { describeFailure, withEngine } from './EngineFailure.js';

describe('describeFailure', () => {
  test('reports an engine error as it is', () => {
    const error = Object.assign(new Error('no phase'), { kind: 'input' });
    expect(describeFailure(error)).toEqual({ message: 'no phase', kind: 'input', fatal: false });
  });

  test('names the panic behind a trap, not the trap', () => {
    const mod = { take_panic_wasm: () => 'index out of bounds (at lib.rs:3)' };
    const failure = describeFailure(new WebAssembly.RuntimeError('unreachable'), { mod });
    expect(failure).toEqual({ message: 'The engine panicked: index out of bounds (at lib.rs:3)', kind: 'panic', fatal: true });
  });

  test('falls back to the trap when the module kept no panic', () => {
    const failure = describeFailure(new WebAssembly.RuntimeError('unreachable'), { mod: { take_panic_wasm: () => undefined } });
    expect(failure).toEqual({ message: 'The engine stopped (unreachable)', kind: 'abort', fatal: true });
  });
});

test('a successful engine call returns its result and frees the engine once', () => {
  let freed = 0;
  const engine = { free() { freed += 1; } };
  expect(withEngine(engine, () => 'completed')).toBe('completed');
  expect(freed).toBe(1);
});

test('a trapped run reports its panic even when freeing the borrowed engine fails', () => {
  const engine = { free() { throw new Error('attempted to take ownership while borrowed'); } };
  const mod = { take_panic_wasm: () => 'index out of bounds (at synthseg.rs:140)' };
  expect(() => withEngine(engine, () => {
    throw new WebAssembly.RuntimeError('unreachable');
  }, mod)).toThrow(expect.objectContaining({ message: 'The engine panicked: index out of bounds (at synthseg.rs:140)', fatal: true }));
});

test('a trap whose panic cannot be read still reports the original failure', () => {
  const engine = { free() { throw new Error('borrowed'); } };
  const mod = { take_panic_wasm() { throw new Error('unavailable'); } };
  expect(() => withEngine(engine, () => {
    throw new WebAssembly.RuntimeError('unreachable');
  }, mod)).toThrow('The engine stopped (unreachable)');
});

test('an ordinary engine error is preserved and frees the engine once', () => {
  let freed = 0;
  const engine = { free() { freed += 1; } };
  const error = Object.assign(new Error('the local field is empty'), { kind: 'invalid_input', step: 'invert' });
  expect(() => withEngine(engine, () => { throw error; })).toThrow(error);
  expect(freed).toBe(1);
});
