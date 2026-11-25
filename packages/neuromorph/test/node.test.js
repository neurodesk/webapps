import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { link, mkdtemp, readFile, readdir, rename, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  OUTPUT_LOCK_FILE,
  checkInstallation,
  claimOutputDirectory,
  parseCliOptions,
  runNeuromorph,
  writeStagedOutputs,
} from "../src/node.js";

const binPath = fileURLToPath(new URL("../bin/neuromorph.js", import.meta.url));
const NODE_MODULE_URL = new URL("../src/node.js", import.meta.url).href;

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

test("parseCliOptions validates unknown keys, types, and Sholl step before I/O", () => {
  assert.throws(() => parseCliOptions({ "shol-step": "10" }), /Unknown option/);
  assert.throws(() => parseCliOptions(Object.create({ "sholl-step": "10" })), /plain object/);
  assert.throws(() => parseCliOptions({ "sholl-step": null }), /positive finite/);
  assert.throws(() => parseCliOptions({ "sholl-step": true }), /positive finite/);
  assert.throws(() => parseCliOptions({ "no-repair": "yes" }), /boolean/);
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

test("claimOutputDirectory uses shared .neurodesk-cli.lock, rejects symlinks, and cleans up on SIGTERM", async () => {
  const work = await mkdtemp(join(tmpdir(), "neuromorph-lock-"));
  try {
    assert.equal(OUTPUT_LOCK_FILE, ".neurodesk-cli.lock");
    const fresh = join(work, "fresh");
    const claim = await claimOutputDirectory(fresh);
    await assert.rejects(claimOutputDirectory(fresh), /already in use/);
    await claim.release({ removeDirIfEmpty: true });
    await assert.rejects(stat(fresh), { code: "ENOENT" });

    // Cross-CLI shared lock contention: a pre-existing .neurodesk-cli.lock blocks claiming
    const sharedDir = join(work, "shared-lock");
    const otherLockClaim = await claimOutputDirectory(sharedDir);
    assert.equal((await readdir(sharedDir))[0], ".neurodesk-cli.lock");
    await assert.rejects(claimOutputDirectory(sharedDir), /already in use/);
    await otherLockClaim.release({ removeDirIfEmpty: true });

    const linkPath = join(work, "link-dir");
    await symlink(join(work, "real"), linkPath);
    await assert.rejects(claimOutputDirectory(linkPath), /symbolic link/);

    const sigDir = join(work, "sigterm-dir");
    const child = spawn(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        `import { claimOutputDirectory } from ${JSON.stringify(NODE_MODULE_URL)};
         await claimOutputDirectory(${JSON.stringify(sigDir)});
         process.stdout.write("LOCKED\\n");
         setInterval(() => {}, 1000);`,
      ],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
    await new Promise((resolveReady, rejectReady) => {
      let out = "";
      child.stdout.on("data", (chunk) => {
        out += chunk.toString();
        if (out.includes("LOCKED")) resolveReady();
      });
      child.on("error", rejectReady);
      child.on("exit", (code) => rejectReady(new Error(`child exited early: ${code}`)));
    });
    child.kill("SIGTERM");
    await new Promise((resolveExit) => child.on("exit", resolveExit));
    await assert.rejects(stat(sigDir), { code: "ENOENT" });
  } finally {
    await rm(work, { recursive: true, force: true });
  }
});

test("writeStagedOutputs enforces atomic non-overwrite, cleans failed .partial, and rolls back on mid-publication SIGTERM", async () => {
  const work = await mkdtemp(join(tmpdir(), "neuromorph-stage-"));
  try {
    await assert.rejects(
      writeStagedOutputs(
        work,
        [{ name: "one.csv", bytes: new Uint8Array([1, 2, 3]) }],
        {
          writeFileFn: async (p, bytes, opts) => {
            await writeFile(p, bytes.subarray(0, 1), opts);
            throw Object.assign(new Error("EFBIG"), { code: "EFBIG" });
          },
        },
      ),
      /EFBIG/,
    );
    assert.deepEqual(await readdir(work), []);

    const racingDest = join(work, "race.csv");
    await assert.rejects(
      writeStagedOutputs(
        work,
        [
          { name: "race.csv", bytes: new Uint8Array([9]) },
          { name: "two.csv", bytes: new Uint8Array([2]) },
        ],
        {
          linkFn: async (src, dst) => {
            await writeFile(racingDest, "keep-me");
            return link(src, dst);
          },
        },
      ),
      /Refusing to overwrite/,
    );
    assert.equal(await readFile(racingDest, "utf8"), "keep-me");
    await rm(racingDest);

    let calls = 0;
    await assert.rejects(
      writeStagedOutputs(
        work,
        [
          { name: "one.csv", bytes: new Uint8Array([1]) },
          { name: "two.csv", bytes: new Uint8Array([2]) },
        ],
        {
          linkFn: async (src, dst) => {
            calls += 1;
            if (calls === 1) {
              await link(src, dst);
              await rm(dst);
              await writeFile(dst, "external");
              return;
            }
            throw new Error("link fail");
          },
        },
      ),
      /link fail/,
    );
    assert.equal(await readFile(join(work, "one.csv"), "utf8"), "external");
    assert.deepEqual(await readdir(work), ["one.csv"]);

    const sigPubDir = join(work, "sigterm-mid-pub");
    const child = spawn(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        `import { link } from "node:fs/promises";
         import { claimOutputDirectory, writeStagedOutputs } from ${JSON.stringify(NODE_MODULE_URL)};
         const claim = await claimOutputDirectory(${JSON.stringify(sigPubDir)});
         let n = 0;
         await writeStagedOutputs(
           claim.directory,
           [
             { name: "one.csv", bytes: new Uint8Array([1]) },
             { name: "two.csv", bytes: new Uint8Array([2]) },
           ],
           {
             claim,
             linkFn: async (src, dst) => {
               n += 1;
               if (n === 1) return link(src, dst);
               setInterval(() => {}, 1000);
               process.kill(process.pid, "SIGTERM");
               await new Promise(() => {});
             },
           },
         );`,
      ],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
    const exitSignal = await new Promise((resolveExit) => child.on("exit", (_code, signal) => resolveExit(signal)));
    assert.equal(exitSignal, "SIGTERM");
    await assert.rejects(stat(sigPubDir), { code: "ENOENT" });
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
