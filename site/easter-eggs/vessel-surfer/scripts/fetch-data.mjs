import { readFile, writeFile, mkdir } from "node:fs/promises";
import { createHash } from "node:crypto";
const root = new URL("../", import.meta.url);
const manifest = JSON.parse(
  await readFile(new URL("data-manifest.json", root)),
);
const destination = new URL("public/data/", root);
await mkdir(destination, { recursive: true });
for (const [name, digest] of Object.entries(manifest.files)) {
  const path = new URL(name, destination);
  const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
  try {
    if (hash(await readFile(path)) === digest) continue;
  } catch {}
  const url = `https://huggingface.co/datasets/neurodeskorg/webapps/resolve/${manifest.revision}/easter-eggs/vessel-surfer/ixi322-v1/${name}`;
  const response = await fetch(url);
  if (!response.ok)
    throw new Error(`Could not download ${name}: ${response.status}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  if (hash(bytes) !== digest) throw new Error(`Checksum mismatch for ${name}`);
  await writeFile(path, bytes);
}
