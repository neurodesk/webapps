import { execFileSync } from "node:child_process";
import { globSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const packageRoot = fileURLToPath(new URL("..", import.meta.url));
const crate = fileURLToPath(new URL("../../../exes/greedy/wasm", import.meta.url));
const output = fileURLToPath(new URL("../wasm", import.meta.url));
const lock = fileURLToPath(new URL("../.wasm-build.lock", import.meta.url));
const atomics = [
  "-C target-feature=+atomics,+bulk-memory",
  "-C link-arg=--shared-memory",
  "-C link-arg=--max-memory=1073741824",
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
    if (Date.now() >= deadline) throw new Error("Timed out waiting for another Greedy WebAssembly build.");
    Atomics.wait(wait, 0, 0, 250);
  }
}

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
    "--",
    "-Z",
    "build-std=panic_abort,std",
  ], { cwd: packageRoot, stdio: "inherit", env: { ...process.env, CARGO_TARGET_WASM32_UNKNOWN_UNKNOWN_RUSTFLAGS: atomics } });

  rmSync(new URL("../wasm/.gitignore", import.meta.url), { force: true });
  for (const file of globSync(`${output}/**/*.js`)) {
    const source = readFileSync(file, "utf8");
    writeFileSync(file, source.replaceAll("\r\n", "\n"));
  }
} finally {
  rmSync(lock, { recursive: true, force: true });
}
