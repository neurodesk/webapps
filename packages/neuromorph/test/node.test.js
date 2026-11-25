import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  checkInstallation,
  claimOutputDirectory,
  parseCliOptions,
  runNeuromorph,
  writeStagedOutputs,
} from "../src/node.js";

const binPath = fileURLToPath(new URL("../bin/neuromorph.js", import.meta.url));

function runCli(args) {
  return spawnSync(process.execPath, [binPath, ...args], { encoding: "utf8" });
}

test("CLI rejects empty string flags, invalid ranges, and disallowed subcommand options", () => {
  for (const args of [
    ["--sholl-step=", "cell.swc", "out"],
    ["--cache-dir=", "self-check"],
    ["self-check", "--sholl-step", "10"],
    ["self-check", "--offline"],
    ["self-check", "extra"],
    ["cell.swc", "out", "--cache-dir", "/tmp"],
    ["cell.swc", "out", "--sholl-step", "0"],
    ["cell.swc", "out", "--sholl-step", "-5"],
    ["cell.swc"],
  ]) {
    const res = runCli(args);
    assert.notEqual(res.status, 0, `expected failure for ${args.join(" ")}`);
  }
  const help = runCli(["--help"]);
  assert.equal(help.status, 0);
  assert.match(help.stdout, /Usage: neuromorph/);
});

test("parseCliOptions validates Sholl step before I/O", () => {
  assert.throws(() => parseCliOptions({ "sholl-step": "0" }), /positive finite/);
  assert.throws(() => parseCliOptions({ "sholl-step": "abc" }), /positive finite/);
  assert.throws(() => parseCliOptions({ "sholl-step": "2000000" }), /<= 1000000/);
  assert.deepEqual(parseCliOptions({ "sholl-step": "25", "no-repair": true }), { shollStep: 25, repair: false });
});

test("self-check honors --cache-dir offline", async () => {
  const work = await mkdtemp(join(tmpdir(), "neuromorph-self-check-"));
  try {
    const info = await checkInstallation({ cacheDir: work });
    assert.equal(info.ok, true);
    assert.equal(info.cacheDir, work);
    assert.equal(info.phantom.bifurcations, 1);

    const cli = runCli(["self-check", "--cache-dir", work]);
    assert.equal(cli.status, 0, cli.stderr);
    const parsed = JSON.parse(cli.stdout.trim());
    assert.equal(parsed.ok, true);
    assert.equal(parsed.cacheDir, work);
  } finally {
    await rm(work, { recursive: true, force: true });
  }
});

test("claimOutputDirectory enforces O_EXCL exclusivity and cleans up created dir on failure", async () => {
  const work = await mkdtemp(join(tmpdir(), "neuromorph-lock-"));
  try {
    const fresh = join(work, "fresh");
    const claim = await claimOutputDirectory(fresh);
    await assert.rejects(claimOutputDirectory(fresh), /already in use/);
    await claim.release({ removeDirIfEmpty: true });
    await assert.rejects(stat(fresh), { code: "ENOENT" });
  } finally {
    await rm(work, { recursive: true, force: true });
  }
});

test("writeStagedOutputs rolls back already-renamed files if a later rename fails", async () => {
  const work = await mkdtemp(join(tmpdir(), "neuromorph-stage-"));
  try {
    let calls = 0;
    await assert.rejects(
      writeStagedOutputs(
        work,
        [
          { name: "one.csv", bytes: new Uint8Array([1]) },
          { name: "two.csv", bytes: new Uint8Array([2]) },
        ],
        {
          renameFn: async (src, dst) => {
            calls += 1;
            if (calls === 2) throw new Error("rename fail");
            return rename(src, dst);
          },
        },
      ),
      /rename fail/,
    );
    assert.deepEqual(await readdir(work), []);
  } finally {
    await rm(work, { recursive: true, force: true });
  }
});

test("runNeuromorph measures single SWC and writes repaired SWC when zero radius is repaired", async () => {
  const work = await mkdtemp(join(tmpdir(), "neuromorph-e2e-"));
  try {
    const swcPath = join(work, "sample.swc");
    await writeFile(
      swcPath,
      [
        "# synthetic neuron with one zero radius to trigger repair",
        "1 1 0 0 0 5 -1",
        "2 3 0 0 0 1 1",
        "3 3 10 0 0 0 2",
        "4 3 20 10 0 0.8 3",
        "5 3 20 -10 0 0.8 3",
      ].join("\n"),
    );
    const outDir = join(work, "out");
    const result = await runNeuromorph({ inputs: [swcPath], outputDir: outDir, options: { "sholl-step": "5" } });
    assert.equal(result.neuronCount, 1);
    assert.ok(result.files.includes("sample_morphometrics.csv"));
    assert.ok(result.files.includes("sample_sholl.csv"));
    assert.ok(result.files.includes("sample_bifurcations.csv"));
    assert.ok(result.files.includes("sample_repaired.swc"));
    assert.ok(result.files.includes("sample_provenance.json"));
    const morphCsv = await readFile(join(outDir, "sample_morphometrics.csv"), "utf8");
    assert.match(morphCsv, /^neuron,neurite_type,neurites,sections,bifurcations/);
    assert.match(morphCsv, /sample\.swc,all,1,3,1,1,2,/);
  } finally {
    await rm(work, { recursive: true, force: true });
  }
});
