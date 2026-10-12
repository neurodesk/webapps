// The messages a site reads when something does not work: LCModel's
// diagnostic codes in words, and what loading found for each dataset.
import { test } from "node:test";
import assert from "node:assert/strict";
import { explainDiagnostic } from "../src/lcmodel-io.js";
import { loadMessages } from "../src/pipeline.js";

test("MYBASI 10 names both echo times", () => {
  const text = explainDiagnostic("1     ERROR MYBASI 10", { dataTeMs: 40, basisTeMs: 35 });
  assert.match(text, /^1     ERROR MYBASI 10: /);
  assert.match(text, /basis set's echo time \(35 ms\) differs from the data's \(40 ms\) by 3 ms or more/);
});

test("information lines are marked harmless and others point to the manual", () => {
  assert.match(explainDiagnostic("1      info RFALSI 12"), /information; the fit is unaffected/);
  assert.match(explainDiagnostic("2     ERROR SETUP 7"), /section 12, for SETUP 7/);
  assert.equal(explainDiagnostic("not a diagnostic"), "not a diagnostic");
});

test("a skipped series is reported once, and every dataset states its TE and voxel", () => {
  const reason = "DICOM without Siemens spectroscopy data; series 21 \"PRESS\", modality MR";
  const lines = loadMessages({
    errors: [],
    ignored: Array.from({ length: 60 }, (_, k) => ({ file: `sub/21-PRESS/${k}.dcm`, reason })),
    unpairedWater: [],
    datasets: [
      { name: "P1", header: { sequence: "PROBE-P", fieldT: 3, teMs: 30, trMs: 2000, voxel: { sizeMm: [20, 20, 20], centerMm: [-28.718, 77.741, 67.582], source: "GE P-file user8-13, tlhc, trhc, brhc" } } },
      { name: "P2", header: { teMs: 30, voxelNote: "GE P-file revision 24: these image header values do not make a voxel box" } },
      { name: "R", header: { sequence: " *svs_se\r\n", teMs: 30 } },
    ],
  });
  assert.deepEqual(lines[0], { text: `sub/21-PRESS/ (60 files): ${reason}`, level: "info" });
  assert.equal(lines[1].text, "P1: sequence PROBE-P, 3.00 T, TE 30 ms, TR 2000 ms; voxel 20 × 20 × 20 mm at -28.7, 77.7, 67.6 mm (RAS), from GE P-file user8-13, tlhc, trhc, brhc");
  assert.deepEqual(lines[2], { text: "P2: TE 30 ms; no voxel: GE P-file revision 24: these image header values do not make a voxel box", level: "warning" });
  assert.equal(lines[3].text, "R: sequence *svs_se, TE 30 ms; the format does not record the voxel");
});
