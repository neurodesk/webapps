import { test } from "node:test";
import assert from "node:assert/strict";
import { registerAppAutomation } from "@neurodesk/webapp-components/automation";
import automation from "../automation.json" with { type: "json" };
import { APP, outputNames, runSettings, SECTION_OUTPUT_KINDS } from "../src/config.js";

// The shared adapter on a minimal page: a document with the transfer input and nothing else.
function register(operation) {
  const transfer = { dataset: {}, files: [] };
  const document = { baseURI: "https://example.test/histo2mri/", getElementById: () => null, createElement: () => transfer, body: { append() {} } };
  const { dispatch } = registerAppAutomation({ app: APP.id, contract: { ...automation, appVersion: APP.version }, operations: { register: operation }, document, target: {} });
  return {
    dispatch,
    async adopt(role, files) {
      transfer.files = files;
      await dispatch("adopt", { role });
    },
  };
}

async function settled(dispatch) {
  for (let attempt = 0; attempt < 200; attempt++) {
    const snapshot = await dispatch("snapshot");
    if (["succeeded", "failed", "cancelled"].includes(snapshot.state)) return snapshot;
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
  throw new Error("The run did not settle");
}

// What a run returns (main.js): each section's files, the warp only when it is kept, and the
// sections in the MRI grid only when runSettings allows that copy.
function artifacts(settings, { warp }) {
  const names = outputNames("s1.tif");
  const kinds = SECTION_OUTPUT_KINDS.filter((kind) => warp || kind !== "warp");
  const files = kinds.map((kind) => ({ role: kind, file: new File([kind], names[kind]) }));
  if (settings.volumeOutput) files.push({ role: "volume", file: new File(["volume"], "sections_in_mri.nii.gz") });
  return files;
}

for (const [label, maxVolumeBytes, warp] of [["with", Infinity, true], ["without", 1, false]]) {
  test(`an automated run ${label} the MRI-grid output meets the contract`, async () => {
    const settings = runSettings({ axis: 2, index: 2 }, [40, 36, 5], 1, { maxVolumeBytes });
    assert.equal(settings.volumeOutput, maxVolumeBytes === Infinity);
    const page = register(async () => ({ artifacts: artifacts(settings, { warp }) }));
    await page.adopt("mri", [new File(["mri"], "mri.nii.gz")]);
    await page.adopt("sections", [new File(["section"], "s1.tif")]);
    await page.dispatch("start", { parameters: { index: 2 } });
    const snapshot = await settled(page.dispatch);
    assert.equal(snapshot.state, "succeeded", snapshot.error?.message);
    assert.equal(Object.hasOwn(snapshot.report.artifacts, "volume"), settings.volumeOutput);
  });
}
