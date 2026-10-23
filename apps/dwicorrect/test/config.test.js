// DOM-independent unit test (Node, no browser). Browser behaviour is covered by the
// Playwright test in e2e/ — Node tests must not import modules that touch `document`.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { APP } from "../src/config.js";

test("app id is lowercase kebab-case", () => {
  assert.match(APP.id, /^[a-z][a-z0-9-]*$/);
});

test("app config is frozen", () => {
  assert.ok(Object.isFrozen(APP));
});

test("the embedded version is the package's", () => {
  // The sidecars' GeneratedBy.Version comes from APP.version.
  const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
  assert.equal(APP.version, pkg.version);
});

test("automation declares every artifact role the run returns", () => {
  const main = readFileSync(new URL("../src/main.js", import.meta.url), "utf8");
  const automation = JSON.parse(readFileSync(new URL("../automation.json", import.meta.url), "utf8"));
  const declared = Object.keys(automation.operations.correct.artifacts).sort();
  const block = main.slice(main.indexOf("const rows = {"), main.indexOf("const summary = motionSummary"));
  const returned = [...block.matchAll(/(\w+): \{ description:/g)].map((match) => match[1]).sort();
  assert.ok(returned.includes("fieldSidecar"), returned.join(", "));
  assert.deepEqual(returned, declared);
});
