import test from "node:test";
import assert from "node:assert/strict";
import { replaceViewerVolumes } from "../src/viewer-volumes.js";

for (const fail of [false, true]) {
  test(`MRI import restores prior files and crosshair on ${fail ? "failure" : "cancellation"}`, async () => {
    const previous = [{ url: new File(["old"], "old.nii") }, { url: new File(["overlay"], "overlay.nii") }];
    const next = [{ url: new File(["new"], "new.nii") }];
    const controller = new AbortController();
    const viewer = {
      crosshairPos: [0.2, 0.3, 0.4],
      async loadVolumes(files) {
        this.files = files;
        this.crosshairPos = [0.5, 0.5, 0.5];
        if (files === next) {
          await Promise.resolve();
          if (fail) throw new Error("Viewer load failed");
          controller.abort();
        }
      },
    };
    await assert.rejects(replaceViewerVolumes(viewer, previous, next, controller.signal), fail ? /Viewer load failed/ : { name: "AbortError" });
    assert.equal(viewer.files, previous);
    assert.deepEqual(viewer.crosshairPos, [0.2, 0.3, 0.4]);
  });
}

test("a successful MRI import keeps the replacement", async () => {
  const next = [{ url: new File(["new"], "new.nii") }];
  const viewer = { crosshairPos: [0, 0, 0], async loadVolumes(files) { this.files = files; } };
  await replaceViewerVolumes(viewer, [], next);
  assert.equal(viewer.files, next);
});
