import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { loadAppsRegistry } from "../scripts/lib/apps-registry.mjs";
import { renderLandingPage } from "../scripts/lib/landing-page.mjs";
test("the homepage links to the game, which is not an app or a standalone release", async () => {
  const registry = await loadAppsRegistry();
  assert.ok(!registry.apps.some((app) => app.id.includes("vessel-surfer")));
  const html = renderLandingPage(registry);
  assert.match(
    html,
    /<a href="https:\/\/neurodesk\.org\/">About Neurodesk<\/a>\s*<a href="\.\/surf\/">Go surfing<\/a>/,
  );
  assert.doesNotMatch(html, /<iframe|under-the-surface/);
  for (const [directory, name] of [
    ["vessel-surfer", "@neurodesk/vessel-surfer-easter-egg"],
    ["vessel-surfer-leaderboard", "@neurodesk/vessel-surfer-leaderboard"],
  ]) {
    const pkg = JSON.parse(
      await readFile(
        new URL(`../site/easter-eggs/${directory}/package.json`, import.meta.url),
      ),
    );
    assert.equal(pkg.private, true);
    assert.equal(pkg.name, name);
  }
});
