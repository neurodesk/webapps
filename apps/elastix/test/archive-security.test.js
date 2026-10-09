import assert from "node:assert/strict";
import { lstat, mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import test from "node:test";

// Resolve the extractor through its actual ITK-Wasm consumer, not a test dependency.
const itkRequire = createRequire(import.meta.resolve("itk-wasm"));
const damRequire = createRequire(itkRequire.resolve("@itk-wasm/dam"));
const { default: decompress } = await import(pathToFileURL(damRequire.resolve("decompress")));
const tar = damRequire("tar");

test("ITK archive extraction reads valid archives and rejects escaping symlinks", async () => {
  const root = await mkdtemp(join(tmpdir(), "elastix-archive-security-"));
  try {
    const source = join(root, "source");
    const output = join(root, "output");
    const outside = join(root, "outside");
    await mkdir(source);
    await mkdir(outside);
    await writeFile(join(source, "image.txt"), "image data");
    const safeArchive = join(root, "safe.tar");
    await tar.c({ file: safeArchive, cwd: source }, ["image.txt"]);
    await decompress(safeArchive, output);
    assert.equal(await readFile(join(output, "image.txt"), "utf8"), "image data");

    await symlink("../outside", join(source, "escape"));
    const maliciousArchive = join(root, "malicious.tar");
    await tar.c({ file: maliciousArchive, cwd: source }, ["escape"]);
    await assert.rejects(decompress(maliciousArchive, output));
    await assert.rejects(lstat(join(output, "escape")));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
