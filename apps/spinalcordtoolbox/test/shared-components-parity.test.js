// Parity tests for the shared components extracted into this app. Each asserts the library
// component reproduces this app's ARCHIVED original behaviour (test/fixtures/).
import { test } from "node:test";
import assert from "node:assert/strict";
import { progressWidths, modalTrace, renderConsole, captureDownload } from "../../../test-utils/ui-parity.mjs";
import { ProgressManager as SharedProgress } from "../../../packages/components/src/ui/ProgressManager.js";
import { ModalManager as SharedModal } from "../../../packages/components/src/ui/ModalManager.js";
import { ConsoleOutput as SharedConsole } from "../../../packages/components/src/ui/ConsoleOutput.js";
import { downloadFile, downloadBlob } from "../../../packages/components/src/file-io/index.js";
import { ProgressManager as OrigProgress } from "./fixtures/ProgressManager.original.js";
import { ModalManager as OrigModal } from "./fixtures/ModalManager.original.js";
import { ConsoleOutput as OrigConsole } from "./fixtures/ConsoleOutput.original.js";

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

test("ConsoleOutput parity (themed to this app's console-* DOM)", () => {
  const messages = ["Loading volume", "Running inference", "Done"];
  const original = renderConsole((el) => new OrigConsole("consoleOutput"), messages);
  const shared = renderConsole(
    (el) =>
      new SharedConsole({
        element: el,
        lineClass: "console-line",
        timeClass: "console-time",
        messageClass: "console-message",
        separator: " ",
        levelOn: "message",
        levelClass: () => "",
        mirror: () => {},
      }),
    messages
  );
  assert.equal(shared, original);
});

test("downloadFile / downloadBlob side effects", () => {
  const r1 = captureDownload((win) => downloadFile(new win.File(["x"], "sct.nii.gz")));
  assert.equal(r1.clicks.length, 1);
  assert.equal(r1.clicks[0].download, "sct.nii.gz");
  assert.equal(r1.created.length, 1);
  assert.equal(r1.revoked.length, 1);
  assert.equal(r1.leftoverAnchors, 0);

  const r2 = captureDownload((win) => downloadBlob(new win.Blob(["a"], { type: "text/plain" }), "out.txt"));
  assert.equal(r2.clicks[0].download, "out.txt");
});
