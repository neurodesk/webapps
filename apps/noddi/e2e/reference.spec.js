import { test, expect } from "@playwright/test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MINDGRAB_VERSION, fit } from "@neurodesk/noddi/node";
import { maskName, bidsStem } from "@neurodesk/noddi/pipeline";
import { CASES, caseInputs, compareOutputs, inputChecksums, readReference, sharedProvenance, summarize, writeReference } from "../../../packages/noddi/validation/reference.mjs";

// Runs every case of packages/noddi/validation/reference.mjs through the app itself (automation,
// fitting workers, served noddi.wasm, built assets) and compares each download with
// packages/noddi/validation/browser-reference.json, which the command line's release check also
// uses. The example's brain mask comes from the command line's CPU MindGrab and reaches the app
// through its mask input; the phantom gets a mask of every voxel. Runs only when
// NODDI_BROWSER_REFERENCE is "check" or "write" ("write" records the result).
const mode = process.env.NODDI_BROWSER_REFERENCE;
// Chromium stops a tab's scripted downloads after ten, so the phantom's eleven files take two runs.
const DOWNLOADS_PER_PAGE = 10;
const dispatch = (page, command, request = {}) => page.evaluate(({ command, request }) => globalThis.neurodeskAutomation.dispatch(command, request), { command, request });

async function fitInApp(page, roles, parameters) {
  await page.goto("/");
  for (const [role, file] of roles) {
    await page.locator("#neurodesk-input-transfer").setInputFiles(file.path);
    await dispatch(page, "adopt", { role });
  }
  await dispatch(page, "start", { operation: "fit", parameters });
  await expect.poll(async () => (await dispatch(page, "snapshot")).state, { timeout: 5 * 60_000, intervals: [1_000] }).not.toBe("running");
  const snapshot = await dispatch(page, "snapshot");
  expect(snapshot.state, JSON.stringify(snapshot.error)).toBe("succeeded");
  return snapshot.report;
}

/** Fits one case in fresh tabs until every artifact is downloaded; returns its report and files. */
async function runCase(context, roles, parameters) {
  const outputs = {};
  let report;
  let seconds;
  do {
    const tab = await context.newPage();
    const started = performance.now();
    report = await fitInApp(tab, roles, parameters);
    seconds ??= Math.round((performance.now() - started) / 1000);
    const pending = Object.keys(report.artifacts).filter((role) => !outputs[role]);
    for (const role of pending.slice(0, DOWNLOADS_PER_PAGE)) {
      const downloading = tab.waitForEvent("download");
      await dispatch(tab, "download", { artifactId: role });
      const download = await downloading;
      outputs[role] = summarize(download.suggestedFilename(), await readFile(await download.path()));
    }
    await tab.close();
  } while (Object.keys(outputs).length < Object.keys(report.artifacts).length);
  return { report, outputs, seconds };
}

test("every reference case in the web app matches the browser reference", async ({ context, browser }) => {
  test.skip(mode !== "check" && mode !== "write", "set NODDI_BROWSER_REFERENCE=check or write");
  test.setTimeout(20 * 60_000);
  const inputs = await caseInputs();
  const example = inputs.example.files;
  const work = await mkdtemp(join(process.env.TMPDIR || tmpdir(), "noddi-reference-"));
  try {
    // The command line's MindGrab mask of the example's mean b0.
    const cli = await fit({ dwi: example.image.path, bval: example.bval.path, bvec: example.bvec.path, output: join(work, "cli") });
    expect(cli.provenance.mask).toBe(`mindgrab-${MINDGRAB_VERSION}-cpu`);
    const maskPath = join(work, "cli", maskName(bidsStem(example.image.name)));
    const mask = summarize(maskName(bidsStem(example.image.name)), await readFile(maskPath));
    const cases = {};
    let appVersion;
    for (const testCase of CASES) {
      const { files, everyVoxel } = inputs[testCase.input];
      const maskFile = testCase.mask === "mindgrab" ? { path: maskPath } : everyVoxel;
      const roles = [["image", files.image], ["bval", files.bval], ["bvec", files.bvec], ["mask", maskFile]];
      const { report, outputs, seconds } = await runCase(context, roles, testCase.parameters);
      expect(report.provenance.mask).toBe("supplied");
      appVersion = report.appVersion;
      cases[testCase.id] = { parameters: testCase.parameters, provenance: report.provenance, seconds, outputs };
    }
    if (mode === "write") {
      await writeReference({
        inputs: inputChecksums(inputs),
        mask: { path: "noddi command line: MindGrab CPU modules on the mean b0", provenance: { model: "mindgrab", version: MINDGRAB_VERSION, backend: "cpu" }, ...mask },
        browser: {
          path: "apps/noddi/e2e/reference.spec.js: the app's fit automation with the mask input, fitting workers, built assets",
          app: `noddi ${appVersion}`,
          browser: `Chromium ${browser.version()}`,
          cases,
        },
      });
      return;
    }
    const reference = await readReference();
    expect(reference.inputs).toEqual(inputChecksums(inputs));
    expect(mask.decompressedSha256, "the command line's MindGrab mask is the recorded one").toBe(reference.mask.decompressedSha256);
    const failures = [];
    for (const testCase of CASES) {
      const [is, was] = [cases[testCase.id], reference.browser.cases[testCase.id]];
      expect(sharedProvenance(is.provenance), testCase.id).toEqual(sharedProvenance(was.provenance));
      for (const [passed, line] of compareOutputs(`web app ${testCase.id}`, is.outputs, was.outputs)) {
        if (!passed) failures.push(line);
      }
    }
    expect(failures).toEqual([]);
  } finally {
    await rm(work, { recursive: true, force: true });
  }
});
