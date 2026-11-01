// One whole-app HMC trial in a memory-capped cgroup. Chromium alone runs in a transient user scope:
//   systemd-run --user --scope -p MemoryMax=<cap> -p MemorySwapMax=0 <chromium> --headless=new ...
// The harness (outside the scope) loads the production page, drops the input, runs with automatic
// MindGrab masking and samples the scope's memory.current and the browser tree's RSS every 100 ms.
// node memory-cap-trial.mjs URL INPUTDIR CAP(e.g. 8G|none) MODEL WORKERS OUT.json [CYCLES]
// URL is a production preview of apps/hmc; INPUTDIR holds one dwi.nii.gz, dwi.bval and dwi.bvec.
import { spawn, execFileSync } from "node:child_process";
import { createReadStream, readFileSync, readdirSync, writeFileSync, mkdtempSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";
import { chromium } from "@playwright/test";
import { processTreeRss } from "./benchmark-memory.mjs";
const [url, inputDir, cap, model, workers, outPath, cycles = "1"] = process.argv.slice(2);
const unit = `hmc452-${Date.now()}`;
const profile = mkdtempSync(join(process.env.TMPDIR, "chrome-"));
const properties = cap === "none" ? [] : ["-p", `MemoryMax=${cap}`, "-p", "MemorySwapMax=0"];
const command = ["systemd-run", "--user", "--scope", `--unit=${unit}`, "--quiet", ...properties,
  chromium.executablePath(), "--headless=new", "--remote-debugging-port=0", `--user-data-dir=${profile}`, "--no-first-run", "--no-default-browser-check", "about:blank"];
const child = spawn(command[0], command.slice(1), { stdio: ["ignore", "ignore", "pipe"] });
let exited = null;
child.on("exit", (code, sig) => { exited = { code, signal: sig }; });
const endpoint = await new Promise((resolve, reject) => {
  let text = "";
  child.stderr.on("data", chunk => { text += chunk; const m = text.match(/DevTools listening on (ws:\S+)/); if (m) resolve(m[1]); });
  child.on("exit", () => reject(new Error(`chromium exited: ${text}`)));
});
const cgroup = "/sys/fs/cgroup" + execFileSync("systemctl", ["--user", "show", "-p", "ControlGroup", "--value", `${unit}.scope`], { encoding: "utf8" }).trim();
const read = name => { try { return readFileSync(join(cgroup, name), "utf8"); } catch { return null; } };
const cgroupMax = read("memory.max")?.trim(), swapMax = read("memory.swap.max")?.trim();
const samples = [];
const start = performance.now();
const marks = [];
const mark = label => marks.push({ label, seconds: (performance.now() - start) / 1000 });
const timer = setInterval(() => {
  const current = Number(read("memory.current") ?? NaN);
  let rss = NaN;
  try { rss = processTreeRss(child.pid); } catch { /* The browser has exited: the sample keeps NaN. */ }
  samples.push({ t: (performance.now() - start) / 1000, current, rss });
}, 100);
const result = { url, input: inputDir, cycles: Number(cycles), cap, model, workers: Number(workers), unit, cgroup, cgroupMax, swapMax, command: command.slice(0, 9).join(" ") + " ..." };
let browser;
try {
  browser = await chromium.connectOverCDP(endpoint);
  const page = browser.contexts()[0].pages()[0] ?? await browser.contexts()[0].newPage();
  const crashed = new Promise(resolve => page.on("crash", () => resolve("page crashed")));
  const errors = [];
  page.on("pageerror", e => errors.push(e.message));
  result.pageErrors = errors;
  const status = page.locator("#statusText");
  const waitFor = async (text, timeout) => {
    const outcome = await Promise.race([
      status.filter({ hasText: text }).waitFor({ timeout }).then(() => "ok"),
      page.locator("#statusText.error").waitFor({ timeout }).then(async () => `error: ${await status.textContent()}`),
      crashed,
      new Promise(resolve => { const i = setInterval(() => { if (exited) { clearInterval(i); resolve(`browser exited ${JSON.stringify(exited)}`); } }, 500); }),
    ]);
    return outcome;
  };
  await page.goto(url);
  mark("loaded page");
  // Each further cycle drops the same input again with the previous results still shown,
  // the replacement state that peaked highest in the earlier whole-app observations.
  result.loads = [];
  result.cycles = [];
  for (let cycle = 0; cycle < Number(cycles); cycle++) {
    // CDP-connected browsers cannot receive files over 50 MB; the page fetches them from a loopback
    // server instead and drops them on the input as File objects, as setInputFiles would.
    const files = createServer((request, response) => {
      response.setHeader("Access-Control-Allow-Origin", "*");
      response.setHeader("Cross-Origin-Resource-Policy", "cross-origin");
      createReadStream(join(inputDir, decodeURIComponent(request.url.slice(1)))).on("error", () => response.writeHead(404).end()).pipe(response);
    });
    await new Promise(resolve => files.listen(0, "127.0.0.1", resolve));
    result.inputFiles = readdirSync(inputDir);
    await page.evaluate(async ({ base, names }) => {
      const transfer = new DataTransfer();
      for (const name of names) transfer.items.add(new File([await (await fetch(base + name)).blob()], name));
      const input = document.getElementById("imageInput");
      input.files = transfer.files;
      input.dispatchEvent(new Event("change", { bubbles: true }));
    }, { base: `http://127.0.0.1:${files.address().port}/`, names: result.inputFiles });
    files.close();
    result.load = await waitFor("Diffusion image loaded", 600000);
    result.loads.push(result.load);
    mark("input loaded");
    if (result.load === "ok") {
      result.fileInfo = await page.locator("#fileInfo").textContent();
      await page.locator("#method").selectOption(model);
      await page.locator("#workers").evaluate((el, value) => { el.value = value; }, workers);
      const runStart = performance.now();
      await page.locator("#runButton").click();
      result.run = await waitFor("Head motion corrected", 3 * 3600000);
      result.runSeconds = (performance.now() - runStart) / 1000;
      mark("run finished");
      result.finalStatus = await status.textContent().catch(() => null);
      result.cycles.push({ load: result.load, run: result.run, runSeconds: result.runSeconds });
    }
    if (result.run !== "ok") break;
  }
} catch (error) {
  result.harnessError = String(error.stack ?? error);
} finally {
  clearInterval(timer);
  result.memoryEvents = read("memory.events");
  result.marks = marks;
  result.peakCgroupBytes = Math.max(...samples.map(s => s.current).filter(Number.isFinite));
  result.peakRssBytes = Math.max(...samples.map(s => s.rss).filter(Number.isFinite));
  result.sampleCount = samples.length;
  result.maxGapSeconds = Math.max(...samples.slice(1).map((s, i) => s.t - samples[i].t));
  result.browserExit = exited;
  await browser?.close().catch(() => {});
  try { execFileSync("systemctl", ["--user", "stop", `${unit}.scope`]); } catch { /* The scope ended with its last process. */ }
  writeFileSync(outPath, JSON.stringify({ ...result, samples }, null, 1));
  const { samples: _s, ...summary } = result;
  console.log(JSON.stringify(summary));
}
