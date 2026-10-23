// Builds the two WebAssembly modules of exes/dwi/shoreline-wasm into wasm/ (gitignored):
// wasm/threads (atomics and wasm-bindgen-rayon, for cross-origin isolated pages) and
// wasm/single (one thread, for any page). Both use greedy's pinned nightly and wasm-pack.
import { execFileSync } from "node:child_process";
import { globSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const packageRoot = fileURLToPath(new URL("..", import.meta.url));
const crate = fileURLToPath(new URL("../../../exes/dwi/shoreline-wasm", import.meta.url));
const output = fileURLToPath(new URL("../wasm", import.meta.url));
const lock = fileURLToPath(new URL("../.wasm-build.lock", import.meta.url));
const toolchain = "nightly-2025-11-15";
// A series of a clinical size needs a few GB: allow WebAssembly's 4 GB.
const memory = "-C link-arg=--max-memory=4294967296";
const atomics = [
  "-C target-feature=+atomics,+bulk-memory",
  "-C link-arg=--shared-memory",
  memory,
  "-C link-arg=--import-memory",
  "-C link-arg=--export=__wasm_init_tls",
  "-C link-arg=--export=__tls_size",
  "-C link-arg=--export=__tls_align",
  "-C link-arg=--export=__tls_base",
].join(" ");

const wait = new Int32Array(new SharedArrayBuffer(4));
const deadline = Date.now() + 10 * 60 * 1000;
for (;;) {
  try {
    mkdirSync(lock);
    break;
  } catch (error) {
    if (error.code !== "EEXIST") throw error;
    let modified;
    try {
      modified = statSync(lock).mtimeMs;
    } catch (statError) {
      if (statError.code === "ENOENT") continue;
      throw statError;
    }
    if (Date.now() - modified > 15 * 60 * 1000) {
      rmSync(lock, { recursive: true, force: true });
      continue;
    }
    if (Date.now() >= deadline) throw new Error("Timed out waiting for another shoreline WebAssembly build.");
    Atomics.wait(wait, 0, 0, 250);
  }
}

function build(name, rustflags, cargoArgs) {
  execFileSync("rustup", [
    "run",
    toolchain,
    "wasm-pack",
    "build",
    crate,
    "--target",
    "web",
    "--release",
    "--out-dir",
    `${output}/${name}`,
    "--out-name",
    "shoreline_wasm",
    "--",
    ...cargoArgs,
  ], {
    cwd: packageRoot,
    stdio: "inherit",
    env: { ...process.env, CARGO_TARGET_WASM32_UNKNOWN_UNKNOWN_RUSTFLAGS: rustflags, CARGO_TARGET_DIR: fileURLToPath(new URL(`../../../exes/dwi/target/shoreline-wasm-${name}`, import.meta.url)) },
  });
  rmSync(`${output}/${name}/.gitignore`, { force: true });
}

try {
  build("single", memory, []);
  build("threads", atomics, ["--features", "threads", "-Z", "build-std=panic_abort,std"]);
  for (const file of globSync(`${output}/**/*.js`)) {
    const source = readFileSync(file, "utf8");
    writeFileSync(file, source.replaceAll("\r\n", "\n"));
  }
} finally {
  rmSync(lock, { recursive: true, force: true });
}
