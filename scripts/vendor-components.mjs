#!/usr/bin/env node
// Shared vendor step for every native-ESM app. Copies the shared
// @neurodesk/webapp-components source into the calling app's web/vendor/ so the
// static, no-bundler app can resolve the workspace package via its index.html import map.
// The workspace package stays the single source of truth; web/vendor is generated
// (git-ignored) and refreshed on predev/prebuild.
//
// Run via each app's `vendor` script: `node ../../scripts/vendor-components.mjs`
// pnpm runs lifecycle scripts with cwd set to the selected app package.
import { cp, rm, access } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const appDir = process.cwd();
const src = join(repoRoot, "packages", "components", "src");
const dest = join(appDir, "web", "vendor", "webapp-components", "src");

try {
  await access(src);
} catch {
  console.error(`Cannot find shared components at ${src} — is this running inside the monorepo?`);
  process.exit(1);
}

await rm(join(appDir, "web", "vendor"), { recursive: true, force: true });
await cp(src, dest, { recursive: true });
console.log(`Vendored @neurodesk/webapp-components -> ${dest.replace(repoRoot + "/", "")}`);
