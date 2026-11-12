import { readFile } from 'node:fs/promises';
import { betRuntime } from '../src/bet-runtime.js';

export async function loadBetRuntime() {
  const bytes = await readFile(new URL('../wasm/bet.wasm', import.meta.url));
  return betRuntime(await WebAssembly.compile(bytes));
}
