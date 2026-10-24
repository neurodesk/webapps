#!/usr/bin/env node
// Fail closed until a production-browser reference exists. Synthetic CLI/Node equality is
// checked separately by test/node-files.test.js and does not establish browser parity.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { gunzipSync } from "node:zlib";
import { tmpdir } from "node:os";
import { fetchPinnedExample } from "../../../test-utils/registration-similarity.mjs";

const { values } = parseArgs({ options: { executable: { type: "string" }, reference: { type: "string" } } });
const referencePath = resolve(values.reference ?? fileURLToPath(new URL("./browser-reference.json", import.meta.url)));
const reference = JSON.parse(await readFile(referencePath, "utf8").catch(error => {
  if (error.code === "ENOENT") throw new Error("HMC release blocked: record a production-browser reference before packaging.");
  throw error;
}));
assert.equal(reference.source, "production-browser");
assert.ok(reference.cases?.length, "Reference must contain completed browser cases");
const hash = bytes => createHash("sha256").update(bytes).digest("hex");
const command = values.executable ? [resolve(values.executable)] : [process.execPath, fileURLToPath(new URL("../bin/hmc.js", import.meta.url))];
const work = await mkdtemp(join(tmpdir(), "hmc-browser-parity-"));
try {
  for (const [i, entry] of reference.cases.entries()) {
    assert.ok(["gp", "trivial"].includes(entry.method));
    const files = {};
    for (const role of ["dwi", "bval", "bvec", "mask", "sidecar"]) {
      if (!entry.inputs[role]) continue;
      const input = entry.inputs[role];
      files[role] = input.url ? join(work, input.name) : resolve(dirname(referencePath), input.path);
      if (input.url) await writeFile(files[role], await fetchPinnedExample(input.url));
      assert.equal(hash(await readFile(files[role])), input.sha256, `Pinned ${role}`);
    }
    assert.ok(files.dwi && files.bval && files.bvec);
    const output = join(work, String(i));
    const args = [files.dwi, files.bval, files.bvec, output, "--method", entry.method, "--seed", String(entry.seed), "--workers", "1"];
    if (files.mask) args.push("--mask", files.mask);
    if (files.sidecar) args.push("--sidecar", files.sidecar);
    const run = spawnSync(command[0], [...command.slice(1), ...args], { encoding: "utf8", timeout: 3600000, maxBuffer: 64 * 1024 * 1024 });
    if (run.error) throw run.error;
    assert.equal(run.status, 0, run.stderr);
    assert.ok(Object.keys(entry.outputs).length >= 6, "Reference must include image, gradients, motion, metadata and transforms");
    assert.deepEqual((await readdir(output)).sort(), Object.keys(entry.outputs).sort());
    for (const [name, expected] of Object.entries(entry.outputs)) {
      const bytes = await readFile(join(output, name));
      assert.equal(hash(expected.decodedSha256 ? gunzipSync(bytes) : bytes), expected.decodedSha256 ?? expected.sha256, `${entry.method}: ${name}`);
    }
    console.log(`PASS ${entry.method}: every derivative equals the production browser reference`);
  }
} finally {
  await rm(work, { recursive: true, force: true });
}
