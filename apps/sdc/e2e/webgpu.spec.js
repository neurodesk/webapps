// The WebGPU path of @neurodesk/sdc against its CPU path, in Chromium.
//
// On every run (SwiftShader on Linux CI): a synthetic pair through `backend: "webgpu"` agrees
// with the CPU path, and `auto` keeps the CPU path on a software adapter, bit for bit. The app's
// worker runs the example on WebGPU on a hardware adapter and on the CPU otherwise, and its field
// agrees with the native command line's.
// With NEURODESK_HARDWARE_GPU=1: the issue #506 gate on ds005134 sub-01, the prepared pair of
// docs/architecture/dwi-reverse-pe-options.md. The WebGPU field must agree with the native
// PyHySCO field to < 0.1 Hz median absolute difference in the brain mask.
import { expect, test } from "@playwright/test";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { createServer } from "node:http";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { gunzipSync } from "node:zlib";
import { readNifti, readNiftiFrames } from "@neurodesk/webapp-components/file-io";
import { assertHardwareAdapter, gpuBrowser, hardwareGpu, readAdapterInfo } from "../../../test-utils/hardware-gpu.mjs";
import { adoptPair, pinnedBytes, routeExample } from "./fixtures.mjs";

test.use(gpuBrowser);

const here = dirname(fileURLToPath(import.meta.url));
const packageSrc = join(here, "../../../packages/sdc/src");
// webgpu.js imports the shared software-adapter check; the page has no bundler, so an import map
// resolves it to /shared/backend.js.
const sharedBackend = join(here, "../../../packages/runtime-support/src/mindgrab/backend.js");
const importMap = JSON.stringify({ imports: { "@neurodesk/runtime-support/mindgrab/backend": "/shared/backend.js" } });
const manifest = JSON.parse(readFileSync(join(here, "../../../docs/architecture/dwi-reverse-pe-options/results.manifest.json"), "utf8"));

// A page origin that serves the package sources and the volumes of one test, and stores what
// the page posts to /out/ in `posted`.
async function serve(volumes) {
  const posted = {};
  const types = { ".js": "text/javascript", ".wasm": "application/wasm" };
  const server = createServer((request, response) => {
    const url = new URL(request.url, "http://localhost");
    if (request.method === "POST" && url.pathname.startsWith("/out/")) {
      const chunks = [];
      request.on("data", (chunk) => chunks.push(chunk));
      request.on("end", () => {
        posted[url.pathname.slice(5)] = Buffer.concat(chunks);
        response.end();
      });
      return;
    }
    if (url.pathname.startsWith("/src/")) {
      const name = url.pathname.slice(5);
      if (!/^[\w.-]+$/.test(name)) return response.writeHead(404).end();
      response.setHeader("content-type", types[name.slice(name.lastIndexOf("."))] ?? "application/octet-stream");
      return response.end(readFileSync(join(packageSrc, name)));
    }
    if (url.pathname === "/shared/backend.js") {
      response.setHeader("content-type", "text/javascript");
      return response.end(readFileSync(sharedBackend));
    }
    if (url.pathname.startsWith("/data/")) {
      const volume = volumes[url.pathname.slice(6)];
      if (!volume) return response.writeHead(404).end();
      return response.end(Buffer.from(volume.buffer, volume.byteOffset, volume.byteLength));
    }
    response.setHeader("content-type", "text/html");
    response.end(`<!doctype html><title>sdc webgpu</title><script type="importmap">${importMap}</script>`);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  // Chromium keeps a spare keep-alive socket that never carried a request; Node counts such a
  // socket as active, so server.close() alone waits for the browser to drop it (issue #347).
  const close = () => new Promise((resolve) => {
    server.closeAllConnections();
    server.close(resolve);
  });
  return { url: `http://127.0.0.1:${server.address().port}/`, posted, close };
}

// Runs each backend in the page on /data/image1 and /data/image2 and posts each field to
// /out/<backend>. Returns iterations, backend, adapter and wall time per run.
function runBackends(page, { dims, voxel, options, backends }) {
  return page.evaluate(
    async ({ dims, voxel, options, backends }) => {
      globalThis.sdcStage = "import";
      const { loadSdc } = await import(`${location.origin}/src/wasm.js`);
      globalThis.sdcStage = "loadSdc";
      const sdc = await loadSdc(fetch("/src/sdc.wasm"));
      const get = async (name) => new Float64Array(await (await fetch(`/data/${name}`)).arrayBuffer());
      const [image1, image2] = await Promise.all([get("image1"), get("image2")]);
      const runs = {};
      for (const [label, backend] of backends) {
        const start = performance.now();
        globalThis.sdcStage = `estimate ${label}`;
        const out = await sdc.estimate(image1, image2, dims, voxel, { ...options, backend });
        const seconds = (performance.now() - start) / 1000;
        globalThis.sdcStage = `post ${label}`;
        await fetch(`/out/${label}`, { method: "POST", body: out.field });
        globalThis.sdcStage = `posted ${label}`;
        runs[label] = { backend: out.backend, adapter: out.adapter ?? null, gpuError: out.gpuError ?? null, iterations: out.iterations, seconds };
      }
      return runs;
    },
    { dims, voxel, options, backends },
  );
}

const asF64 = (buffer) => new Float64Array(buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength));

function absoluteDifferences(a, b, mask) {
  const out = [];
  for (let k = 0; k < a.length; k++) if (!mask || mask[k] > 0) out.push(Math.abs(a[k] - b[k]));
  return out.sort((x, y) => x - y);
}

const median = (sorted) => sorted[sorted.length >> 1];

/** Gaussian bumps along j, shifted by `shift` mm (as packages/sdc/test/wasm.test.js). */
function bumps([nx, ny, nz], shift) {
  const out = new Float64Array(nx * ny * nz);
  for (let z = 0; z < nz; z++) {
    for (let y = 0; y < ny; y++) {
      for (let x = 0; x < nx; x++) {
        const centre = ny + 2 * Math.sin(x - 4) + z + 3 * Math.cos(x / 5);
        const position = (y + 0.5) * 2 - shift * (1 + 0.3 * Math.sin(x / 4 + z));
        out[x + nx * (y + ny * z)] = 100 * Math.exp(-(((position - centre) / 6) ** 2)) + 5;
      }
    }
  }
  return out;
}

test("WebGPU agrees with the CPU path, and auto keeps the CPU path on a software adapter", async ({ page }) => {
  test.setTimeout(300000);
  const dims = [24, 48, 6];
  const site = await serve({ image1: bumps(dims, 3), image2: bumps(dims, -3) });
  const t0 = Date.now();
  const log = (m) => console.error(`[stress ${test.info().repeatEachIndex} +${((Date.now() - t0) / 1000).toFixed(1)}s] ${m}`);
  page.on("console", (msg) => log(`console: ${msg.text()}`));
  page.on("crash", () => log("PAGE CRASH"));
  page.on("pageerror", (error) => log(`pageerror: ${error.message}`));
  const watchdog = setInterval(async () => {
    const stage = await Promise.race([page.evaluate(() => globalThis.sdcStage).catch((e) => `evaluate failed: ${e.message}`), new Promise((r) => setTimeout(() => r("evaluate hung 5s"), 5000))]);
    log(`stage: ${stage}`);
  }, 15000);
  try {
    await page.goto(site.url);
    log("goto done");
    const runs = await runBackends(page, {
      dims,
      voxel: [2, 2, 2],
      options: { phaseEncodingDirection: "j", totalReadoutTime: 0.05 },
      backends: [["cpu", "cpu"], ["webgpu", "webgpu"], ["auto", "auto"]],
    });
    clearInterval(watchdog);
    log(`runs done ${JSON.stringify(runs)}`);
    expect(runs.webgpu.backend).toBe("webgpu");
    expect(runs.webgpu.iterations).toBe(runs.cpu.iterations);
    const cpu = asF64(site.posted.cpu);
    const gpu = asF64(site.posted.webgpu);
    const differences = absoluteDifferences(gpu, cpu);
    expect(median(differences)).toBeLessThan(0.01);
    expect(differences.at(-1)).toBeLessThan(0.5);
    if (hardwareGpu) {
      expect(runs.auto.backend).toBe("webgpu");
    } else {
      // SwiftShader is a fallback adapter: auto must not pick it.
      expect(runs.auto).toMatchObject({ backend: "cpu", gpuError: null });
      expect(asF64(site.posted.auto)).toEqual(cpu);
    }
  } finally {
    clearInterval(watchdog);
    log("closing site");
    await site.close();
    log("site closed");
  }
});

// The pinned inputs, mask and native fields of the options document, fetched once into TMPDIR.
async function pinned(path) {
  const entry = manifest.files.find((file) => file.path === path);
  if (!entry) throw new Error(`${path} is not in results.manifest.json`);
  const directory = process.env.SDC_WEBGPU_REFERENCE_DIR ?? join(process.env.TMPDIR ?? "/var/tmp", "sdc-webgpu-reference", manifest.revision);
  const cache = join(directory, path);
  const verified = (bytes) => createHash("sha256").update(bytes).digest("hex") === entry.sha256;
  if (existsSync(cache)) {
    const bytes = readFileSync(cache);
    if (verified(bytes)) return bytes;
  }
  const response = await fetch(manifest.base + path);
  if (!response.ok) throw new Error(`${path}: HTTP ${response.status}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  if (!verified(bytes)) throw new Error(`${path}: SHA-256 differs from results.manifest.json`);
  mkdirSync(dirname(cache), { recursive: true });
  writeFileSync(cache, bytes);
  return bytes;
}

const columnLengths = (affine) => [0, 1, 2].map((c) => Math.hypot(affine[0][c], affine[1][c], affine[2][c]));

// SDC_WEBGPU_SUBJECTS (comma separated) adds the other subjects of the options document.
const subjects = (process.env.SDC_WEBGPU_SUBJECTS ?? "ds005134-sub-01").split(",").filter(Boolean);

for (const subject of subjects) test(`issue #506 gate: the WebGPU field of ${subject} agrees with native PyHySCO`, async ({ page }) => {
  test.skip(!hardwareGpu, "Needs a hardware WebGPU adapter (NEURODESK_HARDWARE_GPU=1).");
  test.setTimeout(600000);
  const prep = JSON.parse((await pinned(`${subject}/prep/prep.json`)).toString());
  const [ap, pa, mask, native, nativeGpu] = await Promise.all(
    ["prep/ap_mean.nii.gz", "prep/pa_mean_reg.nii.gz", "mask/b0_mask.nii.gz", "pyhysco/field_hz.nii.gz", "pyhysco-gpu/field_hz.nii.gz"].map(async (name) => readNifti(await pinned(`${subject}/${name}`), Float64Array)),
  );
  const site = await serve({ image1: ap.data, image2: pa.data });
  try {
    await page.goto(site.url);
    assertHardwareAdapter(await readAdapterInfo(page));
    const runs = await runBackends(page, {
      dims: ap.dims,
      voxel: columnLengths(ap.header.affine),
      options: { phaseEncodingDirection: prep.ap.pe, totalReadoutTime: prep.ap.trt },
      backends: [["cpu", "cpu"], ["webgpu", "webgpu"], ["webgpu-again", "webgpu"]],
    });
    const fields = Object.fromEntries(Object.keys(runs).map((label) => [label, asF64(site.posted[label])]));
    const report = { subject, runs, voxels: mask.data.filter((v) => v > 0).length, medianAbsHz: {}, p99AbsHz: {}, maxAbsHz: {} };
    const compare = (name, a, b) => {
      const d = absoluteDifferences(a, b, mask.data);
      report.medianAbsHz[name] = median(d);
      report.p99AbsHz[name] = d[Math.floor(0.99 * (d.length - 1))];
      report.maxAbsHz[name] = d.at(-1);
    };
    compare("webgpu vs native PyHySCO (CPU float32)", fields.webgpu, native.data);
    compare("webgpu vs native PyHySCO (CUDA float32)", fields.webgpu, nativeGpu.data);
    compare("webgpu vs wasm CPU (float64)", fields.webgpu, fields.cpu);
    compare("wasm CPU vs native PyHySCO (CPU float32)", fields.cpu, native.data);
    compare("webgpu run 1 vs run 2", fields.webgpu, fields["webgpu-again"]);
    console.log(JSON.stringify(report, null, 2));
    const out = process.env.SDC_WEBGPU_OUT;
    if (out) {
      mkdirSync(join(out, subject), { recursive: true });
      writeFileSync(join(out, subject, "report.json"), `${JSON.stringify(report, null, 2)}\n`);
      for (const [label, field] of Object.entries(fields)) writeFileSync(join(out, subject, `${label}.f64`), field);
    }
    expect(runs.webgpu.backend).toBe("webgpu");
    expect(report.medianAbsHz["webgpu vs native PyHySCO (CPU float32)"]).toBeLessThan(0.1);
  } finally {
    await site.close();
  }
});

test("the app's worker picks the backend and its example field agrees with the native command line", async ({ page }) => {
  test.setTimeout(300000);
  const examples = JSON.parse(readFileSync(join(here, "../examples.json"), "utf8"));
  const native = JSON.parse(readFileSync(join(here, "native-reference.json"), "utf8"));
  await routeExample(page.context(), [...examples.flatMap((example) => example.files.map((file) => file.url)), native.url]);
  // Record the backend of each estimate that the worker posts back.
  await page.addInitScript(() => {
    globalThis.sdcBackends = [];
    const Base = globalThis.Worker;
    globalThis.Worker = class extends Base {
      constructor(...args) {
        super(...args);
        this.addEventListener("message", ({ data }) => {
          if (data?.ok && data.backend) globalThis.sdcBackends.push(data.backend);
        });
      }
    };
  });
  await page.goto("/");
  await page.locator("select[data-neurodesk-example]").selectOption(examples[0].id);
  await expect(page.locator("#runButton")).toBeEnabled({ timeout: 120000 });
  await page.locator("#runButton").click();
  await expect(page.locator("#statusText")).toContainText("Field estimated", { timeout: 120000 });
  expect(await page.evaluate(() => globalThis.sdcBackends)).toEqual([hardwareGpu ? "webgpu" : "cpu"]);
  const event = page.waitForEvent("download");
  await page.locator("#resultList .nd-volume-toggle").filter({ hasText: "Field map (Hz)" }).getByRole("button", { name: "Download" }).click();
  const field = readNiftiFrames(gunzipSync(readFileSync(await (await event).path())));
  const reference = readNiftiFrames(gunzipSync(await pinnedBytes(page.request, native.url)));
  const differences = absoluteDifferences(field.data, reference.data, reference.data.map((v) => (v !== 0 ? 1 : 0)));
  console.log(`app example on ${hardwareGpu ? "webgpu" : "cpu"}: median |field - native| ${median(differences)} Hz, max ${differences.at(-1)} Hz over ${differences.length} voxels`);
  expect(median(differences)).toBeLessThan(0.1);
  const metadataEvent = page.waitForEvent("download");
  await page.locator("#resultList .nd-volume-toggle").filter({ hasText: "Field map sidecar" }).getByRole("button", { name: "Download" }).click();
  const metadata = JSON.parse(readFileSync(await (await metadataEvent).path(), "utf8"));
  expect(metadata.Execution.backend).toBe(hardwareGpu ? "webgpu" : "cpu");
  if (hardwareGpu) expect(metadata.Execution.adapter).toBeTruthy();
  await expect(page.locator("#technicalLog")).toContainText(`PyHySCO backend: ${metadata.Execution.backend}`);
});

test("a GPU failure remains visible in the CPU fallback's report, sidecar and console", async ({ page }) => {
  test.setTimeout(120000);
  await page.context().route("**/assets/worker-*.js", async (route) => {
    const response = await route.fetch();
    const setup = `Object.defineProperty(navigator, "gpu", { configurable: true, value: {
      requestAdapter: async () => ({ info: { vendor: "test hardware" }, limits: {},
        requestDevice: async () => { throw new Error("forced GPU device failure"); }
      })
    } });\n`;
    await route.fulfill({ response, body: setup + await response.text() });
  });
  await page.goto("/");
  await adoptPair(page);
  await page.evaluate(() => globalThis.neurodeskAutomation.dispatch("start", {}));
  await expect.poll(() => page.evaluate(async () => (await globalThis.neurodeskAutomation.dispatch("snapshot")).state), { timeout: 60000 }).toBe("succeeded");
  const report = await page.evaluate(async () => (await globalThis.neurodeskAutomation.dispatch("snapshot")).report);
  const execution = { backend: "cpu", gpuError: "forced GPU device failure" };
  expect(report.provenance.execution).toEqual(execution);
  const event = page.waitForEvent("download");
  await page.locator("#resultList .nd-volume-toggle").filter({ hasText: "Field map sidecar" }).getByRole("button", { name: "Download" }).click();
  expect(JSON.parse(readFileSync(await (await event).path(), "utf8")).Execution).toEqual(execution);
  await expect(page.locator("#technicalLog")).toContainText("CPU fallback: forced GPU device failure");
});
