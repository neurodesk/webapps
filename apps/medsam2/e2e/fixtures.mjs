// Shared e2e helpers: pinned example and MedSAM2 ONNX models fetched once per run and served
// from an ephemeral local HTTP server via page.route(continue) so large ONNX models stream
// directly over loopback without Playwright CDP base64 overhead.
import { createHash } from "node:crypto";
import { createReadStream, existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import http from "node:http";
import { join } from "node:path";
import { MODEL } from "../src/config.js";

export const examples = JSON.parse(readFileSync(new URL("../examples.json", import.meta.url), "utf8"));
export const [example] = examples;
export const [exampleFile] = example.files;

const cacheDir = join(process.env.TMPDIR || "/tmp", "medsam2-e2e-cache");
let assetServer = null;

export async function ensurePinnedPath({ url, sha256, bytes }) {
  mkdirSync(cacheDir, { recursive: true });
  const path = join(cacheDir, sha256);
  if (!existsSync(path)) {
    const response = await fetch(url);
    if (!response.ok) throw new Error(`${url}: HTTP ${response.status}`);
    const tmp = `${path}.${process.pid}.${Math.random().toString(16).slice(2)}.tmp`;
    writeFileSync(tmp, Buffer.from(await response.arrayBuffer()));
    renameSync(tmp, path);
  }
  const size = statSync(path).size;
  if (size !== bytes) throw new Error(`${url}: size mismatch (${size} !== ${bytes})`);
  const digest = createHash("sha256").update(readFileSync(path)).digest("hex");
  if (digest !== sha256) throw new Error(`${url}: checksum mismatch`);
  return path;
}

export async function pinned(asset) {
  const path = await ensurePinnedPath(asset);
  return readFileSync(path);
}

async function getAssetServerUrl() {
  if (!assetServer) {
    const server = http.createServer((req, res) => {
      const key = decodeURIComponent((req.url || "").replace(/^\/+/, ""));
      if (!/^[a-f0-9]{64}$/.test(key)) {
        res.writeHead(404);
        res.end();
        return;
      }
      const file = join(cacheDir, key);
      if (!existsSync(file)) {
        res.writeHead(404);
        res.end();
        return;
      }
      const size = statSync(file).size;
      res.writeHead(200, {
        "content-type": "application/octet-stream",
        "content-length": String(size),
        "access-control-allow-origin": "*",
        "cross-origin-resource-policy": "cross-origin",
      });
      createReadStream(file).pipe(res);
    });
    server.unref();
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address();
    assetServer = `http://127.0.0.1:${port}`;
  }
  return assetServer;
}

export async function routeModels(page, { hold = null } = {}) {
  const baseUrl = await getAssetServerUrl();
  const assets = [
    MODEL.imageEncoder,
    MODEL.maskDecoder,
    MODEL.memoryEncoder,
    MODEL.memoryAttention,
  ];
  for (const asset of assets) {
    await page.route(asset.url, async (route) => {
      await ensurePinnedPath(asset);
      if (hold) await hold(asset);
      await route.fulfill({
        status: 302,
        headers: {
          location: `${baseUrl}/${asset.sha256}`,
          "access-control-allow-origin": "*",
          "cross-origin-resource-policy": "cross-origin",
        },
      });
    });
  }
}

export async function routeExample(page) {
  const baseUrl = await getAssetServerUrl();
  await ensurePinnedPath(exampleFile);
  await page.route(exampleFile.url, (route) => route.fulfill({
    status: 302,
    headers: {
      location: `${baseUrl}/${exampleFile.sha256}`,
      "access-control-allow-origin": "*",
      "cross-origin-resource-policy": "cross-origin",
    },
  }));
}
