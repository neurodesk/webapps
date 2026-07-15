#!/usr/bin/env node
// Shared "build" for the not-yet-bundled native-ESM apps: assemble a static,
// deployable dir. The deployable IS web/ with vendored components + downloaded ORT
// wasm (produced by the app's prebuild). Full Vite bundling is a later step and must
// preserve the classic importScripts inference worker.
//
// Run via each app's `build` script: `node ../../scripts/build-static.mjs`.
import { execFileSync } from "node:child_process";
import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { writeCoiServiceWorker } from "./lib/runtime-support.mjs";

// pnpm preserves the outer shell's INIT_CWD for `pnpm --filter app build`,
// while the lifecycle process cwd is always the package being built.
const appDir = process.cwd();
const dist = join(appDir, "dist");
const manifest = JSON.parse(await readFile(join(appDir, "package.json"), "utf8"));
const config = { source: "web", ...(manifest.neurodeskWebapp?.static ?? {}) };
const forbiddenScientificAsset = /\.(?:onnx|pt|pth|safetensors|nii(?:\.gz)?|mgh|mgz)$/i;
const copyOptions = {
  recursive: true,
  filter: (source) => !forbiddenScientificAsset.test(basename(source)),
};

await rm(dist, { recursive: true, force: true });
if (config.include) {
  await mkdir(dist, { recursive: true });
  await Promise.all(config.include.map((path) => cp(join(appDir, path), join(dist, path), copyOptions)));
} else {
  await cp(join(appDir, config.source), dist, copyOptions);
}

if (config.buildInfo) {
  const git = (...args) => {
    try {
      return execFileSync('git', args, { cwd: appDir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    } catch {
      return '';
    }
  };
  const sha = (process.env.GITHUB_SHA || process.env.CF_PAGES_COMMIT_SHA || git('rev-parse', 'HEAD')).slice(0, 7);
  const branch = process.env.GITHUB_REF_NAME || process.env.CF_PAGES_BRANCH || git('rev-parse', '--abbrev-ref', 'HEAD') || 'detached';
  const dirty = !process.env.CI && git('status', '--porcelain').length > 0;
  await writeFile(join(dist, 'build-info.json'), `${JSON.stringify({
    sha,
    branch,
    dirty,
    buildEnv: process.env.CI ? 'production' : 'local',
  }, null, 2)}\n`);
}
if (config.coiServiceWorker) {
  await writeCoiServiceWorker({
    repoRoot: join(appDir, '..', '..'),
    destination: join(dist, 'coi-serviceworker.js'),
    config: config.coiServiceWorker,
  });
}
console.log(`Assembled static site -> ${join(appDir, "dist")}`);
