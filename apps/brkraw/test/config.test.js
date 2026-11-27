import test from "node:test";
import assert from "node:assert/strict";
import {
  APP,
  defaultRecoOf,
  normalizeSpace,
  normalizeSubjectPose,
  normalizeSubjectType,
  outputStem,
  parseRecoKey,
  recoKey,
  scanMetaSummary,
  scanOptionLabel,
} from "../src/config.js";

test("BrkRaw app metadata, normalizers, and privacy-safe naming helpers", () => {
  assert.equal(APP.id, "brkraw");
  assert.equal(APP.title, "BrkRaw");
  assert.equal(normalizeSpace("scanner"), "scanner");
  assert.equal(normalizeSpace("invalid"), "subject_ras");
  assert.equal(normalizeSubjectType("Quadruped"), "Quadruped");
  assert.equal(normalizeSubjectType("auto"), "");
  assert.equal(normalizeSubjectPose("Head_Prone"), "Head_Prone");
  assert.equal(normalizeSubjectPose("unknown"), "");

  assert.equal(recoKey(6, 1), "6:1");
  assert.deepEqual(parseRecoKey("6:1"), { scanId: 6, recoId: 1 });
  assert.equal(parseRecoKey("bad"), null);

  assert.equal(
    outputStem({ scanId: 6, recoId: 1, slicePackIndex: 0, slicePackCount: 1 }),
    "scan6_reco1",
  );
  assert.equal(
    outputStem({ scanId: 3, recoId: 1, slicePackIndex: 2, slicePackCount: 3 }),
    "scan3_reco1_pack2",
  );
});

test("defaultRecoOf prefers multi-slice anatomical scan and labels over-cap scans clearly", () => {
  const summary = {
    scans: [
      {
        scanId: 3,
        recos: [{
          scanId: 3, recoId: 1, protocol: "1_Localizer_GOP", methodName: "Bruker:FLASH",
          dim: 2, shape: [256, 256, 3], numSlicePacks: 3, numSlices: [1, 1, 1],
          zooms: [0.1172, 0.1172, 4], convertible: true,
        }],
      },
      {
        scanId: 6,
        recos: [{
          scanId: 6, recoId: 1, protocol: "CAMRI_T2_RARE_2D_ax", methodName: "Bruker:RARE",
          dim: 2, shape: [384, 384, 12], numSlicePacks: 1, numSlices: [12],
          zooms: [0.075, 0.075, 1], trMs: 3000, teMs: 48, convertible: true,
        }],
      },
      {
        scanId: 12,
        recos: [{
          scanId: 12, recoId: 1, protocol: "Huge_4D", methodName: "Bruker:EPI",
          dim: 2, shape: [256, 256, 64, 1000], numSlicePacks: 1, numSlices: [64],
          zooms: [0.2, 0.2, 0.5], convertible: false, exceedsLimit: true,
        }],
      },
    ],
  };
  const chosen = defaultRecoOf(summary);
  assert.equal(chosen.scanId, 6);
  assert.match(scanOptionLabel(chosen), /Scan 6 · Reco 1 — CAMRI_T2_RARE_2D_ax/);
  assert.match(scanMetaSummary(chosen), /384 × 384 × 12/);
  assert.match(scanOptionLabel(summary.scans[2].recos[0]), /\[exceeds 1 GiB limit\]$/);
});
