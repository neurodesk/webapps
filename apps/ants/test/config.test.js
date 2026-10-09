// DOM-independent unit test (Node, no browser). Browser behaviour is covered by the
// Playwright test in e2e/ — Node tests must not import modules that touch `document`.
import { test } from "node:test";
import assert from "node:assert/strict";
import { MOVING_EXAMPLES, STATIONARY_EXAMPLES } from "../src/config.js";

test("the brain-only defaults use the shared registration dataset", () => {
  assert.deepEqual(MOVING_EXAMPLES.map(({ filename }) => filename), ["t1_brain.nii.gz"]);
  assert.deepEqual(STATIONARY_EXAMPLES.map(({ filename }) => filename), ["MNI152_T1_1mm_brain.nii.gz"]);
  assert.ok([...MOVING_EXAMPLES, ...STATIONARY_EXAMPLES].every(({ brainExtracted }) => brainExtracted));
  assert.ok(MOVING_EXAMPLES[0].url.includes("/reg/moving/"));
  assert.ok(STATIONARY_EXAMPLES[0].url.includes("/reg/templates/"));
  assert.ok([...MOVING_EXAMPLES, ...STATIONARY_EXAMPLES].every(({ url }) => /\/resolve\/[0-9a-f]{40}\/reg\//.test(url)));
});
