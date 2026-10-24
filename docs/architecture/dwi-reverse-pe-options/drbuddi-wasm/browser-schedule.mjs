// Run the #596 DR-BUDDI probe (exes/drbuddi-probe at 9d6ca773f) in headless
// Chromium with a schedule from a JSON file. This is browser.mjs of the probe
// with one change: the schedule is an argument, not a constant. The probe's
// worker.mjs is copied unchanged from PROBE_DIR.
// Usage: node browser-schedule.mjs PROBE_DIR BUILD_DIR INPUT_DIR SCHEDULE_JSON OUTPUT_DIR
import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join, resolve } from 'node:path';
import { chromium } from '@playwright/test';
import { serveSite } from '../../../../test-utils/serve-site.mjs';

const args = process.argv.slice(2).map((path) => resolve(path));
if (args.length !== 5) {
  throw new Error('Usage: browser-schedule.mjs PROBE_DIR BUILD_DIR INPUT_DIR SCHEDULE_JSON OUTPUT_DIR');
}
const [probe, build, inputs, scheduleFile, output] = args;
const { name: scheduleName, stages: schedule } = JSON.parse(await readFile(scheduleFile, 'utf8'));
await mkdir(join(output, 'out'), { recursive: true });
await mkdir(join(output, 'inputs'), { recursive: true });
for (const name of ['drbuddi-probe.mjs', 'drbuddi-probe.wasm']) {
  await copyFile(join(build, 'wasm', name), join(output, 'out', name));
}
const inputSha256 = {};
for (const name of ['blip_up_b0.nii', 'blip_down_b0.nii']) {
  await copyFile(join(inputs, name), join(output, 'inputs', name));
  inputSha256[name] = createHash('sha256').update(await readFile(join(inputs, name))).digest('hex');
}
await copyFile(join(probe, 'validation', 'worker.mjs'), join(output, 'worker.mjs'));
await writeFile(join(output, 'index.html'), '<!doctype html><title>DR-BUDDI validation</title>');
const site = await serveSite(output);
const browser = await chromium.launch({ headless: true });
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
  await page.waitForFunction(() => window.result, {}, { timeout: 4 * 3_600_000, polling: 5000 });
  const result = await page.evaluate(() => ({
    ...window.result,
    outputs: window.result.outputs?.map(({ name, bytes }) => ({ name, bytes: bytes.byteLength })),
  }));
  if (result.type !== 'done') throw new Error(JSON.stringify(result));
  const outputSha256 = {};
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
    outputSha256[`${name}.nii`] = createHash('sha256').update(await readFile(join(output, `${name}.nii`))).digest('hex');
  }
  result.engine = 'chromium';
  result.scheduleName = scheduleName;
  result.schedule = schedule;
  result.browser = browser.version();
  result.probeCommit = '9d6ca773f';
  result.wasmSha256 = createHash('sha256').update(await readFile(join(output, 'out', 'drbuddi-probe.wasm'))).digest('hex');
  result.inputSha256 = inputSha256;
  result.outputSha256 = outputSha256;
  result.measurement = 'Headless Chromium, one worker thread. heapBytes is the final monotonic WASM heap allocation, not process RSS.';
  await writeFile(join(output, 'receipt.json'), `${JSON.stringify(result, null, 2)}\n`);
  console.log(JSON.stringify(result));
} finally {
  await browser.close();
  await site.close();
}
