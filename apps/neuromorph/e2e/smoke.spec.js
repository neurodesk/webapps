// Browser tests against the production build (playwright.config.js). The example tests
// fetch the hosted reconstructions and hold the downloaded tables to NeuroM 4.0.6's numbers
// (validation/neurom-reference.json).
import { test, expect } from "@playwright/test";
import { readFileSync } from "node:fs";

const examples = JSON.parse(readFileSync(new URL("../examples.json", import.meta.url), "utf8"));
const automation = JSON.parse(readFileSync(new URL("../automation.json", import.meta.url), "utf8"));
const reference = JSON.parse(readFileSync(new URL("../validation/neurom-reference.json", import.meta.url), "utf8"));
const TOLERANCE = 1e-6;
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
      close(Number(row.mean_local_bifurcation_angle_deg), mean(features.localBifurcationAngles), `${row.neurite_type} local angle`);
      close(Number(row.mean_remote_bifurcation_angle_deg), mean(features.remoteBifurcationAngles), `${row.neurite_type} remote angle`);
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
  await expect(page.locator("#statusText")).toHaveText("The file has no SWC samples.");
  await expect(page.locator("#runButton")).toBeDisabled();
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
