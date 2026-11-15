import { test, expect } from "@playwright/test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MINDGRAB_VERSION, correct } from "@neurodesk/n4/node";
import { outputNames } from "@neurodesk/n4/pipeline";
import { compareOutputs, inputChecksums, pinnedExamples, readReference, sharedProvenance, summarize, writeReference } from "../../../packages/n4/validation/reference.mjs";

// Runs every pinned example through the app itself (automation, N4 worker, served n4-bias.wasm,
// built assets) and compares each download with packages/n4/validation/browser-reference.json,
// which the command line's release check also uses. Each example's brain mask comes from the
// command line's CPU MindGrab and reaches the app through its mask input. Runs only when
// N4_BROWSER_REFERENCE is "check" or "write" ("write" records the result).
const mode = process.env.N4_BROWSER_REFERENCE;
const dispatch = (page, command, request = {}) => page.evaluate(({ command, request }) => globalThis.neurodeskAutomation.dispatch(command, request), { command, request });

async function correctInApp(page, example, maskPath) {
  await page.goto("./");
  await expect(page.locator("#neurodesk-input-transfer")).toHaveCount(1);
  // The image's .bval, .bvec and .json share its stem, so they reach the app as its sidecars.
  await page.locator("#neurodesk-input-transfer").setInputFiles(Object.values(example.files).map((file) => file.path));
  await dispatch(page, "adopt", { role: "image" });
  await page.locator("#neurodesk-input-transfer").setInputFiles(maskPath);
  await dispatch(page, "adopt", { role: "mask" });
  const started = performance.now();
  await dispatch(page, "start", { operation: "correct" });
  await expect.poll(async () => (await dispatch(page, "snapshot")).state, { timeout: 5 * 60_000, intervals: [1_000] }).not.toBe("running");
  const snapshot = await dispatch(page, "snapshot");
  expect(snapshot.state, `${example.id}: ${JSON.stringify(snapshot.error)}`).toBe("succeeded");
  const outputs = {};
  for (const role of Object.keys(snapshot.report.artifacts)) {
    const downloading = page.waitForEvent("download");
    await dispatch(page, "download", { artifactId: role });
    const download = await downloading;
    outputs[role] = summarize(download.suggestedFilename(), await readFile(await download.path()));
  }
  return { report: snapshot.report, outputs, seconds: Math.round((performance.now() - started) / 1000) };
}

test("every pinned example in the web app matches the browser reference", { tag: '@heavy' }, async ({ page, browser }) => {
  test.skip(mode !== "check" && mode !== "write", "set N4_BROWSER_REFERENCE=check or write");
  test.setTimeout(20 * 60_000);
  const examples = await pinnedExamples();
  const work = await mkdtemp(join(process.env.TMPDIR || tmpdir(), "n4-reference-"));
  try {
    const masks = {};
    const cases = {};
    let appVersion;
    for (const example of examples) {
      // The command line's MindGrab mask of the example's mean b0 (or image).
      const output = join(work, example.id);
      const cli = await correct({ input: example.files.image.path, output });
      expect(cli.provenance.mask).toBe(`mindgrab-${MINDGRAB_VERSION}-cpu`);
      const maskName = outputNames(example.files.image.name).mask;
      const maskPath = join(output, maskName);
      masks[example.id] = summarize(maskName, await readFile(maskPath));
      const { report, outputs, seconds } = await correctInApp(page, example, maskPath);
      expect(report.provenance.mask).toBe("supplied");
      appVersion = report.appVersion;
      cases[example.id] = { provenance: report.provenance, seconds, outputs };
    }
    if (mode === "write") {
      await writeReference({
        inputs: inputChecksums(examples),
        masks: { path: "n4 command line: MindGrab CPU modules on the mean b0 (or the image)", provenance: { model: "mindgrab", version: MINDGRAB_VERSION, backend: "cpu" }, examples: masks },
        browser: {
          path: "apps/n4/e2e/reference.spec.js: the app's correct automation with the mask input, N4 worker, built assets",
          app: `n4 ${appVersion}`,
          browser: `Chromium ${browser.version()}`,
          cases,
        },
      });
      return;
    }
    const reference = await readReference();
    expect(reference.inputs).toEqual(inputChecksums(examples));
    const failures = [];
    for (const example of examples) {
      const was = reference.browser.cases[example.id];
      if (masks[example.id].decompressedSha256 !== reference.masks.examples[example.id].decompressedSha256) failures.push(`${example.id}: the command line's MindGrab mask is not the recorded one`);
      expect(sharedProvenance(cases[example.id].provenance), example.id).toEqual(sharedProvenance(was.provenance));
      for (const [passed, line] of compareOutputs(`web app ${example.id}`, cases[example.id].outputs, was.outputs)) {
        if (!passed) failures.push(line);
      }
    }
    expect(failures).toEqual([]);
  } finally {
    await rm(work, { recursive: true, force: true });
  }
});
