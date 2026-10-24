import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join, resolve } from 'node:path';
import { chromium } from '@playwright/test';
import { serveSite } from '../../../test-utils/serve-site.mjs';

const [build, inputs, output] = process.argv.slice(2).map((path) => resolve(path));
if (!output) throw new Error('Usage: browser.mjs BUILD_DIRECTORY LPS_INPUT_DIRECTORY OUTPUT_DIRECTORY');
await mkdir(join(output, 'out'), { recursive: true });
await mkdir(join(output, 'inputs'), { recursive: true });
for (const name of ['drbuddi-probe.mjs', 'drbuddi-probe.wasm']) {
  await copyFile(join(build, 'wasm', name), join(output, 'out', name));
}
for (const name of ['blip_up_b0.nii', 'blip_down_b0.nii']) {
  await copyFile(join(inputs, name), join(output, 'inputs', name));
}
await copyFile(new URL('./worker.mjs', import.meta.url), join(output, 'worker.mjs'));
await writeFile(join(output, 'index.html'), '<!doctype html><title>DR-BUDDI validation</title>');
const schedule = [
  '[learning_rate={0.5},cfs={10:4:2},field_smoothing={5:0.1},metrics={MSJac},restrict_constrain={1:1}]',
  '[learning_rate={0.5},cfs={20:2:1},field_smoothing={3:0.1},metrics={MSJac},restrict_constrain={1:1}]',
  '[learning_rate={0.5},cfs={20:1:0},field_smoothing={3:0.1},metrics={MSJac},restrict_constrain={1:1}]',
];
const site = await serveSite(output);
const browser = await chromium.launch();
try {
  const page = await browser.newPage({ acceptDownloads: true });
  page.on('console', (event) => console.log(event.text()));
  await page.goto(site.origin);
  await page.evaluate((schedule) => {
    const worker = new Worker('./worker.mjs', { type: 'module' });
    worker.onmessage = ({ data }) => {
      if (data.type === 'log') console.log(data.message);
      else window.result = data;
    };
    worker.onerror = (event) => { window.result = { type: 'error', message: event.message }; };
    worker.postMessage(schedule);
  }, schedule);
  await page.waitForFunction(() => window.result, {}, { timeout: 3_600_000 });
  const result = await page.evaluate(() => ({
    ...window.result,
    outputs: window.result.outputs?.map(({ name, bytes }) => ({ name, bytes: bytes.byteLength })),
  }));
  if (result.type !== 'done') throw new Error(JSON.stringify(result));
  for (const { name } of result.outputs) {
    const download = page.waitForEvent('download');
    await page.evaluate((name) => {
      const output = window.result.outputs.find((output) => output.name === name);
      const link = document.createElement('a');
      link.href = URL.createObjectURL(new Blob([output.bytes]));
      link.download = `${name}.nii`;
      link.click();
    }, name);
    await (await download).saveAs(join(output, `${name}.nii`));
  }
  result.schedule = schedule;
  result.browser = browser.version();
  result.wasmSha256 = createHash('sha256').update(await readFile(join(output, 'out', 'drbuddi-probe.wasm'))).digest('hex');
  result.measurement = 'Contended-host correctness preflight; elapsed time is not a benchmark. heapBytes is the final monotonic WASM heap allocation, not process RSS.';
  await writeFile(join(output, 'receipt.json'), `${JSON.stringify(result, null, 2)}\n`);
  console.log(JSON.stringify(result));
} finally {
  await browser.close();
  await site.close();
}
