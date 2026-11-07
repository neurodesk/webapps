// Shared e2e helpers: the pinned example and models fetched once per test run and served to the
// page through page.route, so every test reads the hosted bytes without downloading them again.
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { MODEL } from "../src/config.js";

export const examples = JSON.parse(readFileSync(new URL("../examples.json", import.meta.url), "utf8"));
export const reference = JSON.parse(readFileSync(new URL("../validation/reference.json", import.meta.url), "utf8"));
export const [example] = examples;
export const [exampleFile] = example.files;

const cacheDir = join(process.env.TMPDIR || "/tmp", "microsam-e2e-cache");

/** A pinned asset's bytes, downloaded once and checked against its checksum. */
export async function pinned({ url, sha256, bytes }) {
  mkdirSync(cacheDir, { recursive: true });
  const path = join(cacheDir, sha256);
  if (!existsSync(path)) {
    const response = await fetch(url);
    if (!response.ok) throw new Error(`${url}: HTTP ${response.status}`);
    writeFileSync(path, Buffer.from(await response.arrayBuffer()));
  }
  const data = readFileSync(path);
  if (data.length !== bytes || createHash("sha256").update(data).digest("hex") !== sha256) throw new Error(`${url}: checksum mismatch`);
  return data;
}

/** Serves the two model files from the cache (fetchModel still verifies them in the page). */
export async function routeModels(page, { hold = null } = {}) {
  for (const asset of [MODEL.encoder, MODEL.decoder]) {
    const body = await pinned(asset);
    await page.route(asset.url, async (route) => {
      if (hold) await hold(asset);
      await route.fulfill({ body, headers: { "content-type": "application/octet-stream", "access-control-allow-origin": "*" } });
    });
  }
}

export async function routeExample(page) {
  const body = await pinned(exampleFile);
  await page.route(exampleFile.url, (route) => route.fulfill({ body, headers: { "content-type": "image/tiff", "access-control-allow-origin": "*" } }));
  return body;
}

export function iou(a, b) {
  let intersection = 0;
  let union = 0;
  for (let i = 0; i < a.length; i++) {
    if (a[i] && b[i]) intersection++;
    if (a[i] || b[i]) union++;
  }
  return union ? intersection / union : 1;
}

export function runsToMask(runs, size) {
  const mask = new Uint8Array(size);
  let at = 0;
  runs.forEach((length, index) => {
    if (index % 2) mask.fill(1, at, at + length);
    at += length;
  });
  return mask;
}
