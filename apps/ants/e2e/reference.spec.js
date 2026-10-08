import { test, expect } from "@playwright/test";
import { readFile } from "node:fs/promises";
import { artifactName } from "../../../packages/ants/src/outputs.js";
import { ROLES, compare, pinnedExample, readReference, summarize, writeReference } from "../../../packages/ants/validation/reference.mjs";

// Registers the pinned 1 mm example through the app itself (automation, worker, served assets)
// and compares its four downloads with packages/ants/validation/t1-mni-reference.json, which the
// command line's release check also uses. Runs only when ANTS_BROWSER_REFERENCE is "check" or
// "write" ("write" records the result).
const mode = process.env.ANTS_BROWSER_REFERENCE;
const minutes = 60_000;

test("web app SyN registration of the pinned example matches the browser reference", async ({ page, browser }) => {
  test.skip(mode !== "check" && mode !== "write", "set ANTS_BROWSER_REFERENCE=check or write");
  test.setTimeout(45 * minutes);
  const example = await pinnedExample();
  await page.goto("/");
  await expect(page.locator("#movingInput")).toBeEnabled();
  for (const [role, file] of [["moving", example.moving], ["fixed", example.fixed]]) {
    await page.locator("#neurodesk-input-transfer").setInputFiles({ name: file.name, mimeType: "application/gzip", buffer: await readFile(file.path) });
    await page.evaluate((role) => globalThis.neurodeskAutomation.dispatch("adopt", { role }), role);
  }
  const started = performance.now();
  await page.evaluate(() => globalThis.neurodeskAutomation.dispatch("start", { operation: "register", parameters: {} }));
  await expect.poll(async () => (await page.evaluate(() => globalThis.neurodeskAutomation.dispatch("snapshot"))).state, { timeout: 40 * minutes, intervals: [5_000] }).toBe("succeeded");
  const seconds = Math.round((performance.now() - started) / 1000);
  const { report } = await page.evaluate(() => globalThis.neurodeskAutomation.dispatch("snapshot"));
  expect(report.provenance).toMatchObject({ algorithm: "ANTs SyN", seed: 42 });
  const files = {};
  for (const [artifactId, artifact] of Object.entries(report.artifacts)) {
    const downloaded = page.waitForEvent("download");
    await page.evaluate((artifactId) => globalThis.neurodeskAutomation.dispatch("download", { artifactId }), artifactId);
    const download = await downloaded;
    expect(download.suggestedFilename()).toBe(artifactName(example.moving.name, artifact.role));
    files[artifact.role] = await readFile(await download.path());
  }
  expect(Object.keys(files).sort()).toEqual([...ROLES].sort());
  const actual = summarize(files, await readFile(example.fixed.path));
  const reference = await readReference();
  if (mode === "write") {
    reference.browser = {
      path: "apps/ants/e2e/reference.spec.js: the app's register automation, registration worker, built assets",
      app: `ants ${report.appVersion}`,
      browser: `Chromium ${browser.version()}`,
      seconds,
      artifacts: actual,
    };
    await writeReference(reference);
    return;
  }
  const failures = compare("web app", actual, reference.browser.artifacts, "browser")
    .filter(([passed]) => !passed)
    .map(([, line]) => line);
  expect(failures).toEqual([]);
});
