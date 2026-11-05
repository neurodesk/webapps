// DOM-independent unit test (Node, no browser). Browser behaviour is covered by the
// Playwright test in e2e/ — Node tests must not import modules that touch `document`.
import { test } from "node:test";
import assert from "node:assert/strict";
import { APP, DEFAULT_VALUES, SettingsError, guessGrid, readSettings } from "../src/config.js";

test("app id is lowercase kebab-case and the config is frozen", () => {
  assert.match(APP.id, /^[a-z][a-z0-9-]*$/);
  assert.ok(Object.isFrozen(APP));
});

test("form strings become typed settings with the overlap as a fraction", () => {
  const settings = readSettings({ ...DEFAULT_VALUES, columns: "4", rows: "4", overlap: "18", gridType: "snake-row" });
  assert.deepEqual(settings.grid, { columns: 4, rows: 4, overlap: 0.18, type: "snake-row", start: "top-left" });
  assert.deepEqual(settings.global, { threshold: 0.3, maxRatio: 2.5, maxAbsolute: 3.5 });
  assert.equal(settings.pairwise.peaks, 5);
});

test("grid fields are ignored for a file layout, and bad values name their field", () => {
  assert.equal(readSettings({ ...DEFAULT_VALUES, layout: "file", columns: "" }).grid, undefined);
  for (const [field, value, message] of [["columns", "2.5", /whole number/], ["overlap", "99", /between 0 and 95/], ["threshold", "x", /number/], ["layout", "spiral", /Layout must be/]]) {
    assert.throws(() => readSettings({ ...DEFAULT_VALUES, [field]: value }), (error) => error instanceof SettingsError && error.field === field && message.test(error.message));
  }
});

test("the grid guess is the most square factorisation of the tile count", () => {
  assert.deepEqual(guessGrid(16), { columns: 4, rows: 4 });
  assert.deepEqual(guessGrid(6), { columns: 3, rows: 2 });
  assert.deepEqual(guessGrid(2), { columns: 2, rows: 1 });
});
