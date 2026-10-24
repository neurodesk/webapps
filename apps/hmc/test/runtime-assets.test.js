import assert from "node:assert/strict";
import test from "node:test";
import { loadAppsRegistry } from "../../../scripts/lib/apps-registry.mjs";

test("HMC declares the pinned MindGrab runtime kept within its service-worker scope", async () => {
  const { apps } = await loadAppsRegistry();
  assert.deepEqual(apps.find(app => app.id === "hmc").app_scoped_runtime_families, ["mindgrab-20260925"]);
});
