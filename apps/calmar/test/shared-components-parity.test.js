// Parity tests for the shared components extracted into CALMaR. ConsoleOutput is NOT
// extracted here — CALMaR's ConsoleOutput is custom (level-on-line, source spans, escapeHtml,
// options-object log signature) and stays local until the library grows to model it.
import { test } from "node:test";
import assert from "node:assert/strict";
import { progressWidths, modalTrace, captureDownload } from "../../../test-utils/ui-parity.mjs";
import { ProgressManager as SharedProgress } from "../../../packages/components/src/ui/ProgressManager.js";
import { ModalManager as SharedModal } from "../../../packages/components/src/ui/ModalManager.js";
import { downloadFile, downloadBlob } from "../../../packages/components/src/file-io/index.js";
import { ProgressManager as OrigProgress } from "./fixtures/ProgressManager.original.js";
import { ModalManager as OrigModal } from "./fixtures/ModalManager.original.js";

test("ProgressManager parity", () => {
  const shared = progressWidths(SharedProgress);
  assert.deepEqual(shared, progressWidths(OrigProgress));
  assert.deepEqual(shared, ["0%", "25%", "50%", "100%"]);
});

test("ModalManager parity", () => {
  const shared = modalTrace(SharedModal);
  assert.deepEqual(shared, modalTrace(OrigModal));
  assert.deepEqual(shared, [false, true, true, false, true, false]);
});

test("downloadFile / downloadBlob side effects", () => {
  const r1 = captureDownload((win) => downloadFile(new win.File(["x"], "lesion.nii.gz")));
  assert.equal(r1.clicks.length, 1);
  assert.equal(r1.clicks[0].download, "lesion.nii.gz");
  assert.equal(r1.created.length, 1);
  assert.equal(r1.revoked.length, 1);
  assert.equal(r1.leftoverAnchors, 0);

  const r2 = captureDownload((win) => downloadBlob(new win.Blob(["a"], { type: "text/csv" }), "report.csv"));
  assert.equal(r2.clicks[0].download, "report.csv");
});
