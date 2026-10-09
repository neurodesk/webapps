import { test } from "node:test";
import assert from "node:assert/strict";
import { APP } from "../src/config.js";

test("app identity", () => {
  assert.equal(APP.id, "lcmodel");
});
