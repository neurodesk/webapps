import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { loadAppsRegistry } from "../scripts/lib/apps-registry.mjs";
import { renderLandingPage } from "../scripts/lib/landing-page.mjs";
test("homepage game is not an app or a standalone release", async () => {
  const registry = await loadAppsRegistry();
  assert.ok(!registry.apps.some((app) => app.id.includes("vessel-surfer")));
  const html = renderLandingPage(registry);
  assert.match(html, /id="under-the-surface"/);
  assert.doesNotMatch(html, /Vessel Surfer|_play\/vessel|<iframe/);
  const pkg = JSON.parse(
    await readFile(
      new URL(
        "../site/easter-eggs/vessel-surfer/package.json",
        import.meta.url,
      ),
    ),
  );
  assert.equal(pkg.private, true);
  assert.equal(pkg.name, "@neurodesk/vessel-surfer-easter-egg");
});
