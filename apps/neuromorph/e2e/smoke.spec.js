// Browser tests against the production build (playwright.config.js). The example tests
// fetch the hosted reconstructions and hold the downloaded tables to NeuroM 4.0.6's numbers
// (validation/neurom-reference.json).
import { test, expect } from "@playwright/test";
import { readFileSync } from "node:fs";

const examples = JSON.parse(readFileSync(new URL("../examples.json", import.meta.url), "utf8"));
const automation = JSON.parse(readFileSync(new URL("../automation.json", import.meta.url), "utf8"));
const reference = JSON.parse(readFileSync(new URL("../validation/neurom-reference.json", import.meta.url), "utf8"));
const TOLERANCE = 1e-6;
/** Angles also pass within this absolute error, in radians: near 0 a relative error says nothing. */
const ANGLE_TOLERANCE = 1e-7;
const DEGREES = 180 / Math.PI;

// Columns of the morphometrics table and the NeuroM feature each holds.
const COLUMNS = {
  neurites: "neurites",
  sections: "sections",
  bifurcations: "bifurcations",
  forking_points: "forkingPoints",
  terminals: "terminals",
  total_length_um: "totalLength",
  surface_area_um2: "surfaceArea",
  volume_um3: "volume",
  max_path_distance_um: "maxPathDistance",
  max_radial_distance_um: "maxRadialDistance",
  max_branch_order: "maxBranchOrder",
  max_strahler_order: "maxStrahlerOrder",
};

const FORK = ["1 1 0 0 0 5 -1", "2 3 5 0 0 1 1", "3 3 10 0 0 1 2", "4 3 10 10 0 0.5 3", "5 3 20 0 0 0.5 3"].join("\n");
const BROKEN = ["1 1 0 0 0 5 -1", "2 2 0 5 0 0 1", "3 2 0 10 0 1 2", "4 2 0 15 0 1 9"].join("\n");
const swcFile = (name, text) => ({ name, mimeType: "text/plain", buffer: Buffer.from(text) });

function parseCsv(text) {
  const [head, ...rows] = text.trim().split("\n").map((line) => line.split(","));
  return rows.map((row) => Object.fromEntries(head.map((key, k) => [key, row[k]])));
}

async function download(page, label) {
  const promise = page.waitForEvent("download");
  await page.locator("#resultList .nd-volume-toggle", { hasText: label }).getByRole("button", { name: "Download", exact: true }).click();
  const file = await promise;
  return { name: file.suggestedFilename(), text: readFileSync(await file.path(), "utf8") };
}

function close(actual, expected, what) {
  const error = Math.abs(actual - expected) / Math.max(Math.abs(expected), 1e-9);
  expect(error, `${what}: ${actual} vs NeuroM ${expected}`).toBeLessThanOrEqual(TOLERANCE);
}

/** Angles in degrees: within the relative tolerance or within ANGLE_TOLERANCE radians. */
function closeAngle(actual, expected, what) {
  const absolute = Math.abs(actual - expected) / DEGREES;
  const relative = absolute / Math.max(Math.abs(expected / DEGREES), 1e-9);
  expect(Math.min(relative / TOLERANCE, absolute / ANGLE_TOLERANCE), `${what}: ${actual} vs NeuroM ${expected}`).toBeLessThanOrEqual(1);
}

/** Drop files on the input box as a folder drop delivers them, each with its relative path. */
async function dropFolder(page, files) {
  await page.evaluate((files) => {
    const dropped = files.map(({ path, text }) => {
      const file = new File([text], path.split("/").at(-1), { type: "text/plain" });
      Object.defineProperty(file, "webkitRelativePath", { value: path });
      return file;
    });
    const event = new Event("drop", { bubbles: true, cancelable: true });
    Object.defineProperty(event, "dataTransfer", { value: { items: [], files: dropped } });
    document.getElementById("dropZone").dispatchEvent(event);
  }, files);
}

test("app boots on the workspace with the shared app bar", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator("#statusText")).toHaveText("Drag and drop files");
  await expect(page.locator("#technicalLog")).toHaveClass(/collapsed/);
  const bar = page.locator(".nd-app-bar:visible");
  await expect(bar).toHaveCount(1);
  await bar.getByRole("button", { name: "About", exact: true }).click();
  await expect(page.locator("#infoDialog").getByRole("heading", { name: `About ${automation.title}`, exact: true })).toBeVisible();
  await page.locator("#infoDialog").getByRole("button", { name: "Close" }).click();
  expect(await page.evaluate(() => self.crossOriginIsolated === true)).toBe(true);
});

for (const example of examples) {
  test(`example ${example.id} measures like NeuroM and downloads its tables`, async ({ page }) => {
    test.setTimeout(120000);
    const file = example.files[0];
    const expected = reference.morphologies.find((m) => m.file === file.name);
    await page.goto("/");
    await page.locator("select[data-neurodesk-example]").selectOption(example.id);
    await expect(page.locator("[data-neurodesk-examples]")).toHaveAttribute("data-example-state", "ready", { timeout: 120000 });
    await expect(page.locator("#fileInfo")).toHaveText(file.name);
    await expect(page.locator("#emptyState")).toBeHidden();
    await expect(page.locator("#legend")).toContainText("Basal dendrite");
    await expect(page.locator("#runButton")).toBeEnabled();
    await page.locator("#runButton").click();
    await expect(page.locator("#statusText")).toHaveText(`${file.name} measured`);
    await expect(page.locator("#outputSection")).toHaveAttribute("open", "");
    await expect(page.locator("#morphometricsReport")).toBeVisible();

    const morphometrics = await download(page, "Morphometrics table");
    expect(morphometrics.name).toBe(`${file.name.replace(/\.swc$/, "")}_morphometrics.csv`);
    const rows = parseCsv(morphometrics.text);
    const types = Object.keys(expected.features).filter((type) => type === "all" || expected.features[type].neurites);
    expect(rows.map((row) => row.neurite_type)).toEqual(types);
    for (const row of rows) {
      const features = expected.features[row.neurite_type];
      for (const [column, feature] of Object.entries(COLUMNS)) close(Number(row[column]), features[feature], `${row.neurite_type}.${column}`);
      const mean = (values) => (values.reduce((sum, value) => sum + value, 0) / values.length) * DEGREES;
      closeAngle(Number(row.mean_local_bifurcation_angle_deg), mean(features.localBifurcationAngles), `${row.neurite_type} local angle`);
      closeAngle(Number(row.mean_remote_bifurcation_angle_deg), mean(features.remoteBifurcationAngles), `${row.neurite_type} remote angle`);
    }

    const sholl = parseCsv((await download(page, "Sholl intersections")).text);
    expect(sholl.map((row) => Number(row.radius_um))).toEqual(expected.sholl.radii);
    for (const type of Object.keys(expected.sholl.crossings)) {
      expect(sholl.map((row) => Number(row[`${type}_intersections`])), `Sholl ${type}`).toEqual(expected.sholl.crossings[type]);
    }
    const bifurcations = parseCsv((await download(page, "Bifurcation angles")).text);
    expect(bifurcations).toHaveLength(expected.features.all.bifurcations);

    await page.locator('#viewer [data-view="sholl"]').click();
    await expect(page.locator("#shollReport svg.nd-chart")).toBeVisible();
    await expect(page.locator("#shollReport")).toContainText(`at most ${Math.max(...expected.sholl.crossings.all)} intersections`);
    await page.locator('#viewer [data-view="render"]').click();
    await expect(page.locator("#shollReport")).toBeHidden();
  });
}

test("a failed example download can be retried", async ({ page }) => {
  const example = examples[0];
  let attempts = 0;
  await page.route(example.files[0].url, (route) => (++attempts === 1 ? route.fulfill({ status: 404, body: "" }) : route.continue()));
  await page.goto("/");
  const picker = page.getByRole("combobox", { name: "Input", exact: true });
  await picker.selectOption(example.id);
  await expect(page.locator("[data-neurodesk-examples]")).toHaveAttribute("data-example-state", "error");
  await expect(page.locator("#runButton")).toBeDisabled();
  await picker.selectOption(example.id);
  await expect(page.locator("[data-neurodesk-examples]")).toHaveAttribute("data-example-state", "ready", { timeout: 120000 });
  await expect(page.locator("#runButton")).toBeEnabled();
  expect(attempts).toBe(2);
});

test("cancelling an example download keeps the workspace empty and permits retry", async ({ page }) => {
  const example = examples[0];
  let release;
  const held = new Promise((resolve) => { release = resolve; });
  await page.route(example.files[0].url, async (route) => {
    await held;
    await route.continue().catch(() => {});
  });
  await page.goto("/");
  const picker = page.getByRole("combobox", { name: "Input", exact: true });
  await picker.selectOption(example.id);
  await page.getByRole("button", { name: "Cancel example download", exact: true }).click();
  await expect(page.locator("[data-neurodesk-examples]")).toHaveAttribute("data-example-state", "cancelled");
  release();
  await expect(page.locator("#fileInfo")).toBeHidden();
  await expect(page.locator("#runButton")).toBeDisabled();
  await page.unroute(example.files[0].url);
  await picker.selectOption(example.id);
  await expect(page.locator("[data-neurodesk-examples]")).toHaveAttribute("data-example-state", "ready", { timeout: 120000 });
  await expect(page.locator("#runButton")).toBeEnabled();
});

test("several files are measured together; faults are reported and the repaired file downloads", async ({ page }) => {
  await page.goto("/");
  await page.locator("#swcInput").setInputFiles([swcFile("fork.swc", FORK), swcFile("broken.swc", BROKEN), { name: "notes.txt", mimeType: "text/plain", buffer: Buffer.from("x") }]);
  await expect(page.locator("#fileInfo")).toHaveText("2 reconstructions · 1 other file skipped");
  await expect(page.locator("#neuronField")).toBeVisible();
  await expect(page.locator("#neuronSelect option")).toHaveText(["broken.swc", "fork.swc"]);
  await expect(page.locator("#checks")).toContainText("named a missing parent");
  await page.locator("#neuronSelect").selectOption({ label: "fork.swc" });
  await expect(page.locator("#checks .nd-message")).toHaveCount(0);
  await page.locator("#runButton").click();
  await expect(page.locator("#statusText")).toHaveText("2 reconstructions measured");
  const table = parseCsv((await download(page, "Morphometrics table")).text);
  expect(table.map((row) => `${row.neuron}:${row.neurite_type}`)).toEqual(["broken.swc:all", "broken.swc:axon", "fork.swc:all", "fork.swc:basal"]);
  expect(Number(table.find((row) => row.neuron === "fork.swc" && row.neurite_type === "all").total_length_um)).toBe(25);
  const repaired = await download(page, "Repaired SWC · broken.swc");
  expect(repaired.name).toBe("broken_repaired.swc");
  expect(repaired.text).toContain("\n2 2 0 5 0 1 1\n");
  expect(repaired.text).toContain("\n4 2 0 15 0 1 -1\n");
  await expect(page.locator("#resultList")).not.toContainText("Repaired SWC · fork.swc");

  // A new Sholl step withdraws the old tables; the measured step labels the new ones.
  await page.locator("#shollStep").fill("5");
  await expect(page.locator("#resultList .nd-volume-toggle")).toHaveCount(0);
  await page.locator("#runButton").click();
  await expect(page.locator("#resultList")).toContainText("Sholl intersections · 5 µm step");
});

test("a file without SWC samples is refused with a message", async ({ page }) => {
  await page.goto("/");
  await page.locator("#swcInput").setInputFiles([swcFile("empty.swc", "# nothing here\n")]);
  await expect(page.locator("#statusText")).toHaveText("empty.swc: The file has no SWC samples.");
  await expect(page.locator("#runButton")).toBeDisabled();
});

test("an unreadable file in a folder is skipped and named; the rest load and measure", async ({ page }) => {
  await page.goto("/");
  await dropFolder(page, [{ path: "cells/fork.swc", text: FORK }, { path: "cells/bad/empty.swc", text: "# nothing here\n" }]);
  await expect(page.locator("#statusText")).toHaveText("cells/fork.swc loaded; skipped cells/bad/empty.swc: The file has no SWC samples.");
  await expect(page.locator("#fileInfo")).toHaveText("cells/fork.swc · 1 unreadable file skipped");
  await expect(page.locator("#technicalLog")).toContainText("Skipped cells/bad/empty.swc: The file has no SWC samples.");
  await page.locator("#runButton").click();
  await expect(page.locator("#statusText")).toHaveText("cells/fork.swc measured");
});

test("a file the browser cannot read is skipped and named; the readable ones load", async ({ page }) => {
  await page.goto("/");
  await page.evaluate(() => {
    const text = File.prototype.text;
    File.prototype.text = function () {
      return this.name === "locked.swc" ? Promise.reject(new DOMException("The requested file could not be read", "NotReadableError")) : text.call(this);
    };
  });
  await page.locator("#swcInput").setInputFiles([swcFile("fork.swc", FORK), swcFile("locked.swc", FORK)]);
  await expect(page.locator("#statusText")).toHaveText("fork.swc loaded; skipped locked.swc: The requested file could not be read");
  await page.locator("#runButton").click();
  await expect(page.locator("#statusText")).toHaveText("fork.swc measured");
});

test("with repair off a zero radius is measured, and the report does not call area and volume blank", async ({ page }) => {
  await page.goto("/");
  await page.locator("#repair").uncheck();
  await page.locator("#swcInput").setInputFiles([swcFile("zero.swc", "1 1 0 0 0 5 -1\n2 3 5 0 0 0 1\n3 3 10 0 0 1 2")]);
  await page.locator("#runButton").click();
  await expect(page.locator("#statusText")).toHaveText("zero.swc measured");
  await expect(page.locator("#morphometricsReport")).toBeVisible();
  await expect(page.locator("#morphometricsReport")).not.toContainText("are blank");
});

test("a second flat file of one name downloads its repair under a numbered name", async ({ page }) => {
  await page.goto("/");
  await page.locator("#swcInput").setInputFiles([swcFile("broken.swc", BROKEN), swcFile("broken.swc", BROKEN)]);
  await page.locator("#runButton").click();
  await expect(page.locator("#statusText")).toHaveText("2 reconstructions measured");
  const second = await download(page, "Repaired SWC · broken.swc (2)");
  expect(second.name).toBe("broken_2_repaired.swc");
});

test("files with one name in two folders stay apart in the selector, tables, downloads and automation", async ({ page }) => {
  const LONGER = FORK.replace("5 3 20 0 0 0.5 3", "5 3 40 0 0 0.5 3");
  await page.goto("/");
  await dropFolder(page, [
    { path: "cells/b/cell.swc", text: `# CONTRIBUTOR Lab B\n${BROKEN}` },
    { path: "cells/a/cell.swc", text: `# CONTRIBUTOR Lab A (CC BY 4.0)\n# REFERENCE doi:10.0/a\n${LONGER.replace("2 3 5 0 0 1 1", "2 3 5 0 0 0 1")}` },
  ]);
  await expect(page.locator("#fileInfo")).toHaveText("2 reconstructions");
  await expect(page.locator("#neuronSelect option")).toHaveText(["cells/a/cell.swc", "cells/b/cell.swc"]);
  await page.locator("#neuronSelect").selectOption({ label: "cells/b/cell.swc" });
  await expect(page.locator("#checks")).toContainText("named a missing parent");
  await page.locator("#runButton").click();
  await expect(page.locator("#statusText")).toHaveText("2 reconstructions measured");
  const table = parseCsv((await download(page, "Morphometrics table")).text);
  expect(table.filter((row) => row.neurite_type === "all").map((row) => `${row.neuron}:${row.total_length_um}`)).toEqual(["cells/a/cell.swc:45", "cells/b/cell.swc:5"]);
  const a = await download(page, "Repaired SWC · cells/a/cell.swc");
  const b = await download(page, "Repaired SWC · cells/b/cell.swc");
  expect([a.name, b.name]).toEqual(["cells_a_cell_repaired.swc", "cells_b_cell_repaired.swc"]);
  // The original comments, NeuroMorpho.Org's attribution among them, come first.
  expect(a.text).toMatch(/^# CONTRIBUTOR Lab A \(CC BY 4\.0\)\n# REFERENCE doi:10\.0\/a\n# Repaired by NeuroMorph .* from cells\/a\/cell\.swc\n1 1 /);
  expect(b.text).toMatch(/^# CONTRIBUTOR Lab B\n# Repaired by NeuroMorph /);

  // Automation inputs carry no folders: the second file of a name is numbered.
  await page.locator("#neurodesk-input-transfer").setInputFiles([swcFile("cell.swc", FORK), swcFile("cell.swc", LONGER)]);
  await page.evaluate(async () => {
    await globalThis.neurodeskAutomation.dispatch("adopt", { role: "reconstructions" });
    await globalThis.neurodeskAutomation.dispatch("start", { parameters: {} });
  });
  await expect.poll(() => page.evaluate(async () => (await globalThis.neurodeskAutomation.dispatch("snapshot")).state)).toBe("succeeded");
  const report = await page.evaluate(async () => (await globalThis.neurodeskAutomation.dispatch("snapshot")).report);
  expect(Object.fromEntries(Object.entries(report.measurements).map(([id, m]) => [id, m.totalLengthUm]))).toEqual({ "cell.swc": 25, "cell.swc (2)": 45 });
});

test("measuring a large reconstruction can be cancelled at once and run again", async ({ page }) => {
  test.setTimeout(120000);
  // 20,000 segments zig-zagging over 10 mm with a 0.1 µm step: each crosses ~100,000 spheres,
  // seconds of counting in one reconstruction.
  const rows = ["1 1 0 0 0 1 -1"];
  for (let id = 2; id <= 20001; id++) rows.push(`${id} 3 ${id % 2 ? 10000 : 1} ${id * 0.001} 0 1 ${id - 1}`);
  await page.goto("/");
  await page.locator("#swcInput").setInputFiles([swcFile("zigzag.swc", rows.join("\n"))]);
  await expect(page.locator("#statusText")).toHaveText("zigzag.swc loaded", { timeout: 60000 });
  await page.locator("#shollStep").fill("0.1");
  await page.locator("#runButton").click();
  await expect(page.locator("#cancelButton")).toBeVisible();
  // The page stays responsive while the worker counts.
  const started = Date.now();
  await page.evaluate(() => new Promise((resolve) => setTimeout(resolve, 300)));
  expect(Date.now() - started).toBeLessThan(2000);
  await page.locator("#cancelButton").click();
  await expect(page.locator("#statusText")).toHaveText("Measurement cancelled", { timeout: 2000 });
  await expect(page.locator("#cancelButton")).toBeHidden();
  await expect(page.locator("#resultList .nd-volume-toggle")).toHaveCount(0);
  await expect(page.locator("#runButton")).toBeEnabled();
  await page.locator("#shollStep").fill("100");
  await page.locator("#runButton").click();
  await expect(page.locator("#statusText")).toHaveText("zigzag.swc measured", { timeout: 60000 });
});

test("the automation operation measures its inputs and reports the tables", async ({ page }) => {
  await page.goto("/");
  await page.locator("#neurodesk-input-transfer").setInputFiles(swcFile("fork.swc", FORK));
  await page.evaluate(async () => {
    await globalThis.neurodeskAutomation.dispatch("adopt", { role: "reconstructions" });
    await globalThis.neurodeskAutomation.dispatch("start", { parameters: { shollStep: 5 } });
  });
  await expect.poll(() => page.evaluate(async () => (await globalThis.neurodeskAutomation.dispatch("snapshot")).state)).toBe("succeeded");
  const report = await page.evaluate(async () => (await globalThis.neurodeskAutomation.dispatch("snapshot")).report);
  expect(Object.keys(report.artifacts).sort()).toEqual(["bifurcations", "morphometrics", "sholl"]);
  expect(report.measurements["fork.swc"].totalLengthUm).toBe(25);
  expect(report.provenance.shollStepUm).toBe(5);
  const promise = page.waitForEvent("download");
  await page.evaluate(() => globalThis.neurodeskAutomation.dispatch("download", { artifactId: "sholl" }));
  expect(readFileSync(await (await promise).path(), "utf8")).toContain("fork.swc,10,3,0,3,0");
});
