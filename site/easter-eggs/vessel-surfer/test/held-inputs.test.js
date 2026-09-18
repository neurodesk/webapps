import { test } from "node:test";
import assert from "node:assert/strict";
import { HeldInputs } from "../src/held-inputs.js";
test("releasing one control source does not cancel another held source", () => {
  const held = new HeldInputs();
  held.press("keyboard:shift", "shift");
  held.press("pointer:1", "shift");
  held.release("pointer:1");
  assert.ok(held.has("shift"));
  held.press("pointer:2", "arrowright");
  held.release("keyboard:shift");
  assert.deepEqual([...held], ["arrowright"]);
  held.clear();
  held.release("pointer:2");
  assert.equal(held.size, 0);
});
