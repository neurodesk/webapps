import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { join, posix } from "node:path";
import { fileURLToPath } from "node:url";

export async function benchmarkSourceHashes(root = fileURLToPath(new URL("../../../", import.meta.url))) {
  async function files(directory) {
    const entries = await readdir(join(root, directory), { withFileTypes: true });
    return (await Promise.all(entries.map(entry => entry.isDirectory()
      ? files(posix.join(directory, entry.name)) : posix.join(directory, entry.name)))).flat();
  }
  const paths = [
    "pnpm-lock.yaml", "packages/hmc/package.json", "packages/hmc-registration/package.json", "packages/components/package.json",
    ...(await Promise.all([
      "packages/hmc/src", "packages/hmc-registration/src", "packages/hmc-registration/wasm", "packages/components/src/file-io", "packages/components/src/automation",
    ].map(files))).flat(),
    ...(await readdir(join(root, "packages/hmc/validation")))
      .filter(name => /^benchmark.*\.[cm]?js$/.test(name)).map(name => `packages/hmc/validation/${name}`),
  ];
  return Object.fromEntries(await Promise.all(paths.sort().map(async path => [
    path, createHash("sha256").update(await readFile(join(root, path))).digest("hex"),
  ])));
}
