import { chromium } from '@playwright/test';
import { join } from 'node:path';
import { serveSite } from '../test-utils/serve-site.mjs';
const { origin, close } = await serveSite(join(import.meta.dirname, '../dist'));
const browser = await chromium.launch({ args: ['--enable-features=WebMCPTesting', ...(process.env.GPU ? ['--enable-unsafe-webgpu', '--use-angle=swiftshader', '--use-vulkan=swiftshader', '--enable-features=Vulkan', '--disable-vulkan-surface'] : [])] });
const page = await browser.newPage();
page.on('console', m => { if (['error', 'warning'].includes(m.type())) console.log('console', m.type(), m.text().slice(0, 300)); });
page.on('pageerror', e => console.log('pageerror', e.stack));
await page.goto(`${origin}/${process.argv[2]}/`);
await page.waitForTimeout(Number(process.env.WAIT ?? 6000));
if (process.env.ASK) {
  await page.evaluate(async () => { const t = (await document.modelContext.getTools()).find(x => x.name === 'user_ask'); globalThis.ask = document.modelContext.executeTool(t, { question: 'Q?', options: ['A', 'B'] }); });
  await page.locator('dialog#neurodeskAgentPrompt').getByRole('button', { name: 'B' }).click(); console.log(await page.evaluate(() => globalThis.ask));
}
if (process.env.PROMPTS) {
  await page.evaluate(async () => { const t = (await document.modelContext.getTools()).find(x => x.name === 'inputs_request_files'); globalThis.req = document.modelContext.executeTool(t, { role: 'image' }); });
  await page.waitForTimeout(800); await page.keyboard.press('Escape'); console.log(await page.evaluate(() => globalThis.req));
}
if (process.env.PRIVACY) { await page.locator('.nd-app-bar [data-neurodesk-shell-control="privacy"]').first().click(); await page.waitForTimeout(500); await page.keyboard.press('Escape'); }
if (process.env.TWOSTEP) {
  const start = (name, input) => page.evaluate(async ([name, input]) => { const calls = (globalThis.c ??= []); const t = (await document.modelContext.getTools()).find(x => x.name === name); calls.push(document.modelContext.executeTool(t, input)); return calls.length - 1; }, [name, input]);
  const fin = i => page.evaluate(i => globalThis.c[i], i);
  console.log((await fin(await start('inputs_load_example', { exampleId: process.argv[3] }))).slice(0, 100));
  console.log((await fin(await start(`run_${process.argv[4]}`, { parameters: {}, waitSeconds: 60 }))).slice(0, 300));
  await browser.close(); await close(); process.exit(0);
}
const out = await page.evaluate(async ([example, op]) => {
  const tools = await document.modelContext.getTools();
  const call = async (name, input) => JSON.parse(await document.modelContext.executeTool(tools.find(t => t.name === name), input));
  const loaded = await call('inputs_load_example', { exampleId: example });
  const run = await call(`run_${op}`, { waitSeconds: 60 });
  return { loaded, run: { state: run.state, error: run.error } };
}, [process.argv[3], process.argv[4]]);
console.log(JSON.stringify(out).slice(0, 600));
await browser.close(); await close();
