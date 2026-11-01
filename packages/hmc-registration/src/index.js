// ANTs (antsRegistration, AverageImages, AverageAffineTransform and an antsApplyTransforms-style
// --apply) in WebAssembly with a generic run(argv): the input files are written to a private
// directory of the virtual file system, the kernel runs there, every new file is read back, and
// the directory is removed.

export { HMC_REGISTRATION_WASM_SHA256 } from "./pin.js";
export { readMatTransform, writeMatTransform } from "./mat.js";

const MAX_SEED = 2147483647;

function valueOf(argv, flag) {
  const positions = [];
  argv.forEach((token, index) => {
    if (token === flag) positions.push(index);
  });
  if (positions.length !== 1) return { count: positions.length };
  return { count: 1, value: argv[positions[0] + 1] };
}

/** The programs other than antsRegistration, selected by argv[0], as src/main.cxx dispatches them. */
export const PROGRAMS = Object.freeze(["AverageImages", "AverageAffineTransform", "--apply", "ImageMath", "antsApplyTransforms"]);

/** The program argv runs: argv[0] when it is one of PROGRAMS, else antsRegistration. */
export function programOf(argv) {
  return PROGRAMS.includes(argv?.[0]) ? argv[0] : "antsRegistration";
}

/**
 * Refuses argv that this build must not run. For antsRegistration (the default program), the
 * kernel has only the 3D float implementation, so `--float 1` is required, and ANTs seeds from
 * the clock when no seed is given, so an explicit `--random-seed` (an integer from 1 to
 * 2147483647) is required too. AverageImages, AverageAffineTransform and --apply take file names
 * as positional arguments, so none of their arguments may hold a directory.
 */
export function checkArguments(argv) {
  if (!Array.isArray(argv) || argv.some((token) => typeof token !== "string")) throw new TypeError("argv must be an array of strings.");
  const program = programOf(argv);
  if (program !== "antsRegistration") {
    if (program === "ImageMath") {
      if (argv.length < 5 || argv[1] !== "3" || argv[3] !== "Laplacian") {
        throw new Error("ImageMath supports only: 3 output Laplacian input [sigma [normalize]].");
      }
      if (argv[5] !== undefined && (!Number.isFinite(Number(argv[5])) || !/^[+-]?[0-9]/.test(argv[5].trim()) || parseInt(argv[5], 10) < -2147483648 || parseInt(argv[5], 10) > 2147483647 || !Number.isFinite(Math.fround(Number(argv[5]))))) {
        throw new Error("Laplacian sigma must be finite with an integer prefix, as in pinned ImageMath.");
      }
    }
    for (const token of argv.slice(1)) {
      if (token.includes("/") || token.includes("\0") || token === "..") {
        throw new Error(`${program} arguments must be plain file names inside the private run directory: ${JSON.stringify(token)}.`);
      }
    }
    return argv;
  }
  const float = valueOf(argv, "--float");
  if (float.count !== 1 || float.value !== "1") {
    throw new Error("This build runs only antsRegistration --float 1: give --float 1 exactly once.");
  }
  const seed = valueOf(argv, "--random-seed");
  const seedValue = seed.value ?? "";
  if (seed.count !== 1 || !/^[1-9][0-9]*$/.test(seedValue) || Number(seedValue) > MAX_SEED) {
    throw new Error("Give --random-seed exactly once, with an integer from 1 to 2147483647: without it ANTs seeds from the clock.");
  }
  return argv;
}

// The input files each program reads, from its positional arguments.
function inputNames(program, argv) {
  if (program === "--apply") return [argv[1], argv[2], ...argv.slice(6).map((name) => name.replace(/^inverse:/, ""))];
  if (program === "AverageImages") return argv.slice(4);
  if (program === "ImageMath") return [argv[4]];
  if (program === "antsApplyTransforms") {
    const names = [];
    for (let i = 1; i < argv.length - 1; i++) {
      if (!["-i", "--input", "-r", "--reference-image", "-t", "--transform"].includes(argv[i])) continue;
      const transform = argv[i] === "-t" || argv[i] === "--transform";
      let argument = argv[++i];
      // nipype renders "[ file.mat, 1 ]", so a native command line splits it over tokens, which
      // ANTs' parser regroups.
      while (transform && argument.startsWith("[") && !argument.endsWith("]") && i < argv.length - 1) argument += argv[++i];
      if (transform && argument.startsWith("[") && !/^\[[^[\]]+\]$/.test(argument)) {
        throw new Error("Malformed antsApplyTransforms transform: use a single balanced [file, inverse] group.");
      }
      const name = transform && argument.startsWith("[") ? argument.slice(1, -1).split(",")[0].trim() : argument;
      if (!transform || name !== "identity") names.push(name);
    }
    return names;
  }
  if (program === "AverageAffineTransform") {
    // AverageAffineTransform dim output [-R reference] {[-i] transform [weight]}...
    return argv.slice(3).filter((token, i, rest) => token !== "-R" && token !== "-i" && (rest[i - 1] === "-R" || !/^[-+]?[0-9.]+(e[-+]?[0-9]+)?$/i.test(token)));
  }
  return [];
}

// The kernel is built without C++ exception catching, so an ITK reader that fails on a missing
// file aborts it. For AverageImages, AverageAffineTransform and --apply, every input argv names
// must be among the inputs.
function checkInputsPresent(program, argv, inputs) {
  for (const name of inputNames(program, argv)) {
    if (name !== undefined && !Object.hasOwn(inputs, name)) throw new Error(`${program} reads ${JSON.stringify(name)}, which is not among the inputs.`);
  }
}

function checkName(name) {
  if (!/^[^/\0]+$/.test(name) || name === "." || name === "..") throw new Error(`Input names must be plain file names: ${JSON.stringify(name)}.`);
}

// ANTs aborts the kernel, rather than exiting non-zero, when an output prefix names a directory
// that does not exist, so that mistake is refused here with a clear message.
function checkOutputDirectories(FS, argv) {
  argv.forEach((token, index) => {
    if (token !== "--output" && token !== "-o") return;
    const value = argv[index + 1] ?? "";
    for (const piece of value.replace(/^\[|\]$/g, "").split(",")) {
      if (piece.startsWith("/") || piece.split("/").includes("..") || piece.includes("\0")) {
        throw new Error(`Output paths must stay inside the private run directory: ${JSON.stringify(piece)}.`);
      }
      const slash = piece.lastIndexOf("/");
      if (slash <= 0) continue;
      const parent = piece.slice(0, slash);
      let exists = false;
      try {
        exists = FS.isDir(FS.stat(parent).mode);
      } catch {
        exists = false;
      }
      if (!exists) throw new Error(`The output directory ${JSON.stringify(parent)} does not exist: give output names without a directory.`);
    }
  });
}

function failure(message, runLog, { aborted = false, cause } = {}) {
  const error = new Error(message, cause === undefined ? undefined : { cause });
  error.log = runLog;
  error.aborted = aborted;
  return error;
}

function removeTree(FS, path) {
  for (const name of FS.readdir(path)) {
    if (name === "." || name === "..") continue;
    const child = `${path}/${name}`;
    if (FS.isDir(FS.stat(child).mode)) removeTree(FS, child);
    else FS.unlink(child);
  }
  FS.rmdir(path);
}

export async function createHmcRegistration({ createModule, wasmBinary, onLog = () => {} }) {
  let lines = null;
  const log = (line) => {
    lines?.push(line);
    onLog(line);
  };
  const module = await createModule({ noInitialRun: true, wasmBinary });
  // Emscripten's callMain puts argv on the kernel's 64 KiB stack and never takes it off, as it
  // expects one call. Without stackRestore, each run left about 0.5 KiB (2 KiB for NiFreeze's
  // command lines) there, and a run aborted once the stack was full (#537).
  if (typeof module.stackSave !== "function" || typeof module.stackRestore !== "function") {
    throw new Error("The registration kernel does not export stackSave and stackRestore.");
  }
  // The ITK-Wasm toolchain's pre-js replaces print and printErr with functions that write to the
  // console and append to a string that grows with every run. While the synchronous kernel runs,
  // the console is routed to the run's log, and the strings are emptied before each run.
  function callMain(argv) {
    module.resetModuleStdout?.();
    module.resetModuleStderr?.();
    const { log: consoleLog, error: consoleError } = console;
    let forwarding = false;
    console.log = console.error = (...args) => {
      // An onLog that writes to the console reaches the real console, not this function again.
      if (forwarding) return consoleLog(...args);
      forwarding = true;
      try {
        log(args.join(" "));
      } finally {
        forwarding = false;
      }
    };
    const stack = module.stackSave();
    let code;
    let trap;
    let trapped = false;
    try {
      // callMain puts the program name in front of the array it is given, so it gets a copy.
      code = module.callMain([...argv]);
    } catch (error) {
      trap = error;
      trapped = true;
    }
    // The console comes back first, so a failing stackRestore cannot leave it redirected.
    console.log = consoleLog;
    console.error = consoleError;
    try {
      module.stackRestore(stack);
    } catch (error) {
      // After a trap the kernel is lost anyway, and the trap's error is the one to report.
      if (!trapped) throw error;
    }
    if (trapped) throw trap;
    return code;
  }
  let next = 0;
  let stopped = null;
  return {
    /**
     * Runs an ANTs program with `argv` inside a new directory that holds `inputs`, so argv names
     * files relative to it. A .nii.gz input is read as gzipped NIfTI, as ANTs picks the reader by
     * file name. argv[0] selects a program from PROGRAMS;
     * any other argv is antsRegistration's, without the program name.
     * @param {string[]} argv the program's arguments
     * @param {Record<string, Uint8Array|ArrayBuffer>} inputs file name to bytes
     * @returns {{ outputs: Record<string, Uint8Array>, log: string[] }} every file the run wrote
     * @throws {Error} with `log` (the run's log) and `aborted` (true when the kernel trapped; this
     * instance then refuses later runs and a new one must be loaded)
     */
    run(argv, inputs = {}) {
      checkArguments(argv);
      const program = programOf(argv);
      if (stopped) throw failure(`The registration kernel stopped (${stopped}); load a new one.`, [], { aborted: true });
      for (const name of Object.keys(inputs)) checkName(name);
      checkInputsPresent(program, argv, inputs);
      const dir = `/run-${next++}`;
      lines = [];
      const runLog = lines;
      module.FS.mkdir(dir);
      try {
        for (const [name, bytes] of Object.entries(inputs)) module.FS.writeFile(`${dir}/${name}`, bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes));
        module.FS.chdir(dir);
        if (program === "antsRegistration") checkOutputDirectories(module.FS, argv);
        let code;
        try {
          code = callMain(argv);
        } catch (error) {
          // The kernel trapped (for example on an input file that is not there). Its state is
          // lost, so this instance refuses later runs; the log holds the cause.
          stopped = error?.message ?? String(error);
          throw failure(`${program} aborted (${stopped}): ${runLog.slice(-5).join(" ")}`, runLog, { aborted: true, cause: error });
        }
        if (code !== 0) throw failure(`${program} failed (exit ${code}): ${runLog.slice(-5).join(" ")}`, runLog);
        const outputs = {};
        for (const name of module.FS.readdir(dir)) {
          if (name === "." || name === ".." || Object.hasOwn(inputs, name)) continue;
          const path = `${dir}/${name}`;
          if (module.FS.isFile(module.FS.stat(path).mode)) outputs[name] = module.FS.readFile(path);
        }
        return { outputs, log: runLog };
      } finally {
        lines = null;
        try {
          module.FS.chdir("/");
          removeTree(module.FS, dir);
        } catch {
          // An aborted kernel can leave the file system unusable; the run's own error is kept.
        }
      }
    },
    memoryBytes: () => module.HEAPU8?.byteLength ?? null,
    /** The kernel's stack pointer between runs: every run leaves it where it was. */
    stackPointer: () => module.stackSave(),
  };
}
