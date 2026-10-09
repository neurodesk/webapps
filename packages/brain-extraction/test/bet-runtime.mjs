// Loads the manifest-pinned QSMbly BET WebAssembly (the build the app ships) into Node.
import { execFileSync } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const fetcher = fileURLToPath(new URL('../../../scripts/fetch-app-runtime.mjs', import.meta.url));

export async function loadBetRuntime() {
  const directory = join(process.env.TMPDIR || process.env.RUNNER_TEMP || tmpdir(), 'neurodesk-brain-extraction-bet-runtime');
  await mkdir(directory, { recursive: true });
  // The fetcher verifies both files against runtime-assets/manifest.json and throws on a mismatch.
  // Retried because the files come from the network; a cached, verified copy is reused.
  for (let attempt = 1; ; attempt++) {
    try {
      execFileSync(process.execPath, [fetcher, '--dest', directory, 'qsm-wasm:qsm_wasm.js,qsm_wasm_bg.wasm'], { stdio: 'pipe', timeout: 300_000 });
      break;
    } catch (error) {
      if (attempt >= 4) throw error;
      await new Promise(resolve => setTimeout(resolve, 2000 * attempt));
    }
  }
  await writeFile(join(directory, 'package.json'), '{"type":"module"}\n');
  const runtime = await import(pathToFileURL(join(directory, 'qsm_wasm.js')).href);
  runtime.initSync({ module: await readFile(join(directory, 'qsm_wasm_bg.wasm')) });
  return runtime;
}
