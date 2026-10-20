import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { zipStore } from "../src/zip.js";

test("zipStore writes an archive unzip accepts, with the bytes intact", () => {
  const files = [{ name: "a.txt", bytes: new TextEncoder().encode("hello") }, { name: "sub/b.bin", bytes: Uint8Array.of(0, 255, 7) }];
  const dir = mkdtempSync(join(process.env.TMPDIR || tmpdir(), "zip-"));
  writeFileSync(join(dir, "out.zip"), zipStore(files));
  execFileSync("unzip", ["-q", "out.zip", "-d", "x"], { cwd: dir });
  assert.equal(readFileSync(join(dir, "x/a.txt"), "utf8"), "hello");
  assert.deepEqual([...readFileSync(join(dir, "x/sub/b.bin"))], [0, 255, 7]);
  assert.deepEqual(zipStore(files), zipStore(files));
});
