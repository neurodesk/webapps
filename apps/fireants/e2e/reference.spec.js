import { test, expect } from "@playwright/test";
import { readFile } from "node:fs/promises";
import { THREADS, TRANSFORMS, compare, pinnedExample, readReference, recorded, summarize, writeReference } from "../../../packages/fireants/validation/reference.mjs";

// Registers the pinned 1 mm example through the app itself (automation, worker, served assets)
// and compares the download with packages/fireants/validation/t1-mni-reference.json, which the
// command line's release check also uses. A run takes 15 to 30 minutes per preset on 4 cores, so
// it runs only when FIREANTS_BROWSER_REFERENCE is "check" or "write" ("write" records the result).
const mode = process.env.FIREANTS_BROWSER_REFERENCE;
const minutes = 60_000;

test.describe.configure({ mode: "serial" });

for (const transform of TRANSFORMS) {
  test(`web app ${transform} registration of the pinned example matches the browser reference`, async ({ page, browser }) => {
    test.skip(mode !== "check" && mode !== "write", "set FIREANTS_BROWSER_REFERENCE=check or write");
    test.setTimeout(90 * minutes);
    const example = await pinnedExample();
    await page.goto("/");
    await expect(page.locator("#movingInput")).toBeEnabled();
    for (const [role, file] of [["moving", example.moving], ["fixed", example.fixed]]) {
      await page.locator("#neurodesk-input-transfer").setInputFiles({ name: file.name, mimeType: "application/gzip", buffer: await readFile(file.path) });
      await page.evaluate((role) => globalThis.neurodeskAutomation.dispatch("adopt", { role }), role);
    }
    const started = performance.now();
    await page.evaluate((parameters) => globalThis.neurodeskAutomation.dispatch("start", { operation: "register", parameters }), { backend: "cpu", transform });
    await expect.poll(async () => (await page.evaluate(() => globalThis.neurodeskAutomation.dispatch("snapshot"))).state, { timeout: 85 * minutes, intervals: [10_000] }).toBe("succeeded");
    const seconds = Math.round((performance.now() - started) / 1000);
    const { report } = await page.evaluate(() => globalThis.neurodeskAutomation.dispatch("snapshot"));
    expect(report.provenance).toMatchObject({ backend: "cpu", transform, variant: "mt" });
    expect(report.provenance.threads, `the app chose ${report.provenance.threads} threads; run on ${THREADS} CPUs (taskset -c 0-${THREADS - 1})`).toBe(THREADS);
    const downloaded = page.waitForEvent("download");
    await page.evaluate((artifactId) => globalThis.neurodeskAutomation.dispatch("download", { artifactId }), Object.keys(report.artifacts)[0]);
    const download = await downloaded;
    expect(download.suggestedFilename()).toBe("t1_brain_registered.nii.gz");
    const actual = summarize(await readFile(await download.path()), await readFile(example.fixed.path));
    const reference = await readReference();
    if (mode === "write") {
      reference.cases[transform].browser = {
        path: "apps/fireants/e2e/reference.spec.js: the app's register automation, registration worker, built assets",
        app: `fireants ${report.appVersion}`,
        browser: `Chromium ${browser.version()}`,
        threads: report.provenance.threads,
        seconds,
        ...recorded(actual),
      };
      await writeReference(reference);
      return;
    }
    const failures = compare(`${transform} web app`, actual, reference.cases[transform].browser, "browser")
      .filter(([passed]) => !passed)
      .map(([, line]) => line);
    expect(failures).toEqual([]);
  });
}
