// Node command-line interface for @neurodesk/calcium-imaging.
// Runs the exact same motion correction, ROI extraction, ΔF/F trace, and OASIS deconvolution
// pipeline as the Calcium imaging web application.
import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, readdir, rename, rm, rmdir, stat, writeFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { InputTooLargeError } from "@neurodesk/webapp-components/file-io/input-limits";
import { imagejDescription, inspectTiffStack, readTiffStack, writeTiffStack } from "@neurodesk/webapp-components/file-io/tiff";
import packageJson from "../package.json" with { type: "json" };
import { MAX_MOVIE_BYTES, checkMovie, provenance, readSettings } from "./config.js";
import { DEFAULTS, analyse, borderMargin, motionCorrect } from "./core/pipeline.js";
import { outputStem, roisCsv, shiftSvg, shiftsCsv, toInputType, traceSvg, tracesCsv } from "./outputs.js";

const OUTPUT_LOCK_FILE = ".neurodesk-calcium-imaging.lock";
const MAX_INPUT_FILE_BYTES = 1024 ** 3;

/** Validates CLI flags before reading the movie or claiming OUTPUT_DIR. */
export function parseCliOptions(values = {}) {
  const frameRate = values["frame-rate"];
  // Validate everything except missing frameRate (which may come from TIFF metadata) right now.
  const raw = {
    motion: values.motion ?? DEFAULTS.motion,
    normalization: values.normalization ?? DEFAULTS.normalization,
    deconvolution: values["no-deconvolution"] ? false : true,
    frameRate: frameRate ?? 10,
    maxShift: values["max-shift"],
    upsample: values.upsample,
    templatePasses: values["template-passes"],
    patchSize: values["patch-size"],
    patchOverlap: values["patch-overlap"],
    maxDeviation: values["max-deviation"],
    diameter: values.diameter,
    seedZ: values["seed-z"],
    neuropilCoefficient: values["neuropil-coefficient"],
    baselineWindow: values["baseline-window"],
    baselinePercentile: values["baseline-percentile"],
  };
  const validated = readSettings(raw);
  return {
    settings: validated,
    explicitFrameRate: frameRate !== undefined,
    writeRegistered: !values["no-registered"],
  };
}

/**
 * Exclusively claims `outputDir` with an O_EXCL lock file, cleaning up the lock AND any newly
 * created directory on ANY failure (including write/readdir errors or non-empty directory).
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

async function readMovieFile(inputPath) {
  const resolved = resolve(inputPath);
  const info = await stat(resolved);
  if (!info.isFile()) throw new Error(`Input '${inputPath}' is not a regular file.`);
  if (info.size === 0) throw new Error(`Input '${inputPath}' is empty.`);
  if (info.size > MAX_INPUT_FILE_BYTES) {
    throw new Error(`Input '${inputPath}' exceeds the 1 GiB file size limit.`);
  }
  const name = basename(resolved);
  if (!/\.tiff?$/i.test(name)) {
    throw new Error(`${name} is not a TIFF (.tif, .tiff or .ome.tif) movie.`);
  }
  const bytes = await readFile(resolved);
  const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
  const tiffInfo = await inspectTiffStack(buffer);
  checkMovie(tiffInfo, name);
  let stack;
  try {
    stack = await readTiffStack(buffer, { Type: Float32Array, maxBytes: MAX_MOVIE_BYTES });
  } catch (error) {
    if (!(error instanceof InputTooLargeError)) throw error;
    throw new Error(`This movie needs ${(error.actualBytes / 1e9).toFixed(2)} GB as float32; the limit is ${(MAX_MOVIE_BYTES / 1e9).toFixed(1)} GB.`);
  }
  for (let i = 0; i < stack.data.length; i++) {
    if (!Number.isFinite(stack.data[i])) {
      throw new Error(`${name} contains NaN or infinite pixel values; clean non-finite pixels first.`);
    }
  }
  return {
    name,
    size: info.size,
    movie: stack.data,
    dims: {
      width: stack.width,
      height: stack.height,
      frames: stack.pages,
      dtype: stack.dtype,
      pixelSize: stack.metadata.pixelSize,
      frameInterval: stack.metadata.frameInterval,
      metadataKind: stack.metadata.kind,
    },
  };
}

function encodeTiff(data, { width, height, frames, frameRate, pixelSize }) {
  const description = imagejDescription({
    frames,
    frameInterval: frames > 1 ? 1 / frameRate : null,
    unit: pixelSize?.x ? "micron" : null,
  });
  return writeTiffStack({
    width,
    height,
    data,
    description,
    pixelSize: pixelSize?.x && pixelSize?.y ? pixelSize : null,
  });
}

/** Runs motion correction, ROI extraction, ΔF/F traces and OASIS deconvolution on a TIFF movie. */
export async function runCalciumImaging({
  input,
  outputDir,
  options = {},
  onLog = () => {},
  renameFn = rename,
} = {}) {
  if (typeof input !== "string" || !input.trim()) {
    throw new Error("Input movie path is required.");
  }
  const parsed = parseCliOptions(options);
  const loaded = await readMovieFile(input);

  let frameRate;
  if (parsed.explicitFrameRate) {
    frameRate = parsed.settings.frameRate;
  } else if (loaded.dims.frameInterval && loaded.dims.frameInterval > 0) {
    frameRate = 1 / loaded.dims.frameInterval;
    // Validate metadata-derived frame rate against the same bounds
    readSettings({ ...parsed.settings, frameRate });
  } else {
    throw new Error("Frame rate (Hz) is not recorded in the TIFF metadata; pass --frame-rate N.");
  }
  const settings = { ...parsed.settings, frameRate };

  const claim = await claimOutputDirectory(outputDir);
  let succeeded = false;
  try {
    const started = performance.now();
    onLog(`Motion correction (${settings.motion}) on ${loaded.dims.frames} frames (${loaded.dims.width} × ${loaded.dims.height})…`);
    const regStart = performance.now();
    const registration = motionCorrect(loaded.movie, loaded.dims, settings);
    const registrationSeconds = Number(((performance.now() - regStart) / 1000).toFixed(2));
    const margin = borderMargin(registration.shifts, registration.patches);

    onLog(`Extracting ROIs and ΔF/F traces (border margin ${margin} px)…`);
    const analysisStart = performance.now();
    const analysis = analyse(
      registration.registered,
      { ...loaded.dims, frameRate: settings.frameRate },
      settings,
      null,
      { margin },
    );
    const analysisSeconds = Number(((performance.now() - analysisStart) / 1000).toFixed(2));
    const totalSeconds = Number(((performance.now() - started) / 1000).toFixed(2));

    const stem = outputStem(loaded.name);
    const encoder = new TextEncoder();
    const record = provenance({
      input: { name: loaded.name, size: loaded.size },
      settings,
      dims: loaded.dims,
      roiSource: "detected",
      cells: analysis.cells,
      detection: analysis.detection,
      timings: { registrationSeconds, analysisSeconds, totalSeconds },
      version: packageJson.version,
    });

    const outputs = [];
    if (parsed.writeRegistered) {
      outputs.push({
        name: `${stem}_registered.tif`,
        bytes: encodeTiff(toInputType(registration.registered, loaded.dims.dtype), {
          ...loaded.dims,
          frameRate: settings.frameRate,
        }),
      });
    }
    outputs.push(
      { name: `${stem}_shifts.csv`, bytes: encoder.encode(shiftsCsv(registration, settings.frameRate)) },
      { name: `${stem}_mean.tif`, bytes: encodeTiff(analysis.mean, { ...loaded.dims, frames: 1, frameRate: settings.frameRate }) },
      { name: `${stem}_max.tif`, bytes: encodeTiff(analysis.max, { ...loaded.dims, frames: 1, frameRate: settings.frameRate }) },
      { name: `${stem}_correlation.tif`, bytes: encodeTiff(analysis.correlation, { ...loaded.dims, frames: 1, frameRate: settings.frameRate }) },
      { name: `${stem}_rois.tif`, bytes: encodeTiff(analysis.labels, { ...loaded.dims, frames: 1, frameRate: settings.frameRate }) },
      { name: `${stem}_traces.csv`, bytes: encoder.encode(tracesCsv(analysis.cells, loaded.dims.frames, settings.frameRate)) },
      { name: `${stem}_rois.csv`, bytes: encoder.encode(roisCsv(analysis.cells)) },
      { name: `${stem}_traces.svg`, bytes: encoder.encode(traceSvg(analysis.cells, loaded.dims.frames, settings.frameRate)) },
      { name: `${stem}_shifts.svg`, bytes: encoder.encode(shiftSvg(registration.shifts, settings.frameRate)) },
      { name: `${stem}_provenance.json`, bytes: encoder.encode(`${JSON.stringify(record, null, 2)}\n`) },
    );

    const written = await writeStagedOutputs(claim.directory, outputs, { renameFn });
    succeeded = true;
    return {
      outputDir: claim.directory,
      files: written,
      roiCount: analysis.cells.length,
      provenance: record,
    };
  } finally {
    await claim.release({ removeDirIfEmpty: !succeeded });
  }
}

/** Verifies the runtime with a synthetic shifted movie containing a firing neuron. */
export async function checkInstallation({ cacheDir } = {}) {
  if (cacheDir !== undefined && (typeof cacheDir !== "string" || !cacheDir.trim())) {
    throw new Error("cacheDir must be a non-empty path.");
  }
  const width = 48;
  const height = 48;
  const frames = 24;
  const plane = width * height;
  const movie = new Float32Array(frames * plane);
  for (let f = 0; f < frames; f++) {
    const dy = f >= 12 ? 2 : 0;
    const dx = f >= 12 ? -1 : 0;
    const spike = f === 8 || f === 16 ? 250 : 0;
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const sx = x - dx;
        const sy = y - dy;
        const cell = Math.exp(-((sx - 24) ** 2 + (sy - 24) ** 2) / 18);
        const landmark = 60 * Math.exp(-((sx - 12) ** 2 + (sy - 14) ** 2) / 12);
        movie[f * plane + y * width + x] = 100 + landmark + (80 + spike) * cell;
      }
    }
  }
  const reg = motionCorrect(movie, { width, height, frames }, { ...DEFAULTS, maxShift: 6, templatePasses: 2 });
  const shiftDiffY = Math.abs((reg.shifts[16][0] - reg.shifts[4][0]) - (-2));
  const shiftDiffX = Math.abs((reg.shifts[16][1] - reg.shifts[4][1]) - 1);
  if (!(shiftDiffY < 0.25 && shiftDiffX < 0.25)) {
    throw new Error(`Calcium imaging self-check registration failed (dy err ${shiftDiffY.toFixed(2)}, dx err ${shiftDiffX.toFixed(2)}).`);
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
      shiftErrorPx: { y: Number(shiftDiffY.toFixed(4)), x: Number(shiftDiffX.toFixed(4)) },
    },
  };
}
