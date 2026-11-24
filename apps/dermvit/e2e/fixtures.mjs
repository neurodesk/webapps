// Shared e2e helpers: fetch pinned model & example assets once into TMPDIR cache
// and serve them over a local loopback HTTP server so large (87 MB) model files
// never exceed Chromium DevTools Protocol's 100 MiB pipe buffer.
import { createHash } from "node:crypto";
import { createReadStream, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { MODEL } from "../src/config.js";

export const examples = JSON.parse(readFileSync(new URL("../examples.json", import.meta.url), "utf8"));
export const nevusExample = examples.find((item) => item.id === "isic-nevus");
export const nevusFile = nevusExample.files[0];

const cacheDir = join(process.env.TMPDIR || tmpdir(), "dermvit-e2e-cache");

/** Downloads a pinned asset once into TMPDIR cache and checks its byte length and SHA-256. */
export async function pinnedPath({ url, sha256, bytes }) {
  mkdirSync(cacheDir, { recursive: true });
  const filePath = join(cacheDir, sha256);
  if (!existsSync(filePath)) {
    const response = await fetch(url);
    if (!response.ok) throw new Error(`${url}: HTTP ${response.status}`);
    writeFileSync(filePath, Buffer.from(await response.arrayBuffer()));
  }
  const data = readFileSync(filePath);
  if (data.length !== bytes || createHash("sha256").update(data).digest("hex") !== sha256) {
    throw new Error(`${url}: checksum or size mismatch`);
  }
  return filePath;
}

/** Downloads a pinned asset once and returns its verified Buffer. */
export async function pinned(asset) {
  return readFileSync(await pinnedPath(asset));
}

let assetServer = null;
const servedFiles = new Map();

async function ensureAssetServer() {
  if (assetServer) return assetServer;
  const server = createServer((req, res) => {
    const key = (req.url || "").replace(/^\/+/, "");
    const entry = servedFiles.get(key);
    if (!entry) {
      res.writeHead(404);
      res.end("Not found");
      return;
    }
    res.writeHead(200, {
      "content-type": entry.contentType,
      "content-length": String(entry.bytes),
      "access-control-allow-origin": "*",
      "cross-origin-resource-policy": "cross-origin",
    });
    createReadStream(entry.filePath).pipe(res);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  server.unref();
  const { port } = server.address();
  assetServer = { server, origin: `http://127.0.0.1:${port}` };
  return assetServer;
}

/** Routes the pinned ONNX model via local loopback HTTP (fetchModel still verifies sha256 in the worker). */
export async function routeModel(page, { hold = null } = {}) {
  const filePath = await pinnedPath(MODEL);
  const { origin } = await ensureAssetServer();
  servedFiles.set(MODEL.sha256, {
    filePath,
    bytes: MODEL.bytes,
    contentType: "application/octet-stream",
  });
  const localUrl = `${origin}/${MODEL.sha256}`;
  await page.route(MODEL.url, async (route) => {
    if (hold) await hold();
    await route.fulfill({
      status: 302,
      headers: {
        location: localUrl,
        "access-control-allow-origin": "*",
        "cross-origin-resource-policy": "cross-origin",
      },
    });
  });
}

/** Routes an example JPEG from local cache. */
export async function routeExample(page, file = nevusFile) {
  const body = await pinned(file);
  await page.route(file.url, (route) =>
    route.fulfill({
      body,
      headers: {
        "content-type": "image/jpeg",
        "access-control-allow-origin": "*",
        "cross-origin-resource-policy": "cross-origin",
      },
    }),
  );
  return body;
}
