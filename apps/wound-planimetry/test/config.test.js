// DOM-independent unit test (Node, no browser). Browser behaviour is covered by the
// Playwright tests in e2e/ — Node tests must not import modules that touch `document`.
import { test } from "node:test";
import assert from "node:assert/strict";
import { APP, DEFAULTS, SettingsError, readReferenceMm, readSettings } from "../src/config.js";

test("app id is lowercase kebab-case and config is frozen", () => {
  assert.match(APP.id, /^[a-z][a-z0-9-]*$/);
  assert.equal(APP.id, "wound-planimetry");
  assert.equal(APP.title, "Wound Planimetry");
  assert.match(APP.version, /^\d+\.\d+\.\d{8}$/);
  assert.ok(Object.isFrozen(APP));
  assert.ok(Object.isFrozen(DEFAULTS));
});

test("readSettings returns defaults and validates bounds", () => {
  const defaults = readSettings({});
  assert.deepEqual(defaults, {
    pixelsPerMm: 0,
    sensitivity: 0,
    escharL: 28,
    granulationA: 22,
    sloughB: 18,
  });

  const custom = readSettings({
    pixelsPerMm: "12.5",
    sensitivity: "-0.15",
    escharL: "30",
    granulationA: "25",
    sloughB: "20",
  });
  assert.equal(custom.pixelsPerMm, 12.5);
  assert.equal(custom.sensitivity, -0.15);
  assert.equal(custom.escharL, 30);

  assert.throws(() => readSettings({ pixelsPerMm: -1 }), SettingsError);
  assert.throws(() => readSettings({ sensitivity: 0.5 }), SettingsError);
  assert.throws(() => readSettings({ escharL: 90 }), SettingsError);
  assert.throws(() => readReferenceMm(0), SettingsError);
  assert.throws(() => readReferenceMm(""), SettingsError);
  assert.throws(() => readReferenceMm("   "), SettingsError);
  assert.throws(() => readReferenceMm(null), SettingsError);
  assert.throws(() => readReferenceMm(undefined), SettingsError);
  assert.equal(readReferenceMm("15"), 15);
});
