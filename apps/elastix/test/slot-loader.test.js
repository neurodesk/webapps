import assert from "node:assert/strict";
import { test } from "node:test";
import { loadSlotSource } from "../src/slot-loader.js";

const source = (name) => ({ displayFile: { name } });

function viewer(previous, onLoad = async () => {}) {
  return {
    image: previous?.displayFile.name ?? null,
    async loadVolumes(volumes) {
      this.image = volumes[0].name;
      await onLoad(volumes[0].name);
    },
    async removeAllVolumes() { this.image = null; },
  };
}

test("cancelling replacement during display loading restores the selected image", async () => {
  const previous = source("chosen.nii.gz");
  const replacement = source("replacement.nii.gz");
  const controller = new AbortController();
  const display = viewer(previous, async (name) => {
    if (name === "replacement.nii.gz") controller.abort();
  });
  await assert.rejects(loadSlotSource({ viewer: display, source: replacement, previous, signal: controller.signal }), { name: "AbortError" });
  assert.equal(display.image, "chosen.nii.gz");
  assert.equal((await loadSlotSource({ viewer: display, source: replacement, previous })).displayFile.name, "replacement.nii.gz");
  assert.equal(display.image, "replacement.nii.gz");
});

test("an already cancelled replacement leaves the selected image alone", async () => {
  const previous = source("chosen.nii.gz");
  const controller = new AbortController();
  controller.abort();
  const display = viewer(previous);
  await assert.rejects(loadSlotSource({ viewer: display, source: source("replacement.nii.gz"), previous, signal: controller.signal }), { name: "AbortError" });
  assert.equal(display.image, "chosen.nii.gz");
});

test("failed replacement restores the selected image and permits a retry", async () => {
  const previous = source("chosen.nii.gz");
  let fail = true;
  const display = viewer(previous, async (name) => {
    if (name === "replacement.nii.gz" && fail) throw new Error("Display load failed");
  });
  const replacement = source("replacement.nii.gz");
  await assert.rejects(loadSlotSource({ viewer: display, source: replacement, previous }), /Display load failed/);
  assert.equal(display.image, "chosen.nii.gz");
  fail = false;
  assert.equal((await loadSlotSource({ viewer: display, source: replacement, previous })).displayFile.name, "replacement.nii.gz");
  assert.equal(display.image, "replacement.nii.gz");
});

test("a cancelled first load removes its image and the next load succeeds", async () => {
  const controller = new AbortController();
  const display = viewer(null, async () => controller.abort());
  await assert.rejects(loadSlotSource({ viewer: display, source: source("cancelled.nii.gz"), signal: controller.signal }), { name: "AbortError" });
  assert.equal(display.image, null);
  assert.equal((await loadSlotSource({ viewer: display, source: source("retry.nii.gz") })).displayFile.name, "retry.nii.gz");
  assert.equal(display.image, "retry.nii.gz");
});
