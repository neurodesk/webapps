import { cp, mkdir, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { preview } from "vite";
import { loadAppsRegistry } from "../../../../scripts/lib/apps-registry.mjs";
import { renderLandingPage } from "../../../../scripts/lib/landing-page.mjs";
const root = new URL("../", import.meta.url);
const repository = new URL("../../../../", import.meta.url);
const destination = new URL(".preview/", root);
await mkdir(destination, { recursive: true });
await cp(new URL("dist/", root), new URL("_play/vessel/", destination), {
  recursive: true,
});
await writeFile(
  new URL("index.html", destination),
  renderLandingPage(await loadAppsRegistry()),
);
for (const name of [
  "landing.js",
  "landing.css",
  "easter-egg.js",
  "theme.js",
  "app-theme.css",
  "neurodesk-logo.svg",
  "analytics.json",
])
  await cp(new URL(`site/${name}`, repository), new URL(name, destination));
await cp(
  new URL("packages/analytics/src/index.js", repository),
  new URL("analytics.js", destination),
);
await preview({
  configFile: false,
  root: fileURLToPath(root),
  base: "/",
  build: { outDir: ".preview" },
  preview: {
    host: "127.0.0.1",
    port: 4178,
    strictPort: true,
    headers: {
      "Cross-Origin-Opener-Policy": "same-origin",
      "Cross-Origin-Embedder-Policy": "credentialless",
    },
  },
});
