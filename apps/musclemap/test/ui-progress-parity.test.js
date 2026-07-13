// Parity test: the shared @neurodesk/webapp-components ProgressManager must reproduce
// MuscleMap's ORIGINAL ProgressManager behaviour for the surface MuscleMap actually uses
// — `new ProgressManager({ animationSpeed })` and `setProgress(value)` with value in [0,1],
// rendering `#progressBar` width as `${value*100}%`. The original is archived verbatim in
// test/fixtures/ so this guards the extraction against drift.
import { test } from "node:test";
import assert from "node:assert/strict";
import { ProgressManager as Shared } from "../../../packages/components/src/ui/ProgressManager.js";
import { ProgressManager as Original } from "./fixtures/ProgressManager.original.js";

// Minimal DOM stub: a #progressBar (and #statusText for the shared version) with a style.
function withStubDom(run) {
  const bar = { style: { width: "" } };
  const status = { textContent: "" };
  const prev = globalThis.document;
  globalThis.document = {
    getElementById: (id) => (id === "progressBar" ? bar : id === "statusText" ? status : null),
  };
  try {
    return run(bar);
  } finally {
    globalThis.document = prev;
  }
}

function widthAfter(PM, value) {
  return withStubDom((bar) => {
    const pm = new PM({ animationSpeed: 0.5 });
    pm.setProgress(value);
    return bar.style.width;
  });
}

for (const value of [0, 0.25, 0.5, 0.999, 1]) {
  test(`setProgress(${value}) renders identical bar width (shared === original)`, () => {
    const shared = widthAfter(Shared, value);
    const original = widthAfter(Original, value);
    assert.equal(shared, original, `width mismatch at ${value}`);
    assert.equal(shared, `${value * 100}%`);
  });
}

test("shared ProgressManager defaults its target to #progressBar (as MuscleMap relies on)", () => {
  withStubDom((bar) => {
    const pm = new Shared({ animationSpeed: 0.5 });
    pm.setProgress(0.42);
    assert.equal(bar.style.width, "42%");
  });
});
