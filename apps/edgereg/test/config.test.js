// DOM-independent unit test (Node, no browser). Browser behaviour is covered by the
// Playwright test in e2e/ — Node tests must not import modules that touch `document`.
import { test } from "node:test";
import assert from "node:assert/strict";
import { APP, MOVING_EXAMPLES, STATIONARY_EXAMPLES } from "../src/config.js";
import viteConfigPromise from "../vite.config.js";

test("app id is lowercase kebab-case", () => {
  assert.match(APP.id, /^[a-z][a-z0-9-]*$/);
});

test("app config is frozen", () => {
  assert.ok(Object.isFrozen(APP));
});

test("examples use the shared registration dataset layout", () => {
  assert.equal(MOVING_EXAMPLES.length, 13);
  assert.equal(STATIONARY_EXAMPLES.length, 3);
  assert.ok(MOVING_EXAMPLES.every(({ url }) => url.includes("/reg/moving/")));
  assert.ok(STATIONARY_EXAMPLES.every(({ url }) => url.includes("/reg/templates/")));
  assert.ok([...MOVING_EXAMPLES, ...STATIONARY_EXAMPLES].every(({ url }) => /\/resolve\/[0-9a-f]{40}\/reg\//.test(url)));
});

test("Vite leaves niimath unbundled so its development worker URL exists", async () => {
  const viteConfig = await viteConfigPromise;
  assert.ok(viteConfig.optimizeDeps.exclude.includes("@niivue/niimath"));
});
