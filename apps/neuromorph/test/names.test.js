import { test } from "node:test";
import assert from "node:assert/strict";
import { repairedName } from "../src/names.js";

test("repaired download names join folders, number repeats and stay unique", () => {
  const taken = new Set();
  assert.equal(repairedName("cells/a/cell.swc", taken), "cells_a_cell_repaired.swc");
  assert.equal(repairedName("cell.swc (2)", taken), "cell_2_repaired.swc");
  assert.equal(repairedName("x (3).swc", taken), "x (3)_repaired.swc");
  assert.equal(repairedName("cell_2.swc", taken), "cell_2_2_repaired.swc");
});

test("a path with a line break still gets a name", () => {
  assert.equal(repairedName("cells\nset/cell.swc (2)", new Set()), "cells\nset_cell_2_repaired.swc");
});
