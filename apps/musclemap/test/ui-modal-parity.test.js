// Parity test: the shared ModalManager must reproduce MuscleMap's ORIGINAL behaviour for
// its used surface — `new ModalManager('someId')` (string), open()/close()/toggle()/isOpen(),
// and overlay-click-to-close. The original is archived in test/fixtures/.
import { test } from "node:test";
import assert from "node:assert/strict";
import { ModalManager as Shared } from "../../../packages/components/src/ui/ModalManager.js";
import { ModalManager as Original } from "./fixtures/ModalManager.original.js";

// Minimal element stub: Set-backed classList + a captured click handler we can fire.
function makeEl() {
  const classes = new Set();
  const el = {
    classList: {
      add: (c) => classes.add(c),
      remove: (c) => classes.delete(c),
      contains: (c) => classes.has(c),
    },
    addEventListener: (type, h) => {
      if (type === "click") el._onclick = h;
    },
    _classes: classes,
    _fireOverlayClick() {
      if (this._onclick) this._onclick({ target: this }); // target === element -> should close
    },
  };
  return el;
}

// Run an identical scenario against a ModalManager class; return the observable trace.
function trace(ManagerClass) {
  const el = makeEl();
  const prev = globalThis.document;
  globalThis.document = { getElementById: (id) => (id === "m" ? el : null) };
  try {
    const m = new ManagerClass("m");
    const t = [];
    t.push(m.isOpen());
    m.open();
    t.push(m.isOpen(), el.classList.contains("active"));
    m.close();
    t.push(m.isOpen());
    m.toggle();
    t.push(m.isOpen()); // now open
    el._fireOverlayClick();
    t.push(m.isOpen(), el.classList.contains("active")); // overlay click closed it
    return t;
  } finally {
    globalThis.document = prev;
  }
}

test("shared ModalManager matches the archived original across the used surface", () => {
  const shared = trace(Shared);
  const original = trace(Original);
  assert.deepEqual(shared, original);
  // And spell out the expected sequence so a regression in BOTH would still fail.
  assert.deepEqual(original, [false, true, true, false, true, false, false]);
});
