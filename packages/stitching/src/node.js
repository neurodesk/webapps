// Node command-line interface for @neurodesk/stitching.
// Runs the exact same pairwise phase-correlation, global translation optimisation and
// linear-blending fusion pipeline as the Tile stitching web application.
import { randomUUID } from "node:crypto";
import { closeSync, lstatSync, mkdirSync, openSync, readdirSync, renameSync, rmdirSync, unlinkSync, writeFileSync } from "node:fs";
import { link, lstat, readFile, readdir, rename, rm, rmdir, stat, unlink, writeFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { InputTooLargeError } from "@neurodesk/webapp-components/file-io/input-limits";
import { inspectTiffStack, readTiffStack } from "@neurodesk/webapp-components/file-io/tiff";
import packageJson from "../package.json" with { type: "json" };
import { DEFAULT_VALUES, LAYOUTS, MAX_FUSED_PIXELS, MAX_TILE_BYTES, guessGrid, readSettings } from "./config.js";
import { fuseTiles, fusedGeometry, toSampleType } from "./core/fusion.js";
import { checkFusionMemory, checkSolverMemory } from "./core/memory.js";
import { stitch } from "./core/pipeline.js";
import {
  GRID_STARTS,
  GRID_TYPES,
  gridPositions,
  parseTileConfiguration,
  positionsFromConfiguration,
  positionsFromStage,
} from "./core/tile-layout.js";
import { fusedTiff, linksCsv, outputStem, provenance, registeredConfiguration, summarise } from "./outputs.js";

export const OUTPUT_LOCK_FILE = ".neurodesk-cli.lock";
const LINK_FALLBACK_CODES = new Set(["ENOTSUP", "EOPNOTSUPP", "EPERM", "ENOSYS", "EXDEV"]);
const collator = new Intl.Collator("en", { numeric: true, sensitivity: "base" });
const ALLOWED_OPTION_KEYS = new Set([
  "layout",
  "layout-file",
  "columns",
  "rows",
  "overlap",
  "grid-type",
  "grid-start",
  "peaks",
  "threshold",
  "max-ratio",
  "max-absolute",
  "offline",
]);

function parseNumericInput(raw, flag) {
  if (raw === undefined) return undefined;
  if (typeof raw !== "number" && typeof raw !== "string") {
    throw new Error(`Option --${flag} must be a finite number, got ${typeof raw}.`);
  }
  const trimmed = String(raw).trim();
  if (!trimmed) throw new Error(`Option --${flag} requires a non-empty value.`);
  return trimmed;
}

/** Validates CLI flags before touching input files or claiming OUTPUT_DIR. */
export function parseCliOptions(values = {}) {
  if (values === null || typeof values !== "object" || Array.isArray(values)) {
    throw new TypeError("Options must be a plain object.");
  }
  const proto = Object.getPrototypeOf(values);
  if (proto !== Object.prototype && proto !== null) {
    throw new TypeError("Options must be a plain object.");
  }
  for (const key of Object.keys(values)) {
    if (!ALLOWED_OPTION_KEYS.has(key)) {
      throw new Error(`Unknown option '--${key}'.`);
    }
  }
  if (values.offline !== undefined && typeof values.offline !== "boolean") {
    throw new Error(`Option --offline must be a boolean, got ${typeof values.offline}.`);
  }
  const explicitLayout = values.layout;
  if (explicitLayout !== undefined && (typeof explicitLayout !== "string" || !Object.hasOwn(LAYOUTS, explicitLayout))) {
    throw new Error(`Option --layout must be one of ${Object.keys(LAYOUTS).join(", ")}.`);
  }
  const layoutFile = values["layout-file"];
  if (layoutFile !== undefined && (typeof layoutFile !== "string" || !layoutFile.trim())) {
    throw new Error("Option --layout-file requires a non-empty path.");
  }
  if (explicitLayout && explicitLayout !== "file" && layoutFile) {
    throw new Error("Option --layout-file cannot be combined with --layout other than 'file'.");
  }
  const gridType = values["grid-type"] === undefined ? DEFAULT_VALUES.gridType : values["grid-type"];
  if (typeof gridType !== "string" || !Object.hasOwn(GRID_TYPES, gridType)) {
    throw new Error(`Option --grid-type must be one of ${Object.keys(GRID_TYPES).join(", ")}.`);
  }
  const gridStart = values["grid-start"] === undefined ? DEFAULT_VALUES.gridStart : values["grid-start"];
  if (typeof gridStart !== "string" || !Object.hasOwn(GRID_STARTS, gridStart)) {
    throw new Error(`Option --grid-start must be one of ${Object.keys(GRID_STARTS).join(", ")}.`);
  }

  const columnsRaw = parseNumericInput(values.columns, "columns");
  const rowsRaw = parseNumericInput(values.rows, "rows");
  const overlapRaw = parseNumericInput(values.overlap, "overlap");
  const peaksRaw = parseNumericInput(values.peaks, "peaks");
  const thresholdRaw = parseNumericInput(values.threshold, "threshold");
  const maxRatioRaw = parseNumericInput(values["max-ratio"], "max-ratio");
  const maxAbsoluteRaw = parseNumericInput(values["max-absolute"], "max-absolute");

  // Validate numeric bounds eagerly using readSettings on a dummy grid layout
  const probe = readSettings({
    layout: "grid",
    columns: columnsRaw === undefined ? DEFAULT_VALUES.columns : columnsRaw,
    rows: rowsRaw === undefined ? DEFAULT_VALUES.rows : rowsRaw,
    overlap: overlapRaw === undefined ? DEFAULT_VALUES.overlap : overlapRaw,
    gridType,
    gridStart,
    peaks: peaksRaw === undefined ? DEFAULT_VALUES.peaks : peaksRaw,
    threshold: thresholdRaw === undefined ? DEFAULT_VALUES.threshold : thresholdRaw,
    maxRatio: maxRatioRaw === undefined ? DEFAULT_VALUES.maxRatio : maxRatioRaw,
    maxAbsolute: maxAbsoluteRaw === undefined ? DEFAULT_VALUES.maxAbsolute : maxAbsoluteRaw,
  });

  return {
    explicitLayout,
    layoutFile: layoutFile ? resolve(layoutFile) : null,
    explicitColumns: columnsRaw !== undefined ? probe.grid.columns : null,
    explicitRows: rowsRaw !== undefined ? probe.grid.rows : null,
    overlapPercent: overlapRaw !== undefined ? Number(overlapRaw) : DEFAULT_VALUES.overlap,
    gridType,
    gridStart,
    peaks: probe.pairwise.peaks,
    threshold: probe.global.threshold,
    maxRatio: probe.global.maxRatio,
    maxAbsolute: probe.global.maxAbsolute,
  };
}

function rollbackPublishSync(pub) {
  let clean = true;
  if (pub.pendingRename) {
    const { finalPath, dev, ino } = pub.pendingRename;
    try {
      const info = lstatSync(finalPath);
      if (info.isFile() && !info.isSymbolicLink() && info.dev === dev && info.ino === ino) {
        unlinkSync(finalPath);
      }
    } catch (error) {
      if (error.code !== "ENOENT") clean = false;
    }
  }
  for (const item of [...pub.published].reverse()) {
    try {
      const info = lstatSync(item.finalPath);
      if (info.isFile() && !info.isSymbolicLink() && info.dev === item.dev && info.ino === item.ino) {
        unlinkSync(item.finalPath);
      }
    } catch (error) {
      if (error.code !== "ENOENT") clean = false;
    }
  }
  for (const backup of [...pub.backups].reverse()) {
    try {
      renameSync(backup.backupPath, backup.targetPath);
    } catch (error) {
      if (error.code !== "ENOENT") clean = false;
    }
  }
  for (const item of pub.staged) {
    try {
      const info = lstatSync(item.partialPath);
      if (info.isFile() && !info.isSymbolicLink()) {
        unlinkSync(item.partialPath);
      }
    } catch (error) {
      if (error.code !== "ENOENT") clean = false;
    }
  }
  return clean;
}

/**
 * Exclusively claims `outputDir` with the shared `.neurodesk-cli.lock` O_EXCL lock file,
 * registering SIGINT/SIGTERM handlers BEFORE creating the directory/lock, using synchronous
 * lock acquisition (zero async window), rolling back mid-publication on signal, and keeping
 * `.neurodesk-cli.lock` on disk if rollback fails.
 */
export async function claimOutputDirectory(outputDir) {
  if (typeof outputDir !== "string" || !outputDir.trim()) {
    throw new Error("Output directory must be a non-empty path.");
  }
  const directory = resolve(outputDir);
  const lockPath = join(directory, OUTPUT_LOCK_FILE);
  let createdDir = false;
  let lockOwned = false;
  let signalsRegistered = false;
  let activePublish = null;
  let rollbackFailed = false;

  const unregisterSignals = () => {
    if (!signalsRegistered) return;
    signalsRegistered = false;
    process.off("SIGINT", onSigInt);
    process.off("SIGTERM", onSigTerm);
  };

  const handleSignal = (signal) => {
    unregisterSignals();
    let canReleaseLock = !rollbackFailed;
    if (activePublish) {
      if (!activePublish.committed) {
        canReleaseLock = rollbackPublishSync(activePublish) && canReleaseLock;
      } else {
        for (const backup of activePublish.backups) {
          try {
            unlinkSync(backup.backupPath);
          } catch {
            // ignore
          }
        }
      }
    }
    if (canReleaseLock && lockOwned) {
      lockOwned = false;
      try {
        unlinkSync(lockPath);
      } catch {
        // ignore
      }
      if (createdDir && (!activePublish || !activePublish.committed)) {
        try {
          rmdirSync(directory);
        } catch {
          // leave non-empty dir intact
        }
      }
    }
    if (process.platform === "win32") {
      process.exit(signal === "SIGINT" ? 130 : 143);
    }
    process.kill(process.pid, signal);
  };
  const onSigInt = () => handleSignal("SIGINT");
  const onSigTerm = () => handleSignal("SIGTERM");

  process.on("SIGINT", onSigInt);
  process.on("SIGTERM", onSigTerm);
  signalsRegistered = true;

  let fd = null;
  try {
    try {
      const info = lstatSync(directory);
      if (info.isSymbolicLink()) {
        throw new Error(`Output path '${directory}' must not be a symbolic link.`);
      }
      if (!info.isDirectory()) {
        throw new Error(`Output path '${directory}' exists and is not a directory.`);
      }
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
      mkdirSync(directory, { recursive: true });
      createdDir = true;
      const createdInfo = lstatSync(directory);
      if (createdInfo.isSymbolicLink() || !createdInfo.isDirectory()) {
        throw new Error(`Output path '${directory}' is not a regular directory.`);
      }
    }

    fd = openSync(lockPath, "wx");
    lockOwned = true;
    writeFileSync(fd, `${process.pid}\n${new Date().toISOString()}\n`);
    closeSync(fd);
    fd = null;

    const entries = readdirSync(directory);
    if (entries.length !== 1 || entries[0] !== OUTPUT_LOCK_FILE) {
      throw new Error(`Output directory ${directory} is not empty. Choose a new or empty directory.`);
    }
  } catch (error) {
    if (fd !== null) {
      try {
        closeSync(fd);
      } catch {
        // ignore
      }
    }
    unregisterSignals();
    if (lockOwned) {
      lockOwned = false;
      try {
        unlinkSync(lockPath);
      } catch {
        // ignore
      }
    }
    if (createdDir) {
      try {
        rmdirSync(directory);
      } catch {
        // ignore
      }
    }
    if (error.code === "EEXIST") {
      throw new Error(`Output directory ${directory} is already in use by another run or not empty. Choose a new or empty directory.`);
    }
    throw error;
  }

  return {
    directory,
    createdDir,
    attachPublish(state) {
      activePublish = state;
    },
    detachPublish() {
      activePublish = null;
    },
    markRollbackFailed() {
      rollbackFailed = true;
    },
    async release({ removeDirIfEmpty = false } = {}) {
      unregisterSignals();
      if (rollbackFailed) return;
      if (lockOwned) {
        lockOwned = false;
        await rm(lockPath, { force: true }).catch(() => {});
      }
      if (removeDirIfEmpty && createdDir) {
        await rmdir(directory).catch(() => {});
      }
    },
  };
}

/**
 * Stages every output file to a `.partial` path first (registering each path BEFORE `writeFile`),
 * then atomically publishes via hard link (`link` + `unlink`, failing with `EEXIST` without
 * overwriting if a destination already exists, falling back to `lstat`+`rename` only when the
 * filesystem does not support hard links). Rolls back ONLY files this run created (verified by
 * `lstat` + `dev`/`ino`), and marks the lock on incomplete rollback.
 */
export async function writeStagedOutputs(
  directory,
  files,
  { claim = null, linkFn = link, renameFn = rename, writeFileFn = writeFile } = {},
) {
  const runId = randomUUID().slice(0, 8);
  const pub = {
    staged: [],
    published: [],
    backups: [],
    pendingBackup: null,
    pendingRename: null,
    committed: false,
  };
  const seenNames = new Set();
  claim?.attachPublish?.(pub);
  try {
    for (const { name, bytes } of files) {
      if (typeof name !== "string" || !name || name.includes("/") || name.includes("\\") || name === "." || name === "..") {
        throw new Error(`Invalid output filename '${name}'.`);
      }
      const lower = name.toLowerCase();
      if (seenNames.has(lower)) {
        throw new Error(`Duplicate output filename '${name}'.`);
      }
      seenNames.add(lower);

      const partialPath = join(directory, `.${name}.${runId}.partial`);
      const finalPath = join(directory, name);
      const item = { name, partialPath, finalPath, dev: null, ino: null };
      pub.staged.push(item);
      await writeFileFn(partialPath, bytes, { flag: "wx" });
      const stagedInfo = await lstat(partialPath);
      item.dev = stagedInfo.dev;
      item.ino = stagedInfo.ino;
    }
    for (const item of pub.staged) {
      pub.pendingRename = { finalPath: item.finalPath, dev: item.dev, ino: item.ino };
      try {
        await linkFn(item.partialPath, item.finalPath);
        pub.published.push({ finalPath: item.finalPath, dev: item.dev, ino: item.ino });
        pub.pendingRename = null;
        await unlink(item.partialPath);
      } catch (error) {
        if (error.code === "EEXIST") {
          pub.pendingRename = null;
          throw new Error(`Refusing to overwrite existing output '${item.name}'.`, { cause: error });
        }
        if (!LINK_FALLBACK_CODES.has(error.code)) {
          throw error;
        }
        const existing = await lstat(item.finalPath).catch((err) => {
          if (err.code === "ENOENT") return null;
          throw err;
        });
        if (existing) {
          pub.pendingRename = null;
          throw new Error(`Refusing to overwrite existing output '${item.name}'.`);
        }
        await renameFn(item.partialPath, item.finalPath);
        pub.published.push({ finalPath: item.finalPath, dev: item.dev, ino: item.ino });
        pub.pendingRename = null;
      }
    }
    pub.committed = true;
    for (const backup of pub.backups) {
      await unlink(backup.backupPath).catch(() => {});
    }
    return pub.staged.map((item) => item.name);
  } catch (error) {
    const rollbackClean = rollbackPublishSync(pub);
    if (!rollbackClean) {
      claim?.markRollbackFailed?.();
    }
    throw error;
  } finally {
    claim?.detachPublish?.();
  }
}

function checkTileMetadata(name, info) {
  const { metadata } = info;
  if (metadata.images > 1) throw new Error(`${name} holds ${metadata.images} OME images; save each tile as its own file.`);
  if (metadata.sizeC > 1) throw new Error(`${name} has ${metadata.sizeC} channels; stitch one channel at a time.`);
  if (metadata.kind !== "baseline" && metadata.sizeT > 1) {
    throw new Error(`${name} is a time series (${metadata.sizeT} time points); save one time point per tile.`);
  }
}

function checkFinite(name, data) {
  if (!(data instanceof Float32Array || data instanceof Float64Array)) return;
  for (let i = 0; i < data.length; i++) {
    if (!Number.isFinite(data[i])) {
      throw new Error(`${name} contains NaN or infinite values; replace them (for example with 0) before stitching.`);
    }
  }
}

async function resolveTileInputs(inputs, explicitLayoutFile) {
  if (!Array.isArray(inputs) || inputs.length === 0) {
    throw new Error("Provide a tile folder or at least two TIFF tile files.");
  }
  const tilePaths = [];
  let discoveredLayoutFile = null;

  for (const input of inputs) {
    if (typeof input !== "string" || !input.trim()) {
      throw new Error("Input path must be non-empty.");
    }
    const resolved = resolve(input);
    const info = await stat(resolved);
    if (info.isDirectory()) {
      const entries = await readdir(resolved, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isFile()) continue;
        const full = join(resolved, entry.name);
        if (/\.tiff?$/i.test(entry.name)) {
          tilePaths.push(full);
        } else if (!explicitLayoutFile && !discoveredLayoutFile && /\.txt$/i.test(entry.name)) {
          discoveredLayoutFile = full;
        }
      }
    } else if (info.isFile()) {
      if (/\.tiff?$/i.test(resolved)) {
        tilePaths.push(resolved);
      } else if (/\.txt$/i.test(resolved)) {
        if (!explicitLayoutFile && !discoveredLayoutFile) discoveredLayoutFile = resolved;
      } else {
        throw new Error(`Input '${input}' is neither a TIFF tile nor a TileConfiguration .txt file.`);
      }
    } else {
      throw new Error(`Input '${input}' is neither a regular file nor a directory.`);
    }
  }

  tilePaths.sort((a, b) => collator.compare(basename(a), basename(b)));
  if (tilePaths.length < 2) {
    throw new Error(`Stitching needs at least two TIFF tiles (found ${tilePaths.length}).`);
  }
  return { tilePaths, layoutFilePath: explicitLayoutFile ?? discoveredLayoutFile };
}

async function decodeTiles(tilePaths) {
  let encodedTotal = 0;
  const rawFiles = [];
  for (const path of tilePaths) {
    const info = await stat(path);
    if (!info.isFile() || info.size === 0) throw new Error(`Tile '${path}' is missing or empty.`);
    encodedTotal += info.size;
    if (encodedTotal > MAX_TILE_BYTES) {
      throw new InputTooLargeError(encodedTotal, MAX_TILE_BYTES, { subject: "The source tiles" });
    }
    const bytes = await readFile(path);
    rawFiles.push({
      name: basename(path),
      buffer: bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
    });
  }

  let decodedTotal = 0;
  for (const { name, buffer } of rawFiles) {
    const info = await inspectTiffStack(buffer);
    checkTileMetadata(name, info);
    decodedTotal += info.pages * info.width * info.height * info.bytesPerSample;
  }
  if (decodedTotal > MAX_TILE_BYTES) {
    throw new InputTooLargeError(decodedTotal, MAX_TILE_BYTES, { subject: "The decoded tiles" });
  }

  const tiles = [];
  for (const { name, buffer } of rawFiles) {
    const stack = await readTiffStack(buffer, { maxBytes: MAX_TILE_BYTES });
    checkFinite(name, stack.data);
    const shape = stack.pages > 1 ? [stack.width, stack.height, stack.pages] : [stack.width, stack.height];
    tiles.push({
      name,
      shape,
      dtype: stack.dtype,
      data: stack.data,
      pixelSize: stack.metadata.pixelSize,
      stagePosition: stack.metadata.stagePosition,
      kind: stack.metadata.kind,
    });
  }

  const first = tiles[0];
  for (const tile of tiles.slice(1)) {
    if (tile.shape.length !== first.shape.length) {
      throw new Error(`Tile '${tile.name}' has ${tile.shape.length} dimensions, expected ${first.shape.length}.`);
    }
    if (tile.dtype !== first.dtype) {
      throw new Error(`Tile '${tile.name}' is ${tile.dtype}, expected ${first.dtype}.`);
    }
  }
  return tiles;
}

/** Stitches a grid/collection of microscopy TIFF tiles into a blended mosaic. */
export async function runStitching({
  inputs,
  outputDir,
  options = {},
  onLog = () => {},
  renameFn = rename,
} = {}) {
  const parsed = parseCliOptions(options);
  const { tilePaths, layoutFilePath } = await resolveTileInputs(inputs, parsed.layoutFile);

  let layout = parsed.explicitLayout;
  if (!layout) {
    layout = layoutFilePath ? "file" : null;
  }

  const tiles = await decodeTiles(tilePaths);
  const dims = tiles[0].shape.length;
  const names = tiles.map((tile) => tile.name);

  if (!layout) {
    layout = tiles.every((tile) => tile.stagePosition) ? "stage" : "grid";
  }

  const guessed = guessGrid(tiles.length);
  const settings = readSettings({
    layout,
    columns: parsed.explicitColumns ?? guessed.columns,
    rows: parsed.explicitRows ?? guessed.rows,
    overlap: parsed.overlapPercent,
    gridType: parsed.gridType,
    gridStart: parsed.gridStart,
    peaks: parsed.peaks,
    threshold: parsed.threshold,
    maxRatio: parsed.maxRatio,
    maxAbsolute: parsed.maxAbsolute,
  });

  let approximate;
  let layoutName;
  if (settings.layout === "file") {
    if (!layoutFilePath) {
      throw new Error("Layout 'file' requires a TileConfiguration.txt via --layout-file or in the input folder.");
    }
    const text = await readFile(layoutFilePath, "utf8");
    const configuration = parseTileConfiguration(text);
    approximate = positionsFromConfiguration(configuration, names, dims);
    layoutName = basename(layoutFilePath);
  } else if (settings.layout === "stage") {
    approximate = positionsFromStage(
      tiles.map((tile) => tile.stagePosition),
      tiles.map((tile) => tile.pixelSize),
      dims,
    );
  } else {
    approximate = gridPositions({ count: tiles.length, ...settings.grid, shape: tiles[0].shape });
  }

  const shapes = tiles.map((tile) => tile.shape);
  const checkFusedBounds = (positions) => {
    const { shape } = fusedGeometry(shapes, positions);
    const pixels = shape.reduce((a, b) => a * b, 1);
    if (pixels > MAX_FUSED_PIXELS) {
      throw new Error(`The fused image would be ${shape.join(" × ")} pixels, more than the ${MAX_FUSED_PIXELS / 1e6} million pixel limit.`);
    }
    checkFusionMemory({ shapes, dtype: tiles[0].dtype, shape, shared: false });
  };
  checkFusedBounds(approximate);

  const claim = await claimOutputDirectory(outputDir);
  let succeeded = false;
  try {
    const started = performance.now();
    onLog(`Registering ${tiles.length} tiles (${settings.layout} layout, ${dims}D)…`);
    const regStart = performance.now();
    const result = stitch(tiles, approximate, { pairwise: settings.pairwise, global: settings.global });
    const registrationSeconds = Number(((performance.now() - regStart) / 1000).toFixed(2));
    const summary = summarise(result);
    onLog(`Pairs: ${summary.used}/${summary.links} used; mean residual ${summary.meanResidual.toFixed(3)} px, max ${summary.maxResidual.toFixed(3)} px`);

    checkFusedBounds(result.positions);
    onLog("Fusing mosaic with linear blending…");
    const fusedRaw = fuseTiles(tiles, result.positions);
    const fusedData = toSampleType(fusedRaw.data, tiles[0].dtype);
    const pixelSize = tiles[0].pixelSize;
    const tiffBytes = fusedTiff({ data: fusedData, shape: fusedRaw.shape, pixelSize });
    const totalSeconds = Number(((performance.now() - started) / 1000).toFixed(2));

    const stem = `${outputStem(names)}_stitched`;
    const record = provenance({
      app: { id: "stitching", version: packageJson.version },
      names,
      dims,
      dtype: tiles[0].dtype,
      pixelSize,
      settings: { ...settings, layoutFile: layoutName },
      approximate,
      result,
      fused: { shape: fusedRaw.shape, origin: fusedRaw.origin },
      timings: { registrationSeconds, totalSeconds },
    });

    const encoder = new TextEncoder();
    const outputs = [
      { name: `${stem}.tif`, bytes: tiffBytes },
      { name: "TileConfiguration.registered.txt", bytes: encoder.encode(registeredConfiguration(names, result.positions)) },
      { name: `${stem}_pairs.csv`, bytes: encoder.encode(linksCsv(names, result.links)) },
      { name: `${stem}_provenance.json`, bytes: encoder.encode(`${JSON.stringify(record, null, 2)}\n`) },
    ];

    const written = await writeStagedOutputs(claim.directory, outputs, { claim, renameFn });
    succeeded = true;
    return {
      outputDir: claim.directory,
      files: written,
      fusedShape: fusedRaw.shape,
      summary,
      provenance: record,
    };
  } finally {
    await claim.release({ removeDirIfEmpty: !succeeded });
  }
}

/** Verifies the runtime with a synthetic 2-tile shifted pair. */
export async function checkInstallation({ cacheDir } = {}) {
  if (cacheDir !== undefined && (typeof cacheDir !== "string" || !cacheDir.trim())) {
    throw new Error("cacheDir must be a non-empty path.");
  }
  const w = 64;
  const h = 48;
  const fullW = 110;
  const scene = new Float32Array(fullW * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < fullW; x++) {
      scene[y * fullW + x] =
        100 +
        60 * Math.sin(x / 4.2) * Math.cos(y / 3.7) +
        40 * Math.exp(-((x - 52) ** 2 + (y - 24) ** 2) / 36);
    }
  }
  const crop = (ox) => {
    const out = new Float32Array(w * h);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) out[y * w + x] = scene[y * fullW + (x + ox)];
    }
    return { shape: [w, h], dtype: "float32", data: out };
  };
  const tiles = [crop(0), crop(44)];
  const approx = [[0, 0], [48, 0]];
  checkSolverMemory({ shapes: tiles.map((t) => t.shape), dtype: "float32", pairs: [{ i: 0, j: 1, approximateOffset: [48, 0] }] });
  const result = stitch(tiles, approx);
  const recoveredX = result.positions[1][0] - result.positions[0][0];
  const errPx = Math.abs(recoveredX - 44);
  if (!(errPx < 0.25)) {
    throw new Error(`Stitching self-check failed (recovered x=${recoveredX.toFixed(3)}, expected 44).`);
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
      recoveredOffsetX: Number(recoveredX.toFixed(4)),
      errorPx: Number(errPx.toFixed(4)),
    },
  };
}
