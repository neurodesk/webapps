// The typed automation contract: adopt files, run `fit`, check the report and an artifact.
import { test, expect } from "@playwright/test";
import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";

const examples = JSON.parse(await readFile(new URL("../examples.json", import.meta.url), "utf8"));
const example = examples.find((e) => e.id === "lcmodel-test");
const dispatch = (page, command, request = {}) => page.evaluate(({ command, request }) => globalThis.neurodeskAutomation.dispatch(command, request), { command, request });

test("fit reproduces LCModel's native table on its test case", async ({ page, request }) => {
  test.setTimeout(240000);
  await page.goto("/");
  await expect(page.locator("#neurodesk-input-transfer")).toHaveCount(1);
  const spectra = [];
  let basis;
  for (const file of example.files) {
    const response = await request.get(file.url);
    expect(response.ok()).toBe(true);
    const entry = { name: file.name, mimeType: "application/octet-stream", buffer: await response.body() };
    if (/\.basis/i.test(file.name)) basis = entry;
    else spectra.push(entry);
  }
  await page.locator("#neurodesk-input-transfer").setInputFiles(spectra);
  await dispatch(page, "adopt", { role: "spectra" });
  await page.locator("#neurodesk-input-transfer").setInputFiles([basis]);
  await dispatch(page, "adopt", { role: "basis" });
  // LCModel's own line-broadening prior, as the test case's control file has it.
  await dispatch(page, "start", { operation: "fit", parameters: { lineBroadening: "lcmodel" } });
  await expect.poll(async () => (await dispatch(page, "snapshot")).state, { timeout: 200000 }).not.toBe("running");
  const snapshot = await dispatch(page, "snapshot");
  expect(snapshot.state, JSON.stringify(snapshot.error)).toBe("succeeded");
  const { report } = snapshot;
  expect(report.provenance.basisSet).toBe("3t.basis");
  // Native gfortran LCModel on the same files (exes/lcmodel/tests/data/test_lcm/native.table).
  expect(report.measurements.metabolites.NAA.concentration).toBeCloseTo(1.91e-6, 8);
  expect(report.measurements.ratioTo).toBe("Cr+PCr");
  expect(report.provenance.lineBroadening).toBe("lcmodel");
  expect(report.provenance.control).not.toMatch(/desdt2|rfwbas/);
  const download = page.waitForEvent("download");
  await dispatch(page, "download", { artifactId: "concentrations" });
  const bytes = await readFile(await (await download).path());
  expect(createHash("sha256").update(bytes).digest("hex")).toBe(report.artifacts.concentrations.sha256);
  expect(bytes.toString()).toContain("\nNAA,0.00000191,5,1.047\n");
  expect(report.artifacts.fitReport.mediaType).toBe("text/html");
});

test("fit-group fits every dataset and returns the group table and a report each", async ({ page, request }) => {
  test.setTimeout(300000);
  const group = examples.find((e) => e.id === "philips-press-group");
  await page.goto("/");
  await expect(page.locator("#neurodesk-input-transfer")).toHaveCount(1);
  const spectra = [];
  for (const file of group.files) {
    const response = await request.get(file.url);
    expect(response.ok()).toBe(true);
    spectra.push({ name: file.name, mimeType: "application/octet-stream", buffer: await response.body() });
  }
  await page.locator("#neurodesk-input-transfer").setInputFiles(spectra);
  await dispatch(page, "adopt", { role: "spectra" });
  await dispatch(page, "start", { operation: "fit-group" });
  await expect.poll(async () => (await dispatch(page, "snapshot")).state, { timeout: 280000 }).not.toBe("running");
  const snapshot = await dispatch(page, "snapshot");
  expect(snapshot.state, JSON.stringify(snapshot.error)).toBe("succeeded");
  const { report } = snapshot;
  expect(report.measurements.datasets.map((d) => [d.name, d.status, d.basisSet, d.unit])).toEqual([
    ["sub-01_PRESS_35_act", "fitted", "press-3t-te35-shaped", "mM"],
    ["sub-02_PRESS_35_act", "fitted", "press-3t-te35-shaped", "mM"],
  ]);
  expect(report.measurements.datasets.map((d) => d.lineBroadening)).toEqual(["widened", "widened"]);
  expect(report.provenance.basisSelection).toBe("recommended");
  expect(report.provenance.lineBroadening).toBe("widened");
  expect(Object.keys(report.artifacts).sort()).toEqual(["groupTable", "groupWide", "reports-1", "reports-2"]);
  const download = page.waitForEvent("download");
  await dispatch(page, "download", { artifactId: "groupTable" });
  const bytes = await readFile(await (await download).path());
  expect(createHash("sha256").update(bytes).digest("hex")).toBe(report.artifacts.groupTable.sha256);
  const header = bytes.toString().split("\n")[0];
  expect(header).toMatch(/^dataset,file,status,error,format,basis,edited,unit,ratio_to,macromolecule_model,line_broadening,fraction_gm,fraction_wm,fraction_csf,fraction_source,/);
  expect(header).toMatch(/,tissue_corrected_mmol_per_kg,alpha_corrected_mmol_per_kg$/);
});

test("fit takes tissue fractions as parameters and reports corrected concentrations", async ({ page, request }) => {
  test.setTimeout(300000);
  await page.goto("/");
  const philips = examples.find((e) => e.id === "philips-press-t1");
  const spectra = [];
  for (const file of philips.files.filter((f) => f.role !== "t1")) {
    const response = await request.get(file.url);
    expect(response.ok()).toBe(true);
    spectra.push({ name: file.name, mimeType: "application/octet-stream", buffer: await response.body() });
  }
  await page.locator("#neurodesk-input-transfer").setInputFiles(spectra);
  await dispatch(page, "adopt", { role: "spectra" });
  await dispatch(page, "start", { operation: "fit", parameters: { fractionGM: 0.6, fractionWM: 0.27, fractionCSF: 0.13 } });
  await expect.poll(async () => (await dispatch(page, "snapshot")).state, { timeout: 280000 }).not.toBe("running");
  const snapshot = await dispatch(page, "snapshot");
  expect(snapshot.state, JSON.stringify(snapshot.error)).toBe("succeeded");
  const { tissue, metabolites } = snapshot.report.measurements;
  expect(tissue.source).toEqual({ kind: "entered" });
  expect(snapshot.report.provenance.lineBroadening).toBe("widened");
  expect(snapshot.report.provenance.control).toMatch(/\n desdt2=2\n rfwbas=80\n/);
  expect(tissue.unit).toBe("mmol/kg tissue water");
  // Osprey's quantTiss factor for tNAA at TE 35 / TR 2000 ms with these fractions.
  expect(tissue.metabolites["NAA+NAAG"].corrected / metabolites["NAA+NAAG"].concentration).toBeCloseTo(25.7583426324 / 12, 6);
  expect(snapshot.report.artifacts.tissueConcentrations.sha256).toMatch(/^[0-9a-f]{64}$/);
});

test("fit-fmrs runs functional MRS end-to-end via automation and returns fMRS artifacts and measurements", async ({ page, request }) => {
  test.setTimeout(300000);
  const ge = examples.find((e) => e.id === "ge-press-phantom");
  await page.goto("/");
  await expect(page.locator("#neurodesk-input-transfer")).toHaveCount(1);
  const spectra = [];
  for (const file of ge.files) {
    const response = await request.get(file.url);
    expect(response.ok()).toBe(true);
    spectra.push({ name: file.name, mimeType: "application/octet-stream", buffer: await response.body() });
  }
  const eventsTsv = "onset\tduration\ttrial_type\n0\t6\tRest\n6\t6\tStim\n12\t6\tRest\n18\t6\tStim\n";
  await page.locator("#neurodesk-input-transfer").setInputFiles(spectra);
  await dispatch(page, "adopt", { role: "spectra" });
  await page.locator("#neurodesk-input-transfer").setInputFiles([{
    name: "task-pilot_events.tsv",
    mimeType: "text/tab-separated-values",
    buffer: Buffer.from(eventsTsv, "utf8"),
  }]);
  await dispatch(page, "adopt", { role: "events" });
  await dispatch(page, "start", {
    operation: "fit-fmrs",
    parameters: { fmrsMode: "sliding", fmrsWindow: 4, fmrsStep: 4, matchLinewidth: true, dynamicGlm: true },
  });
  await expect.poll(async () => (await dispatch(page, "snapshot")).state, { timeout: 280000 }).not.toBe("running");
  const snapshot = await dispatch(page, "snapshot");
  expect(snapshot.state, JSON.stringify(snapshot.error)).toBe("succeeded");
  const { report } = snapshot;
  expect(report.measurements.mode).toBe("sliding");
  expect(report.measurements.windows).toHaveLength(4);
  expect(report.measurements.dynamicGlm?.aligned).toBe(true);
  expect(Object.keys(report.artifacts).sort()).toEqual([
    "fmrsReport", "fmrsStats", "fmrsTimeCourse", "fmrsTimeCourseWide", "fmrsTransients",
  ]);
  const dl = page.waitForEvent("download");
  await dispatch(page, "download", { artifactId: "fmrsStats" });
  const bytes = await readFile(await (await dl).path());
  expect(createHash("sha256").update(bytes).digest("hex")).toBe(report.artifacts.fmrsStats.sha256);
  expect(bytes.toString()).toContain("dynamic_projection_glm");
});
