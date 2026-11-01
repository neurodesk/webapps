// Builds the committed single-threaded Greedy WebAssembly (wasm-single/) that SYNcro's command line
// runs in Node. LLVM folds math constants with the host's libm, so it is built on Linux with the threaded
// build's pinned nightly, wasm-pack 0.13.1 and binaryen version_117, and committed: every platform then
// runs the same bytes. --check rebuilds and fails when the committed files differ.
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../../../", import.meta.url)).replace(/\/$/, "");
const crate = fileURLToPath(new URL("../../../exes/greedy/wasm", import.meta.url));
const committed = fileURLToPath(new URL("../wasm-single", import.meta.url));
const target = fileURLToPath(new URL("../../../exes/greedy/target/wasm-single", import.meta.url));
const FILES = ["greedy_rs_wasm.js", "greedy_rs_wasm_bg.wasm"];
const check = process.argv.includes("--check");

// wasm-pack runs the wasm-opt on PATH; CI's setup-wasm-opt action installs this version.
const wasmOpt = execFileSync("wasm-opt", ["--version"], { encoding: "utf8" });
if (!wasmOpt.includes("version_117")) throw new Error(`Need binaryen version_117 wasm-opt on PATH, found: ${wasmOpt.trim()}`);

// Panic messages embed source paths. Map this checkout, the Cargo registry and the toolchain's std
// sources (rustc reads them from rust-src when that is installed) to fixed names, so the bytes do not
// depend on the host.
const rustc = (...args) => execFileSync("rustup", ["run", "nightly-2025-11-15", "rustc", ...args], { encoding: "utf8" }).trim();
const commit = rustc("-vV").match(/^commit-hash: (\S+)$/m)[1];
const remap = [
  [root, "/webapps"],
  [process.env.CARGO_HOME ?? join(homedir(), ".cargo"), "/cargo"],
  [join(rustc("--print", "sysroot"), "lib/rustlib/src/rust"), `/rustc/${commit}`],
].map(([from, to]) => `--remap-path-prefix=${from}=${to}`);

// The producers section names the wasm-bindgen build ("0.2.128" from cargo install, "0.2.128 (246946fdd)"
// from the release binary wasm-pack downloads). It is metadata only, so drop it.
function withoutProducers(wasm) {
  const leb = (at) => {
    let value = 0;
    let shift = 0;
    let length = 0;
    let byte;
    do {
      byte = wasm[at + length++];
      value += (byte & 0x7f) * 2 ** shift;
      shift += 7;
    } while (byte & 0x80);
    return { value, length };
  };
  const kept = [wasm.subarray(0, 8)];
  for (let at = 8; at < wasm.length;) {
    const size = leb(at + 1);
    const end = at + 1 + size.length + size.value;
    const body = at + 1 + size.length;
    const name = wasm[at] === 0 ? leb(body) : null;
    const producers = name && wasm.subarray(body + name.length, body + name.length + name.value).toString("utf8") === "producers";
    if (!producers) kept.push(wasm.subarray(at, end));
    at = end;
  }
  return Buffer.concat(kept);
}

const output = mkdtempSync(join(tmpdir(), "greedy-wasm-single-"));
try {
  execFileSync("rustup", [
    "run",
    "nightly-2025-11-15",
    "wasm-pack",
    "build",
    crate,
    "--target",
    "web",
    "--release",
    "--out-dir",
    output,
    "--out-name",
    "greedy_rs_wasm",
    "--no-pack",
    "--",
    "--no-default-features",
  ], { stdio: "inherit", env: { ...process.env, CARGO_TARGET_DIR: target, RUSTFLAGS: remap.join(" ") } });
  const stale = [];
  for (const file of FILES) {
    let bytes = readFileSync(join(output, file));
    if (file.endsWith(".js")) bytes = Buffer.from(bytes.toString("utf8").replaceAll("\r\n", "\n"));
    else bytes = withoutProducers(bytes);
    if (!check) writeFileSync(join(committed, file), bytes);
    else if (!bytes.equals(readFileSync(join(committed, file)))) {
      stale.push(file);
      // CI uploads this directory, so a mismatch can be compared with a local build.
      if (process.env.GREEDY_WASM_SINGLE_REBUILD) {
        mkdirSync(process.env.GREEDY_WASM_SINGLE_REBUILD, { recursive: true });
        writeFileSync(join(process.env.GREEDY_WASM_SINGLE_REBUILD, file), bytes);
      }
    }
  }
  if (stale.length) {
    console.error(`These committed files differ from a rebuild: ${stale.join(", ")}. Run pnpm --filter @neurodesk/greedy build:wasm-single on Linux and commit the result.`);
    process.exitCode = 1;
  }
} finally {
  rmSync(output, { recursive: true, force: true });
}
