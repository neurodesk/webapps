#!/usr/bin/env node
// Shared vendor step for every native-ESM app. Copies the shared
// @neurodesk/webapp-components source into the calling app's web/vendor/ so the
// static, no-bundler app can resolve the workspace package via its index.html import map.
// The workspace package stays the single source of truth; web/vendor is generated
// (git-ignored) and refreshed on predev/prebuild.
//
// Run via each app's `vendor` script: `node ../../scripts/vendor-components.mjs`
// pnpm runs lifecycle scripts with cwd set to the selected app package.
// Apps whose static root is not `web/` (e.g. qsmbly serves from the app root)
// pass `--dest <dir>` to vendor into `<dir>/vendor/` instead.
import { cp, rm, access } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const appDir = process.cwd();
const args = process.argv.slice(2);
const destIndex = args.indexOf("--dest");
const destRoot = destIndex !== -1 && args[destIndex + 1] ? args[destIndex + 1] : "web";
const src = join(repoRoot, "packages", "components", "src");
const dest = join(appDir, destRoot, "vendor", "webapp-components", "src");

try {
  await access(src);
} catch {
  console.error(`Cannot find shared components at ${src} — is this running inside the monorepo?`);
  process.exit(1);
}

await rm(join(appDir, destRoot, "vendor"), { recursive: true, force: true });
await cp(src, dest, { recursive: true });
if (destRoot !== '.') await cp(join(appDir, 'examples.json'), join(appDir, destRoot, 'examples.json'));
console.log(`Vendored @neurodesk/webapp-components -> ${dest.replace(repoRoot + "/", "")}`);
