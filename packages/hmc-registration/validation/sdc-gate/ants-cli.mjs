// ANTs command lines (antsRegistration, antsApplyTransforms, ImageMath) in the hmc-registration
// WebAssembly kernel, for the #462 SyN-SDC replays that sdcflows drives.
//
//   node ants-cli.mjs [antsApplyTransforms|ImageMath] <native argv...>
//
// replay.sh and e2e.sh put wrappers named after the ANTs programs on PATH. Every argv piece that
// names an existing file is read into the kernel's private run directory under a unique plain
// name, and the files the run writes go to the working directory. antsRegistration gets
// --random-seed from ANTS_RANDOM_SEED, as the native reference sets the seed, unless argv has one;
// the kernel refuses argv without --float 1.
//
// HMC_WASM_DIR       a directory with another build's hmc-registration.{mjs,wasm} (for example
//                    HMC_REGISTRATION_MATTES_PDF_DOUBLE=1 scripts/build.sh); without it the
//                    committed kernel runs, checked against its pinned SHA-256
// HMC_WASM_RECORD    JSON-lines file: one record per call, with the kernel's SHA-256 and the size
//                    of its linear memory at the end, which only grows, so it is the run's peak
// HMC_WASM_HEAP_TRACE=1  also record every heap growth request: the module is imported from a
//                    temporary copy whose _emscripten_resize_heap reports each requested size
import { createHash } from "node:crypto";
import { appendFileSync, existsSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createHmcRegistration, programOf } from "../../src/index.js";
import { HMC_REGISTRATION_WASM_SHA256 } from "../../src/pin.js";

const argv = process.argv.slice(2);
if (argv.length === 1 && argv[0] === "--version") {
  // nipype's version probe. The kernel prints its banner only inside a registration.
  process.stdout.write("ANTs Version: 2.6.2-neurodesk-wasm\n");
  process.exit(0);
}
const program = programOf(argv);

const kernelDir = process.env.HMC_WASM_DIR ?? fileURLToPath(new URL("../../wasm/", import.meta.url));
const wasmBinary = readFileSync(join(kernelDir, "hmc-registration.wasm"));
const wasmSha256 = createHash("sha256").update(wasmBinary).digest("hex");
if (!process.env.HMC_WASM_DIR && wasmSha256 !== HMC_REGISTRATION_WASM_SHA256) {
  throw new Error("The committed kernel does not have its pinned SHA-256.");
}
let modulePath = join(kernelDir, "hmc-registration.mjs");
const growth = { requests: 0, max_requested_bytes: 0 };
if (process.env.HMC_WASM_HEAP_TRACE === "1") {
  const hook = "function _emscripten_resize_heap(requestedSize){requestedSize>>>=0;";
  const source = readFileSync(modulePath, "utf8");
  if (source.split(hook).length !== 2) throw new Error("The module's _emscripten_resize_heap is not the expected one.");
  modulePath = join(mkdtempSync(join(tmpdir(), "hmc-heap-")), "hmc-registration.mjs");
  writeFileSync(modulePath, source.replace(hook, `${hook}globalThis.__hmcHeapRequest?.(requestedSize);`));
  globalThis.__hmcHeapRequest = (bytes) => {
    growth.requests++;
    growth.max_requested_bytes = Math.max(growth.max_requested_bytes, bytes);
  };
}
const { default: createModule } = await import(pathToFileURL(modulePath).href);

// sdcflows' debug path, which the grid patch uses, adds --write-interval-volumes to epi2anat: about
// 1.3 GB of snapshots of the warped image, written by an observer that does not change the
// optimization. The port never passes it.
const dropped = [];
const kept = [];
for (let i = 0; i < argv.length; i++) {
  if (argv[i] === "--write-interval-volumes") dropped.push(argv[i], argv[++i]);
  else kept.push(argv[i]);
}
const inputs = {};
const names = new Map();
function mapPath(piece) {
  const path = piece.trim();
  if (!path.startsWith("/") || !existsSync(path) || !statSync(path).isFile()) return piece;
  if (!names.has(path)) {
    const name = `in${names.size}_${basename(path)}`;
    names.set(path, name);
    inputs[name] = readFileSync(path);
  }
  return piece.replace(path, names.get(path));
}
const mapped = kept.map((token) => token.split(/([[\],])/).map(mapPath).join(""));
if (program === "antsRegistration" && !mapped.includes("--random-seed")) {
  if (!process.env.ANTS_RANDOM_SEED) throw new Error("ANTS_RANDOM_SEED is not set and argv has no --random-seed.");
  mapped.push("--random-seed", process.env.ANTS_RANDOM_SEED);
}

const started = performance.now();
const kernel = await createHmcRegistration({ createModule, wasmBinary, onLog: (line) => process.stdout.write(`${line}\n`) });
let exit = 0;
let error = null;
let outputs = {};
try {
  ({ outputs } = kernel.run(mapped, inputs));
} catch (caught) {
  exit = 1;
  error = caught.message;
  process.stderr.write(`${caught.message}\n`);
}
const wallS = (performance.now() - started) / 1000;
for (const [name, bytes] of Object.entries(outputs)) writeFileSync(resolve(process.cwd(), name), bytes);
if (process.env.HMC_WASM_RECORD) {
  const record = {
    program,
    cwd: process.cwd(),
    argv: mapped,
    dropped_debug_args: dropped,
    wasm_sha256: wasmSha256,
    exit,
    error,
    wall_s: Math.round(wallS * 10) / 10,
    wasm_heap_bytes: kernel.memoryBytes(),
    node_rss_bytes_at_exit: process.memoryUsage().rss,
    heap_growth: process.env.HMC_WASM_HEAP_TRACE === "1" ? growth : null,
    outputs: Object.keys(outputs),
  };
  appendFileSync(process.env.HMC_WASM_RECORD, `${JSON.stringify(record)}\n`);
}
process.exit(exit);
