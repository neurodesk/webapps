import { test, expect } from "@playwright/test";
import { readFile } from "node:fs/promises";
import { registeredName } from "@neurodesk/edgereg";
import { EXAMPLE_SHA256, compareWithBrowser, pinnedExample, readReference, summarize, writeReference } from "../../../packages/edgereg/validation/reference.mjs";

// Registers the pinned example through the app itself (automation, niimath worker, served assets)
// and compares its download with packages/edgereg/validation/t1-mni-reference.json, which the
// command line's release check also uses. Runs only when EDGEREG_BROWSER_REFERENCE is "check" or
// "write" ("write" records the result).
const mode = process.env.EDGEREG_BROWSER_REFERENCE;
const niimath = JSON.parse(await readFile(new URL("../node_modules/@niivue/niimath/package.json", import.meta.url), "utf8"));

test("web app registration of the pinned example matches the browser reference", async ({ page, browser }) => {
  test.skip(mode !== "check" && mode !== "write", "set EDGEREG_BROWSER_REFERENCE=check or write");
  test.setTimeout(10 * 60_000);
  const example = await pinnedExample();
  await page.goto("/");
  await expect(page.locator("#movingInput")).toBeEnabled();
  for (const [role, file] of [["moving", example.moving], ["fixed", example.fixed]]) {
    await page.locator("#neurodesk-input-transfer").setInputFiles({ name: file.name, mimeType: "application/gzip", buffer: await readFile(file.path) });
    await page.evaluate((role) => globalThis.neurodeskAutomation.dispatch("adopt", { role }), role);
  }
  const started = performance.now();
  await page.evaluate(() => globalThis.neurodeskAutomation.dispatch("start", { operation: "register", parameters: { robustFov: false } }));
  await expect.poll(async () => (await page.evaluate(() => globalThis.neurodeskAutomation.dispatch("snapshot"))).state, { timeout: 8 * 60_000, intervals: [2_000] }).toBe("succeeded");
  const seconds = Math.round((performance.now() - started) / 1000);
  const { report } = await page.evaluate(() => globalThis.neurodeskAutomation.dispatch("snapshot"));
  expect(report.provenance).toMatchObject({ algorithm: "niimath allineate", robustFov: false });
  const [artifactId] = Object.keys(report.artifacts);
  const downloaded = page.waitForEvent("download");
  await page.evaluate((artifactId) => globalThis.neurodeskAutomation.dispatch("download", { artifactId }), artifactId);
  const download = await downloaded;
  expect(download.suggestedFilename()).toBe(registeredName(example.moving.name));
  const actual = summarize(await readFile(await download.path()), await readFile(example.fixed.path));
  if (mode === "write") {
    await writeReference({
      example: example.id,
      inputs: EXAMPLE_SHA256,
      robustFov: false,
      browser: {
        path: "apps/edgereg/e2e/reference.spec.js: the app's register automation, niimath worker, built assets",
        app: `edgereg ${report.appVersion}`,
        niimath: `@niivue/niimath ${niimath.version}`,
        browser: `Chromium ${browser.version()}`,
        seconds,
        artifact: actual,
      },
    });
    return;
  }
  const reference = await readReference();
  const failures = compareWithBrowser("web app", actual, reference.browser.artifact)
    .filter(([passed]) => !passed)
    .map(([, line]) => line);
  expect(failures).toEqual([]);
});
