// Node command-line interface for @neurodesk/neuromorph.
// Reads SWC reconstructions (single file, multiple files, or a directory), repairs & validates them,
// computes NeuroM-compatible morphometrics, Sholl intersections, and bifurcation tables.
import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, readdir, rename, rm, rmdir, stat, writeFile } from "node:fs/promises";
import { basename, join, relative, resolve } from "node:path";
import packageJson from "../package.json" with { type: "json" };
import { analyse, buildMorphology } from "./morph/morphometrics.js";
import { bifurcationsCsv, morphometricsCsv, shollCsv, summary } from "./morph/outputs.js";
import { readSwc, writeSwc } from "./morph/swc.js";
import { repairedName, stem } from "./names.js";

const OUTPUT_LOCK_FILE = ".neurodesk-neuromorph.lock";
const MAX_SWC_FILE_BYTES = 128 * 1024 * 1024;
const collator = new Intl.Collator("en", { numeric: true, sensitivity: "base" });

/** Validates CLI flags before touching input files or output directories. */
export function parseCliOptions(values = {}) {
  let shollStep = 10;
  if (values["sholl-step"] !== undefined) {
    const trimmed = String(values["sholl-step"]).trim();
    if (!trimmed) throw new Error("Option --sholl-step requires a non-empty value.");
    shollStep = Number(trimmed);
    if (!Number.isFinite(shollStep) || shollStep <= 0 || shollStep > 1e6) {
      throw new Error(`Option --sholl-step must be a positive finite number <= 1000000, got '${values["sholl-step"]}'.`);
    }
  }
  const repair = values["no-repair"] ? false : true;
  return { shollStep, repair };
}

/**
 * Exclusively claims `outputDir` with an O_EXCL lock file, cleaning up the lock AND any newly
 * created directory on ANY error (including write/readdir errors or non-empty directory).
 */
export async function claimOutputDirectory(outputDir) {
  if (typeof outputDir !== "string" || !outputDir.trim()) {
    throw new Error("Output directory must be a non-empty path.");
  }
  const directory = resolve(outputDir);
  let createdDir = false;
  try {
    const info = await stat(directory);
    if (!info.isDirectory()) {
      throw new Error(`Output path '${directory}' exists and is not a directory.`);
    }
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    await mkdir(directory, { recursive: true });
    createdDir = true;
  }

  const lockPath = join(directory, OUTPUT_LOCK_FILE);
  let handle = null;
  let lockAcquired = false;
  try {
    handle = await open(lockPath, "wx");
    lockAcquired = true;
    await handle.writeFile(`${process.pid}\n${new Date().toISOString()}\n`);
    await handle.close();
    handle = null;

    const entries = await readdir(directory);
    if (entries.length !== 1 || entries[0] !== OUTPUT_LOCK_FILE) {
      throw new Error(`Output directory ${directory} is not empty. Choose a new or empty directory.`);
    }
  } catch (error) {
    await handle?.close().catch(() => {});
    if (lockAcquired) {
      await rm(lockPath, { force: true }).catch(() => {});
    }
    if (createdDir) {
      await rmdir(directory).catch(() => {});
    }
    if (error.code === "EEXIST") {
      throw new Error(`Output directory ${directory} is already in use by another run or not empty. Choose a new or empty directory.`);
    }
    throw error;
  }

  return {
    directory,
    createdDir,
    async release({ removeDirIfEmpty = false } = {}) {
      await rm(lockPath, { force: true }).catch(() => {});
      if (removeDirIfEmpty && createdDir) {
        await rmdir(directory).catch(() => {});
      }
    },
  };
}

/**
 * Stages every output file to a `.partial` path first, then renames all files into place.
 * Rolls back already-renamed outputs and removes all `.partial` files if any step fails.
 */
export async function writeStagedOutputs(directory, files, { renameFn = rename } = {}) {
  const runId = randomUUID().slice(0, 8);
  const staged = [];
  const renamed = [];
  try {
    for (const { name, bytes } of files) {
      const partialPath = join(directory, `.${name}.${runId}.partial`);
      const finalPath = join(directory, name);
      await writeFile(partialPath, bytes, { flag: "wx" });
      staged.push({ name, partialPath, finalPath });
    }
    for (const item of staged) {
      await renameFn(item.partialPath, item.finalPath);
      renamed.push(item.finalPath);
    }
    return staged.map((item) => item.name);
  } catch (error) {
    for (const item of staged) {
      await rm(item.partialPath, { force: true }).catch(() => {});
    }
    for (const finalPath of renamed) {
      await rm(finalPath, { force: true }).catch(() => {});
    }
    throw error;
  }
}

async function collectSwcFromDir(rootDir, currentDir = rootDir) {
  const entries = await readdir(currentDir, { withFileTypes: true });
  const results = [];
  for (const entry of entries) {
    const fullPath = join(currentDir, entry.name);
    if (entry.isDirectory()) {
      results.push(...(await collectSwcFromDir(rootDir, fullPath)));
    } else if (entry.isFile() && /\.swc$/i.test(entry.name)) {
      const rel = relative(rootDir, fullPath).replaceAll("\\", "/");
      results.push({ path: fullPath, id: rel });
    }
  }
  return results;
}

async function resolveInputs(inputs) {
  if (!Array.isArray(inputs) || inputs.length === 0) {
    throw new Error("Provide at least one .swc file or a directory of .swc files.");
  }
  const items = [];
  const seenIds = new Map();
  const uniqueId = (base) => {
    const count = seenIds.get(base) ?? 0;
    seenIds.set(base, count + 1);
    return count === 0 ? base : `${base} (${count + 1})`;
  };

  for (const input of inputs) {
    if (typeof input !== "string" || !input.trim()) {
      throw new Error("Input path must be non-empty.");
    }
    const resolved = resolve(input);
    const info = await stat(resolved);
    if (info.isDirectory()) {
      const found = (await collectSwcFromDir(resolved)).sort((a, b) => collator.compare(a.id, b.id));
      for (const item of found) items.push({ path: item.path, id: uniqueId(item.id) });
    } else if (info.isFile()) {
      if (!/\.swc$/i.test(resolved)) {
        throw new Error(`Input '${input}' is not an .swc file.`);
      }
      if (info.size === 0) throw new Error(`Input '${input}' is empty.`);
      if (info.size > MAX_SWC_FILE_BYTES) {
        throw new Error(`Input '${input}' exceeds the 128 MiB SWC size limit.`);
      }
      items.push({ path: resolved, id: uniqueId(basename(resolved)) });
    } else {
      throw new Error(`Input '${input}' is neither a regular file nor a directory.`);
    }
  }
  if (items.length === 0) {
    throw new Error("No .swc files found in the provided input(s).");
  }
  return items;
}

/** Measures one or more SWC neuron reconstructions and writes CSV tables, repaired SWCs, and provenance JSON. */
export async function runNeuromorph({
  inputs,
  outputDir,
  options = {},
  onLog = () => {},
  renameFn = rename,
} = {}) {
  const { shollStep, repair } = parseCliOptions(options);
  const resolvedInputs = await resolveInputs(inputs);

  const claim = await claimOutputDirectory(outputDir);
  let succeeded = false;
  try {
    const started = performance.now();
    const neurons = [];
    for (const item of resolvedInputs) {
      const info = await stat(item.path);
      if (info.size === 0) throw new Error(`${item.id} is empty.`);
      if (info.size > MAX_SWC_FILE_BYTES) throw new Error(`${item.id} exceeds the 128 MiB SWC size limit.`);
      const text = await readFile(item.path, "utf8");
      const { samples, issues, header } = readSwc(text, { repair });
      const morphology = buildMorphology(samples);
      if (!morphology.neurites.length) {
        throw new Error(`${item.id}: No neurites to measure.`);
      }
      const analysis = analyse(morphology, shollStep, { unknownZeroRadii: repair });
      neurons.push({ id: item.id, samples, issues, header, analysis });
      onLog(`${item.id}: ${summary(analysis).neurites} neurites, ${summary(analysis).totalLengthUm.toFixed(1)} µm`);
    }

    const measuredNeurons = neurons.map(({ id, analysis }) => ({ name: id, analysis }));
    const prefix = neurons.length === 1 ? stem(basename(neurons[0].id)) : "neuromorph";
    const encoder = new TextEncoder();
    const outputs = [
      { name: `${prefix}_morphometrics.csv`, bytes: encoder.encode(morphometricsCsv(measuredNeurons)) },
      { name: `${prefix}_sholl.csv`, bytes: encoder.encode(shollCsv(measuredNeurons)) },
      { name: `${prefix}_bifurcations.csv`, bytes: encoder.encode(bifurcationsCsv(measuredNeurons)) },
    ];

    const taken = new Set();
    for (const neuron of neurons) {
      if (!neuron.issues.some((issue) => issue.repaired)) continue;
      const header = [...neuron.header, `Repaired by NeuroMorph ${packageJson.version} from ${neuron.id}`];
      outputs.push({
        name: repairedName(neuron.id, taken),
        bytes: encoder.encode(writeSwc(neuron.samples, header)),
      });
    }

    const seconds = Number(((performance.now() - started) / 1000).toFixed(3));
    const provenance = {
      app: "neuromorph",
      version: packageJson.version,
      settings: { shollStep, repair },
      neurons: neurons.map((neuron) => ({
        id: neuron.id,
        samples: neuron.samples.length,
        issues: neuron.issues,
        summary: summary(neuron.analysis),
      })),
      files: outputs.map((file) => file.name),
      seconds,
    };
    outputs.push({ name: `${prefix}_provenance.json`, bytes: encoder.encode(`${JSON.stringify(provenance, null, 2)}\n`) });

    const written = await writeStagedOutputs(claim.directory, outputs, { renameFn });
    succeeded = true;
    return {
      outputDir: claim.directory,
      files: written,
      neuronCount: neurons.length,
      provenance,
    };
  } finally {
    await claim.release({ removeDirIfEmpty: !succeeded });
  }
}

/** Verifies the runtime with a synthetic Y-shaped neuron reconstruction. */
export async function checkInstallation({ cacheDir } = {}) {
  if (cacheDir !== undefined && (typeof cacheDir !== "string" || !cacheDir.trim())) {
    throw new Error("cacheDir must be a non-empty path.");
  }
  const swc = [
    "1 1 0 0 0 5 -1",
    "2 3 0 0 0 1 1",
    "3 3 10 0 0 1 2",
    "4 3 20 10 0 0.8 3",
    "5 3 20 -10 0 0.8 3",
  ].join("\n");
  const { samples } = readSwc(swc, { repair: true });
  const morphology = buildMorphology(samples);
  const analysis = analyse(morphology, 10, { unknownZeroRadii: true });
  const stats = summary(analysis);
  if (stats.bifurcations !== 1 || stats.terminals !== 2) {
    throw new Error("NeuroMorph self-check failed: synthetic morphology metrics mismatch.");
  }
  return {
    ok: true,
    platform: process.platform,
    arch: process.arch,
    node: process.version,
    executable: process.execPath,
    version: packageJson.version,
    ...(cacheDir !== undefined ? { cacheDir: resolve(cacheDir) } : {}),
    phantom: {
      bifurcations: stats.bifurcations,
      terminals: stats.terminals,
      totalLengthUm: Number(stats.totalLengthUm.toFixed(3)),
    },
  };
}
