// Browser tests against `vite preview` of the production build: the shared shell, both examples
// through their real workflow and downloads against MetroloJ_QC/ImageJ reference numbers and the
// Node pipeline, manual optics for a TIFF without metadata, refusals, cancellation, the examples'
// failure and retry paths, and the automation operation.
import { test, expect } from "@playwright/test";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { writeTiffStack } from "@neurodesk/webapp-components/file-io/tiff";
import { beadStack } from "../test/synthetic.js";
import { FWHM_PER_SIGMA } from "../src/core/fit.js";

const automation = JSON.parse(readFileSync(new URL("../automation.json", import.meta.url), "utf8"));
const examples = JSON.parse(readFileSync(new URL("../examples.json", import.meta.url), "utf8"));
const reference = JSON.parse(readFileSync(new URL("../test/fixtures/metroloj-reference.json", import.meta.url), "utf8"));
const [beads, field] = examples;
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const cache = new Map();

async function exampleBytes(example) {
  const file = example.files[0];
  if (!cache.has(file.url)) {
    const response = await fetch(file.url);
    if (!response.ok) throw new Error(`${file.name}: HTTP ${response.status}`);
    const bytes = Buffer.from(await response.arrayBuffer());
    if (sha256(bytes) !== file.sha256) throw new Error(`${file.name}: SHA-256 does not match examples.json`);
    cache.set(file.url, bytes);
  }
  return cache.get(file.url);
}

function parseCsv(text) {
  const [header, ...rows] = text.trim().split("\n");
  const keys = header.split(",");
  return rows.map((row) => {
    const cells = row.match(/("([^"]|"")*"|[^,]*)(,|$)/g).map((cell) => cell.replace(/,$/, "").replace(/^"|"$/g, ""));
    return Object.fromEntries(keys.map((key, k) => [key, cells[k]]));
  });
}

async function downloadRow(page, label) {
  const event = page.waitForEvent("download");
  await page.locator("#resultList .nd-volume-toggle").filter({ hasText: label }).getByRole("button", { name: "Download" }).click();
  const download = await event;
  return { name: download.suggestedFilename(), text: readFileSync(await download.path(), "utf8"), bytes: readFileSync(await download.path()) };
}

async function loadExample(page, example) {
  await page.locator("select[data-neurodesk-example]").selectOption(example.id);
  await expect(page.locator("#fileInfo")).toContainText(example.files[0].name, { timeout: 180000 });
  await expect(page.locator("#runButton")).toBeEnabled();
}

async function runAndWait(page) {
  await page.locator("#runButton").click();
  await expect(page.locator("#statusText")).toContainText("Quality control complete", { timeout: 240000 });
}

const tiff = (name, buffer) => ({ name, mimeType: "image/tiff", buffer: Buffer.from(buffer) });

test("app boots on its workspace", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator("#viewer")).toBeVisible();
  await expect(page.locator("#statusText")).toHaveText("Drag and drop files");
  await expect(page.locator("#runButton")).toBeDisabled();
  await expect(page.locator("#technicalLog")).toHaveClass(/collapsed/);
});

test("shared app bar owns information actions and theme", async ({ page }) => {
  await page.goto("/");
  const bar = page.locator(".nd-app-bar:visible");
  await expect(bar).toHaveCount(1);
  await expect(page.locator("#controls > #aboutBtn")).toBeHidden();
  await bar.getByRole("button", { name: "About", exact: true }).click();
  const about = page.locator("#infoDialog");
  await expect(about).toBeVisible();
  await expect(about.getByRole("heading", { name: `About ${automation.title}`, exact: true })).toBeVisible();
  for (const text of ["MetroloJ_QC", "QUAREP-LiMi", "0.51 λem/NA", "90–100 %", "focal-shift"]) await expect(about).toContainText(text);
  await about.getByRole("button", { name: "Close" }).click();
  await bar.locator("[data-neurodesk-theme-toggle]").click();
  await expect(page.locator("html")).toHaveAttribute("data-neurodesk-theme", "light");
});

test("page is cross-origin isolated (COOP/COEP active)", async ({ page }) => {
  await page.goto("/");
  expect(await page.evaluate(() => self.crossOriginIsolated === true)).toBe(true);
});

test("the bead example reads its optics, and its FWHMs equal MetroloJ_QC's fits", async ({ page }) => {
  test.setTimeout(300000);
  await page.goto("/");
  await loadExample(page, beads);
  await expect(page.locator("#fileInfo")).toHaveText(`${beads.files[0].name} · 512 × 512 · 81 planes · uint8`);
  await expect(page.locator("#analysis")).toHaveValue("psf");
  await expect(page.locator("#na")).toHaveValue("0.95");
  await expect(page.locator("#refractiveIndex")).toHaveValue("1.000277");
  await expect(page.locator("#emission")).toHaveValue("525");
  await expect(page.locator("#pixelX")).toHaveValue("0.12615174");
  await expect(page.locator("#zStep")).toHaveValue("0.13283375");
  await runAndWait(page);
  await expect(page.locator("#outputSection")).toHaveAttribute("open", "");
  await expect(page.locator("#report")).toBeHidden();
  await page.locator(".nd-view-tab", { hasText: "Report" }).click();
  await expect(page.locator("#report")).toBeVisible();
  await expect(page.locator("#report")).toContainText("FWHM summary");

  const table = parseCsv((await downloadRow(page, "Beads (CSV)")).text);
  expect(table).toHaveLength(reference.example.app.maximaCount);
  expect(table.filter((row) => row.status === "used").map((row) => Number(row.bead))).toEqual(reference.example.app.used);
  let compared = 0;
  for (const ref of reference.example.beads) {
    const row = table.find((r) => Number(r.bead) === ref.id);
    expect([Number(row.x_px), Number(row.y_px), Number(row.z_px)]).toEqual([ref.x, ref.y, ref.z]);
    for (const axis of ["x", "y", "z"]) {
      if (ref.r2[axis] < 0.8) continue;
      expect(Math.abs(Number(row[`fwhm_${axis}_um`]) - ref.fwhm[axis]) / ref.fwhm[axis]).toBeLessThan(1e-5);
      compared++;
    }
  }
  expect(compared).toBeGreaterThanOrEqual(120);

  const summary = parseCsv((await downloadRow(page, "FWHM summary (CSV)")).text);
  const z = summary.find((row) => row.axis === "z");
  expect(Number(z.theoretical_um)).toBeCloseTo(reference.example.theory.axial, 6);
  expect(Number(z.mean_to_theoretical)).toBeGreaterThan(1.5);
  await expect(page.locator('#report tr[data-flag="above 1.5 × theory"]')).toHaveCount(1);

  const report = JSON.parse((await downloadRow(page, "Report (JSON)")).text);
  expect(report.app).toBe("microscope-qc");
  expect(report.boxHalfWidthPx).toBe(reference.example.halfBox);
  expect(report.prominence).toBeCloseTo(reference.example.prominence, 9);
  const overlay = await downloadRow(page, "Bead boxes");
  expect(overlay.name).toBe("evos-40x-na095-tetraspeck-100nm_beads.tif");
  const profiles = parseCsv((await downloadRow(page, "Profiles and fits (CSV)")).text);
  expect(profiles.filter((row) => row.bead === String(reference.example.beads[0].id) && row.axis === "z")).toHaveLength(81);

  // The image view shows the stack with the bead overlay; returning to the input keeps the result.
  await page.locator("#resultList .nd-volume-toggle").filter({ hasText: "Bead boxes" }).getByRole("button", { name: "View" }).click();
  await expect(page.locator("#gl1")).toBeVisible();
});

test("the synthetic field example equals the ImageJ field-illumination reference", async ({ page }) => {
  test.setTimeout(180000);
  await page.goto("/");
  await loadExample(page, field);
  await expect(page.locator("#analysis")).toHaveValue("field");
  await expect(page.locator("#na")).toBeHidden();
  await runAndWait(page);
  const metrics = Object.fromEntries(parseCsv((await downloadRow(page, "Field metrics (CSV)")).text).map((row) => [row.metric, Number(row.value)]));
  const ref = reference.example.field;
  expect(Math.abs(metrics.uniformity_percent - ref.uniformity)).toBeLessThan(1e-6);
  expect(Math.abs(metrics.field_uniformity_percent - ref.fieldUniformity)).toBeLessThan(1e-6);
  expect(Math.abs(metrics.centering_accuracy_percent - ref.centeringAccuracy)).toBeLessThan(1e-6);
  expect(metrics.max_intensity).toBe(ref.max);
  expect(metrics.min_intensity).toBe(ref.min);
  await expect(page.locator("#report")).toContainText("Uniformity 45.0 %");
  await expect(page.locator('#report tr[data-flag="below 50 %"]')).toHaveCount(1);
  const zones = await downloadRow(page, "Iso-intensity zones");
  expect(zones.name).toBe("synthetic-field-illumination_zones.tif");
  const profiles = parseCsv((await downloadRow(page, "Profiles (CSV)")).text);
  expect(new Set(profiles.map((row) => row.profile))).toEqual(new Set(["horizontal", "vertical", "diagonalTlBr", "diagonalTrBl"]));
});

test("a stack without metadata runs with optics and voxel size entered by hand", async ({ page }) => {
  test.setTimeout(180000);
  const spacing = { x: 0.08, y: 0.08, z: 0.2 };
  const sigma = { x: 0.1, y: 0.1, z: 0.35 };
  const data = beadStack({ nx: 72, ny: 72, nz: 25, spacing, sigma, beads: [{ x: 20.2, y: 22.6, z: 12.3, amplitude: 3000 }, { x: 50.4, y: 48.1, z: 11.8, amplitude: 2500 }], background: 150, noise: 10, seed: 5 });
  await page.goto("/");
  await page.locator("#imageInput").setInputFiles(tiff("plain-beads.tif", writeTiffStack({ width: 72, height: 72, data: Uint16Array.from(data) })));
  await expect(page.locator("#statusText")).toHaveText("plain-beads.tif loaded · enter the optics and voxel size", { timeout: 60000 });
  await page.locator("#runButton").click();
  await expect(page.locator("#statusText")).toHaveText("Enter the numerical aperture.");
  await expect(page.locator("#na")).toBeFocused();
  await page.locator("#na").fill("1.4");
  await page.locator("#refractiveIndex").fill("1.518");
  await page.locator("#emission").fill("520");
  await page.locator("#pixelX").fill("0.08");
  await page.locator("#pixelY").fill("0.08");
  await page.locator("#zStep").fill("0.2");
  await page.locator("#advancedSettings > summary").click();
  await page.locator("#prominence").fill("500");
  await page.locator("#boxRadius").fill("0.8");
  await runAndWait(page);
  const table = parseCsv((await downloadRow(page, "Beads (CSV)")).text);
  expect(table.filter((row) => row.status === "used")).toHaveLength(2);
  for (const row of table) {
    for (const axis of ["x", "y", "z"]) {
      const truth = sigma[axis] * FWHM_PER_SIGMA;
      expect(Math.abs(Number(row[`fwhm_${axis}_um`]) - truth) / truth).toBeLessThan(0.01);
    }
  }
});

test("analyses that do not fit the image are refused with the field to change", async ({ page }) => {
  await page.goto("/");
  await page.locator("#imageInput").setInputFiles(tiff("plane.tif", writeTiffStack({ width: 32, height: 32, data: new Uint16Array(32 * 32).fill(100) })));
  await expect(page.locator("#analysis")).toHaveValue("field", { timeout: 60000 });
  await page.locator("#analysis").selectOption("psf");
  for (const [id, value] of [["na", "0.9"], ["refractiveIndex", "1"], ["emission", "520"], ["pixelX", "0.1"], ["pixelY", "0.1"], ["zStep", "0.2"]]) await page.locator(`#${id}`).fill(value);
  await page.locator("#runButton").click();
  await expect(page.locator("#statusText")).toContainText("PSF needs a bead z-stack");
  await expect(page.locator("#resultList .nd-volume-toggle")).toHaveCount(0);
  await page.locator("#imageInput").setInputFiles(tiff("rgb.tif", Buffer.from(readFileSync(new URL("../../../packages/components/test/fixtures/rgb-uint8.tif", import.meta.url)))));
  await expect(page.locator("#statusText")).toContainText("samples per pixel", { timeout: 60000 });
});

test("cancelling a run leaves no output and permits a complete retry", async ({ page }) => {
  test.setTimeout(300000);
  await page.goto("/");
  await loadExample(page, beads);
  // The first PSF task takes the stack (transferred, not copied) and its result is held back, so
  // cancelling terminates the worker with the stack and the retry has to decode the file again.
  await page.evaluate(() => {
    const post = Worker.prototype.postMessage;
    Worker.prototype.postMessage = function (message, transfer) {
      if (message?.type === "psf" && !window.heldPsf) {
        window.heldPsf = true;
        const deliver = this.onmessage;
        this.onmessage = (event) => {
          if (event.data.progress !== undefined) deliver(event);
        };
      }
      return post.call(this, message, transfer);
    };
  });
  await page.locator("#runButton").click();
  await page.waitForFunction(() => window.heldPsf === true);
  await expect(page.locator("#cancelButton")).toBeVisible();
  await page.locator("#cancelButton").click();
  await expect(page.locator("#statusText")).toHaveText("Cancelled");
  await expect(page.locator("#resultList .nd-volume-toggle")).toHaveCount(0);
  await expect(page.locator("#runButton")).toBeEnabled();
  await runAndWait(page);
  await expect(page.locator("#resultList .nd-volume-toggle")).toHaveCount(5);
});

for (const failure of ["download", "corrupt bytes"]) {
  test(`a failed ${failure} can retry the same example`, async ({ page }) => {
    test.setTimeout(240000);
    const bytes = await exampleBytes(field);
    let attempts = 0;
    await page.context().route(field.files[0].url, async (route) => {
      attempts++;
      if (attempts > 1) return route.fulfill({ body: bytes, contentType: "image/tiff" });
      return route.fulfill(failure === "download" ? { status: 404, body: "" } : { status: 200, body: "not the example" });
    });
    await page.goto("/");
    const picker = page.getByRole("combobox", { name: "Input", exact: true });
    await picker.selectOption(field.id);
    await expect(page.locator("[data-neurodesk-examples]")).toHaveAttribute("data-example-state", "error");
    await expect(page.locator("#runButton")).toBeDisabled();
    await expect(picker).toBeEnabled();
    await picker.selectOption(field.id);
    await expect(page.locator("[data-neurodesk-examples]")).toHaveAttribute("data-example-state", "ready", { timeout: 180000 });
    await expect(page.locator("#runButton")).toBeEnabled();
    expect(attempts).toBe(2);
  });
}

test("cancelling during image reading prevents a late commit and permits retry", async ({ page }) => {
  test.setTimeout(240000);
  const bytes = await exampleBytes(field);
  await page.context().route(field.files[0].url, (route) => route.fulfill({ body: bytes, contentType: "image/tiff" }));
  await page.goto("/");
  await page.evaluate(() => {
    const read = File.prototype.arrayBuffer;
    File.prototype.arrayBuffer = function () {
      const file = this;
      return new Promise((resolve, reject) => {
        window.finishExampleRead = () => {
          File.prototype.arrayBuffer = read;
          read.call(file).then(resolve, reject);
        };
      });
    };
  });
  const picker = page.getByRole("combobox", { name: "Input", exact: true });
  await picker.selectOption(field.id);
  await page.waitForFunction(() => typeof window.finishExampleRead === "function", null, { timeout: 180000 });
  await page.getByRole("button", { name: "Cancel example download", exact: true }).click();
  await page.evaluate(() => window.finishExampleRead());
  await expect(page.locator("[data-neurodesk-examples]")).toHaveAttribute("data-example-state", "cancelled");
  await expect(page.locator("#fileInfo")).toBeHidden();
  await expect(page.locator("#runButton")).toBeDisabled();
  await picker.selectOption(field.id);
  await expect(page.locator("[data-neurodesk-examples]")).toHaveAttribute("data-example-state", "ready", { timeout: 180000 });
  await expect(page.locator("#runButton")).toBeEnabled();
});

test("the automation operation runs field QC and downloads its declared artifacts", async ({ page }) => {
  test.setTimeout(180000);
  const bytes = await exampleBytes(field);
  await page.goto("/");
  await page.locator("#neurodesk-input-transfer").setInputFiles(tiff("field.ome.tif", bytes));
  await page.evaluate(async () => {
    await globalThis.neurodeskAutomation.dispatch("adopt", { role: "image" });
    await globalThis.neurodeskAutomation.dispatch("start", { parameters: { analysis: "field", step: 10 } });
  });
  await expect.poll(() => page.evaluate(async () => (await globalThis.neurodeskAutomation.dispatch("snapshot")).state), { timeout: 120000 }).toMatch(/succeeded|failed/);
  const snapshot = await page.evaluate(async () => globalThis.neurodeskAutomation.dispatch("snapshot"));
  expect(snapshot.error?.message ?? null).toBeNull();
  const { report } = snapshot;
  expect(Object.keys(report.artifacts).sort()).toEqual(["metrics", "overlay", "points", "profiles", "provenance"]);
  expect(report.provenance.metrics.uniformity).toBeCloseTo(reference.example.field.uniformity, 9);
  const download = page.waitForEvent("download");
  await page.evaluate(() => globalThis.neurodeskAutomation.dispatch("download", { artifactId: "metrics" }));
  const metrics = readFileSync(await (await download).path());
  expect(sha256(metrics)).toBe(report.artifacts.metrics.sha256);
});
