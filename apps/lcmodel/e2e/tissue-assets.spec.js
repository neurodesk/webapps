import { test, expect } from "@playwright/test";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { cp, mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { serveSite } from "../../../test-utils/serve-site.mjs";
import { isUrlWithinServiceWorkerScope } from "../../../scripts/lib/runtime-support.mjs";

const require = createRequire(import.meta.url);
const packageDir = dirname(require.resolve("@brainchop/mindgrab/package.json"));
const { version } = JSON.parse(await readFile(join(packageDir, "package.json"), "utf8"));
const sha256 = bytes => createHash("sha256").update(bytes).digest("hex");

test("MindMap loads its unchanged CPU runtime inside the app scope without host headers or bundled fallback models", async ({ page }) => {
  test.setTimeout(60_000);
  const assets = await readdir(new URL("../dist/assets/", import.meta.url));
  expect(assets.filter(name => /^brainchop-.*\.wasm$/.test(name))).toEqual([]);
  const runtimePath = `brainchop/${version}/`;
  for (const name of ["worker.js", ...["", "-gl", "-gpu"].flatMap(backend => ["js", "wasm"].map(ext => `brainchop-mindmap${backend}.${ext}`))]) {
    const staged = await readFile(new URL(`../dist/${runtimePath}${name}`, import.meta.url));
    expect(sha256(staged)).toBe(sha256(await readFile(join(packageDir, "dist", name))));
  }
  const scratch = await mkdtemp(join(tmpdir(), "lcmodel-runtime-"));
  let site;
  try {
    await cp(new URL("../dist/", import.meta.url), join(scratch, "lcmodel"), { recursive: true });
    site = await serveSite(scratch, { isolationHeaders: false });
    const requests = [];
    page.on("request", request => {
      if (request.url().includes("/brainchop/")) requests.push(request.url());
    });
    await page.goto(`${site.origin}/lcmodel/`, { waitUntil: "domcontentloaded" });
    await page.waitForFunction(() => crossOriginIsolated && navigator.serviceWorker.controller !== null);
    const runtimeUrl = new URL(`${runtimePath}brainchop-mindmap.js`, page.url()).href;
    const loaded = await page.evaluate(async url => {
      // Initialise the actual threaded module without running segmentation.
      const source = `
        import factory from ${JSON.stringify(url)};
        try {
          const module = await factory({ noInitialRun: true });
          self.postMessage({ isolated: self.crossOriginIsolated, callable: typeof module.callMain === "function" });
        } catch (error) {
          self.postMessage({ error: String(error) });
        }
      `;
      const blob = URL.createObjectURL(new Blob([source], { type: "text/javascript" }));
      const worker = new Worker(blob, { type: "module" });
      try {
        return await new Promise((resolve, reject) => {
          worker.onmessage = event => resolve(event.data);
          worker.onerror = event => reject(new Error(event.message));
        });
      } finally {
        worker.terminate();
        URL.revokeObjectURL(blob);
      }
    }, runtimeUrl);
    expect(loaded).toEqual({ isolated: true, callable: true });
    expect(requests.some(url => url.endsWith("brainchop-mindmap.wasm"))).toBe(true);
    for (const url of requests) {
      expect(isUrlWithinServiceWorkerScope(`${site.origin}/lcmodel/coi-serviceworker.js`, url)).toBe(true);
    }
  } finally {
    await site?.close();
    await rm(scratch, { recursive: true, force: true });
  }
});
