#!/usr/bin/env node
// scripts/new-app.mjs
// Scaffold a SELF-CONTAINED app into apps/<name> from templates/app-template and
// register it in registry/apps.yml (the deploy/statistics source of truth).
//
//   pnpm new-app <name>
//
// The template imports @neurodesk/webapp-components/* and @neurodesk/analytics by
// package name (not ../../src), ships its own package.json/vite/eslint/wrangler config,
// a DOM-independent Node test, and a Playwright browser test. Missing template files
// abort loudly instead of being silently skipped.
import { cp, readFile, writeFile, access, readdir, appendFile } from "node:fs/promises";
import { join } from "node:path";

const name = process.argv[2];
if (!name || !/^[a-z][a-z0-9-]*$/.test(name)) {
  console.error("Usage: pnpm new-app <name>   (lowercase kebab-case, e.g. cerebellum)");
  process.exit(1);
}

const root = process.cwd();
const dest = join(root, "apps", name);
const src = join(root, "templates", "app-template");
const registry = join(root, "registry", "apps.yml");

// Destination must be free.
try {
  await access(dest);
  console.error(`apps/${name} already exists — pick another name.`);
  process.exit(1);
} catch {
  /* free */
}

// Required template files must exist — fail loudly, do not silently skip.
const REQUIRED = [
  "package.json",
  "vite.config.js",
  "eslint.config.js",
  "playwright.config.js",
  "index.html",
  "public/_headers",
  "src/main.js",
  "src/config.js",
  "test/config.test.js",
  "e2e/smoke.spec.js",
];
for (const f of REQUIRED) {
  try {
    await access(join(src, f));
  } catch {
    console.error(`Template is missing required file: ${f} — aborting.`);
    process.exit(1);
  }
}

await cp(src, dest, { recursive: true });

// Stamp APP_NAME into every text file that contains it.
async function stamp(dir) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name);
    if (entry.isDirectory()) {
      await stamp(p);
    } else {
      const text = await readFile(p, "utf8");
      if (text.includes("APP_NAME")) await writeFile(p, text.replaceAll("APP_NAME", name));
    }
  }
}
await stamp(dest);

// Register the app so deploy + statistics workflows pick it up.
const entry =
  `  - id: ${name}\n` +
  `    path: ${name}\n` +
  `    title: ${name}\n` +
  `    description: TODO describe ${name}.\n` +
  `    legacy_domain: null\n` +
  `    runtime: react-vite\n` +
  `    model_manifest: null\n` +
  `    asset_manifest_schema: null\n` +
  `    source: neurodesk/webapps@local\n` +
  `    license: NOASSERTION\n` +
  `    maintainers: [neurodesk]\n` +
  `    support_status: experimental\n` +
  `    shell: imaging-workspace\n` +
  `    ci:\n` +
  `      toolchains: [node]\n` +
  `      shared_runtime: true\n` +
  `      release: false\n`;
await appendFile(registry, entry);

console.log(`Created apps/${name} and registered it in registry/apps.yml. Next:`);
console.log(`  pnpm install`);
console.log(`  pnpm --filter ${name} dev`);
console.log(`CI installs, builds, runs tests, and publishes it at /${name}/ in the composite site.`);
