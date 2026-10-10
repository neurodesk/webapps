import { test, expect } from "@playwright/test";
import { forceCpu, proxyAssets } from "./tissue-runtime.mjs";
import { readFile } from "node:fs/promises";
import { CASES, compare, documents, exampleFiles, headline, readReference, summarize, writeReference } from "../../../packages/lcmodel/validation/reference.mjs";

// Runs every case of packages/lcmodel/validation/reference.mjs through the
// built app (its automation, worker, served WebAssembly and basis sets),
// downloads every artifact and compares them with
// packages/lcmodel/validation/browser-reference.json, the reference the
// lcmodel command line's release check also uses. Runs only when
// LCMODEL_BROWSER_REFERENCE is "check" or "write" ("write" records the results).
const mode = process.env.LCMODEL_BROWSER_REFERENCE;
const minutes = 60_000;
const dispatch = (page, command, request = {}) => page.evaluate(({ command, request }) => globalThis.neurodeskAutomation.dispatch(command, request), { command, request });

async function adopt(page, files, role) {
  if (!files.length) return;
  // Each cached file keeps the example's file name, so the app sees the same names.
  await page.locator("#neurodesk-input-transfer").setInputFiles(files.map((file) => file.path));
  await dispatch(page, "adopt", { role });
}

for (const entry of CASES) {
  test(`web app ${entry.operation} of ${entry.id} matches the browser reference`, async ({ page, browser }) => {
    test.skip(mode !== "check" && mode !== "write", "set LCMODEL_BROWSER_REFERENCE=check or write");
    test.setTimeout(20 * minutes);
    await proxyAssets(page);
    const files = await exampleFiles(entry.example, { includeT1: entry.t1 });
    if (entry.t1) await forceCpu(page);
    await page.goto("/");
    await expect(page.locator("#neurodesk-input-transfer")).toHaveCount(1);
    await adopt(page, files.filter((f) => f.role !== "basis" && f.role !== "t1"), "spectra");
    await adopt(page, files.filter((f) => f.role === "basis"), "basis");
    await adopt(page, files.filter((f) => f.role === "t1"), "t1");
    const started = performance.now();
    await dispatch(page, "start", { operation: entry.operation, parameters: entry.parameters });
    await expect.poll(async () => (await dispatch(page, "snapshot")).state, { timeout: 15 * minutes, intervals: [2_000] }).not.toBe("running");
    const seconds = Math.round((performance.now() - started) / 100) / 10;
    const snapshot = await dispatch(page, "snapshot");
    expect(snapshot.state, JSON.stringify(snapshot.error)).toBe("succeeded");
    const downloads = new Map();
    for (const artifactId of Object.keys(snapshot.report.artifacts)) {
      const downloaded = page.waitForEvent("download");
      await dispatch(page, "download", { artifactId });
      const download = await downloaded;
      downloads.set(download.suggestedFilename(), await readFile(await download.path()));
    }
    if (entry.t1) {
      const correction = [...downloads].find(([name]) => name.endsWith("_tissue_correction.json"));
      expect(JSON.parse(correction[1].toString("utf8")).fractionSource.backend).toBe("cpu");
    }
    const actual = { files: summarize(downloads), headline: headline(downloads), documents: documents(downloads) };
    const reference = await readReference().catch(() => ({ cases: {} }));
    if (mode === "write") {
      reference.browser = {
        path: "apps/lcmodel/e2e/reference.spec.js: the app's fit and fit-group automation, its worker, the built assets",
        app: `lcmodel ${snapshot.report.appVersion}`,
        browser: `Chromium ${browser.version()}`,
      };
      reference.cases = { ...reference.cases, [entry.id]: { ...actual, seconds } };
      await writeReference(reference);
      return;
    }
    const failures = compare(entry.id, actual, reference.cases[entry.id]).filter(([passed]) => !passed).map(([, line]) => line);
    expect(failures).toEqual([]);
  });
}
