// LayNii v2.10.0 (LN2_LAYERS and LN2_PROFILE) in a single-threaded WebAssembly module.
// Runs without SharedArrayBuffer and enforces grid, affine, rim-label and memory checks before allocation.

// Measured worst-case peak memory (dense rim with equivol + thickness + curvature + equalCounts)
// is ~202 bytes/voxel (~1.6 GiB at 8M voxels, leaving ~400 MiB headroom under wasm32's 2048 MiB limit).
export const MAX_VOXELS = 8_000_000;
export const MIN_LAYERS = 2;
export const MAX_LAYERS = 100;
export const MIN_ITER_SMOOTH = 1;
export const MAX_ITER_SMOOTH = 2000;
export const GRID_TOLERANCE_MM = 1e-3;

export async function inflateNifti(bytes) {
  const input = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  if (input.length < 2 || input[0] !== 0x1f || input[1] !== 0x8b) {
    return input;
  }
  const stream = new Blob([input]).stream().pipeThrough(new DecompressionStream('gzip'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

function qformAffine(view, littleEndian, pixdim) {
  const qfac = view.getFloat32(76, littleEndian) < 0 ? -1 : 1;
  const b = view.getFloat32(256, littleEndian);
  const c = view.getFloat32(260, littleEndian);
  const d = view.getFloat32(264, littleEndian);
  const aSq = 1 - (b * b + c * c + d * d);
  const a = aSq > 0 ? Math.sqrt(aSq) : 0;
  const tx = view.getFloat32(268, littleEndian);
  const ty = view.getFloat32(272, littleEndian);
  const tz = view.getFloat32(276, littleEndian);
  const [dx, dy, dzRaw] = pixdim;
  const dz = dzRaw * qfac;
  return [
    (a * a + b * b - c * c - d * d) * dx,
    2 * (b * c - a * d) * dy,
    2 * (b * d + a * c) * dz,
    tx,
    2 * (b * c + a * d) * dx,
    (a * a + c * c - b * b - d * d) * dy,
    2 * (c * d - a * b) * dz,
    ty,
    2 * (b * d - a * c) * dx,
    2 * (c * d + a * b) * dy,
    (a * a + d * d - b * b - c * c) * dz,
    tz,
    0, 0, 0, 1,
  ];
}

function sformAffine(view, littleEndian) {
  const m = new Array(16).fill(0);
  for (let row = 0; row < 3; row++) {
    const base = 280 + row * 16;
    for (let col = 0; col < 4; col++) {
      m[row * 4 + col] = view.getFloat32(base + col * 4, littleEndian);
    }
  }
  m[15] = 1;
  return m;
}

/** NIfTI-1 header reader for pre-allocation dimension, scaling, pixdim, and affine checks. */
export function inspectNiftiHeader(bytes) {
  const view = bytes instanceof Uint8Array
    ? new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
    : new DataView(bytes);
  if (view.byteLength < 348) {
    throw new Error('Invalid NIfTI file: smaller than the 348-byte header.');
  }
  const sizeLE = view.getInt32(0, true);
  const sizeBE = view.getInt32(0, false);
  let littleEndian;
  if (sizeLE === 348) littleEndian = true;
  else if (sizeBE === 348) littleEndian = false;
  else throw new Error('Unsupported or malformed NIfTI-1 header.');

  const ndim = view.getInt16(40, littleEndian);
  const nx = view.getInt16(42, littleEndian);
  const ny = view.getInt16(44, littleEndian);
  const nz = view.getInt16(46, littleEndian);
  const dims = [nx, ny, nz];
  if (ndim < 2 || ndim > 7 || nx < 1 || ny < 1 || nz < 1) {
    throw new Error(`Invalid NIfTI dimensions (${dims.join(' × ')}).`);
  }
  // Rank-aware volume count: ignore stale dim[4..7] entries when ndim < 4.
  let frames = 1;
  for (let axis = 4; axis <= ndim; axis++) {
    const size = view.getInt16(40 + axis * 2, littleEndian);
    if (size > 1) frames *= size;
  }
  const pixdim = [
    Math.abs(view.getFloat32(80, littleEndian)),
    Math.abs(view.getFloat32(84, littleEndian)),
    Math.abs(view.getFloat32(88, littleEndian)),
  ];
  const datatype = view.getInt16(70, littleEndian);
  const bitpix = view.getInt16(72, littleEndian);
  const voxOffset = Math.max(348, Math.floor(view.getFloat32(108, littleEndian)));
  const sclSlope = view.getFloat32(112, littleEndian);
  const sclInter = view.getFloat32(116, littleEndian);
  const qformCode = view.getInt16(252, littleEndian);
  const sformCode = view.getInt16(254, littleEndian);
  const hasAffine = sformCode > 0 || qformCode > 0;
  const affine = sformCode > 0
    ? sformAffine(view, littleEndian)
    : qformCode > 0
      ? qformAffine(view, littleEndian, pixdim)
      : [pixdim[0], 0, 0, 0, 0, pixdim[1], 0, 0, 0, 0, pixdim[2], 0, 0, 0, 0, 1];
  const voxels = nx * ny * nz;
  return {
    ndim,
    dims,
    frames,
    voxels,
    pixdim,
    datatype,
    bitpix,
    voxOffset,
    sclSlope,
    sclInter,
    qformCode,
    sformCode,
    hasAffine,
    affine,
    littleEndian,
  };
}

const DATATYPE_INFO = new Map([
  [2, { bytes: 1, read: (v, o) => v.getUint8(o) }],
  [4, { bytes: 2, read: (v, o, le) => v.getInt16(o, le) }],
  [8, { bytes: 4, read: (v, o, le) => v.getInt32(o, le) }],
  [16, { bytes: 4, read: (v, o, le) => v.getFloat32(o, le) }],
  [64, { bytes: 8, read: (v, o, le) => v.getFloat64(o, le) }],
  [256, { bytes: 1, read: (v, o) => v.getInt8(o) }],
  [512, { bytes: 2, read: (v, o, le) => v.getUint16(o, le) }],
  [768, { bytes: 4, read: (v, o, le) => v.getUint32(o, le) }],
]);

/** Read raw stored scalar voxels WITHOUT applying scl_slope/scl_inter (matching LayNii's copy_nifti_as_int16). */
export function readRawNiftiVoxels(bytes, header = inspectNiftiHeader(bytes)) {
  const info = DATATYPE_INFO.get(header.datatype);
  if (!info) {
    throw new Error(`Unsupported NIfTI datatype (${header.datatype}). Use standard scalar integer or float NIfTI.`);
  }
  const view = bytes instanceof Uint8Array
    ? new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
    : new DataView(bytes);
  const totalVoxels = header.voxels * header.frames;
  const needed = header.voxOffset + totalVoxels * info.bytes;
  if (view.byteLength < needed) {
    throw new Error(`Truncated NIfTI data: expected at least ${needed} bytes, found ${view.byteLength}.`);
  }
  const out = new Float64Array(totalVoxels);
  const le = header.littleEndian;
  const stride = info.bytes;
  const read = info.read;
  for (let i = 0, offset = header.voxOffset; i < totalVoxels; i++, offset += stride) {
    out[i] = read(view, offset, le);
  }
  return out;
}

export function volumeBudgetRefusal(header, label = 'Image') {
  if (header.frames > 1) {
    return `${label} has ${header.frames} volumes. Choose a single 3D volume.`;
  }
  if (header.voxels > MAX_VOXELS) {
    const millions = (header.voxels / 1e6).toFixed(1);
    const limit = (MAX_VOXELS / 1e6).toFixed(0);
    return `${label} has ${millions} million voxels (${header.dims.join(' × ')}), above the browser limit of ${limit} million voxels. Crop to a region of interest first.`;
  }
  return null;
}

/** Refuse a rim whose NIfTI scaling would make scaled labels differ from the raw stored values LayNii reads. */
export function inspectRimHeader(header) {
  const slope = header.sclSlope;
  const inter = header.sclInter;
  const slopeOk = Number.isFinite(slope) && (slope === 0 || slope === 1);
  const interOk = Number.isFinite(inter) && inter === 0;
  if (!slopeOk || !interOk) {
    return {
      valid: false,
      reason: `Rim file has non-identity NIfTI intensity scaling (scl_slope=${slope}, scl_inter=${inter}). LayNii reads raw stored integers; resave the rim with slope 1 and intercept 0.`,
    };
  }
  return { valid: true };
}

export function gridMismatchRefusal(rimHeader, otherHeader, label = 'Signal image', tolerance = GRID_TOLERANCE_MM) {
  const [rx, ry, rz] = rimHeader.dims;
  const [ox, oy, oz] = otherHeader.dims;
  if (rx !== ox || ry !== oy || rz !== oz) {
    return `${label} (${ox} × ${oy} × ${oz}) does not match the rim grid (${rx} × ${ry} × ${rz}).`;
  }
  if (otherHeader.frames > 1) {
    return `${label} has ${otherHeader.frames} volumes; LN2_PROFILE expects a 3D map.`;
  }
  for (let i = 0; i < 3; i++) {
    if (Math.abs(rimHeader.pixdim[i] - otherHeader.pixdim[i]) > tolerance) {
      return `${label} voxel spacing (${otherHeader.pixdim.map((v) => v.toFixed(3)).join(' × ')} mm) does not match the rim (${rimHeader.pixdim.map((v) => v.toFixed(3)).join(' × ')} mm).`;
    }
  }
  if (rimHeader.hasAffine && otherHeader.hasAffine && rimHeader.affine && otherHeader.affine) {
    for (let i = 0; i < 12; i++) {
      if (Math.abs(rimHeader.affine[i] - otherHeader.affine[i]) > tolerance) {
        return `${label} orientation/affine does not match the rim grid (max difference exceeds ${tolerance} mm). Resample onto the rim space first.`;
      }
    }
  }
  return null;
}

/** Validate LayNii raw rim labels: integers in {0, 1, 2, 3} with outer (1), inner (2), and GM (3) present. */
export function inspectRimValues(values) {
  let csfBorder = 0;
  let wmBorder = 0;
  let gm = 0;
  for (let i = 0; i < values.length; i++) {
    const v = values[i];
    if (!Number.isFinite(v) || Math.round(v) !== v || v < 0 || v > 3) {
      return {
        valid: false,
        reason: 'Rim file must contain only raw integer labels 0 (background), 1 (outer CSF border), 2 (inner WM border), and 3 (gray matter).',
      };
    }
    if (v === 1) csfBorder++;
    else if (v === 2) wmBorder++;
    else if (v === 3) gm++;
  }
  if (csfBorder === 0 || wmBorder === 0) {
    return {
      valid: false,
      reason: 'Rim file must contain both outer gray matter border (1) and inner white matter border (2) voxels.',
    };
  }
  if (gm === 0) {
    return {
      valid: false,
      reason: 'Rim file has no gray matter (label 3) voxels. Supply a rim containing labels 1, 2, and 3.',
    };
  }
  return { valid: true, csfBorder, wmBorder, gm, total: csfBorder + wmBorder + gm };
}

/** Detect upstream LN2_PROFILE caveats on a signal volume (non-zero scl_inter or NaN/Inf voxels). */
export function inspectSignalCaveats(header, rawValues) {
  const warnings = [];
  const hasIntercept = Number.isFinite(header.sclInter) && header.sclInter !== 0;
  if (hasIntercept) {
    warnings.push(`Signal has scl_inter=${header.sclInter}; upstream LN2_PROFILE applies scl_slope only and ignores scl_inter.`);
  }
  let nonFiniteCount = 0;
  if (rawValues) {
    for (let i = 0; i < rawValues.length; i++) {
      if (!Number.isFinite(rawValues[i])) nonFiniteCount++;
    }
  }
  if (nonFiniteCount > 0) {
    warnings.push(`Signal contains ${nonFiniteCount.toLocaleString()} NaN/Inf voxels; upstream LN2_PROFILE treats them as 0.`);
  }
  return { sclInter: header.sclInter, nonFiniteCount, warnings };
}

function integerInRange(value, min, max, name) {
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw new Error(`${name} must be an integer between ${min} and ${max}.`);
  }
  return String(value);
}

/** Build the exact LN2_LAYERS command-line arguments. */
export function layersArguments({
  rim,
  output,
  nrLayers = 3,
  equivol = false,
  iterSmooth = 100,
  thickness = false,
  curvature = false,
  inclBorders = false,
  equalCounts = false,
  noSmooth = false,
}) {
  const args = [
    '-rim', rim,
    '-nr_layers', integerInRange(nrLayers, MIN_LAYERS, MAX_LAYERS, 'Number of layers'),
  ];
  if (equivol) {
    args.push('-equivol');
  }
  if (equivol || thickness || curvature) {
    args.push('-iter_smooth', integerInRange(iterSmooth, MIN_ITER_SMOOTH, MAX_ITER_SMOOTH, 'Smoothing iterations'));
  }
  if (thickness) args.push('-thickness');
  if (curvature) args.push('-curvature');
  if (inclBorders) args.push('-incl_borders');
  if (equalCounts) args.push('-equal_counts');
  if (noSmooth) args.push('-no_smooth');
  if (output) args.push('-output', output);
  return args;
}

/** Build the exact LN2_PROFILE command-line arguments. */
export function profileArguments({ input, layers, output, mask = null }) {
  const args = ['-input', input, '-layers', layers];
  if (mask) args.push('-mask', mask);
  if (output) args.push('-output', output);
  return args;
}

/** Parse LN2_PROFILE's whitespace-delimited output text into structured rows (handles scientific notation counts). */
export function parseProfileText(text) {
  const rows = [];
  for (const raw of String(text ?? '').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    const parts = line.split(/\s+/);
    if (parts.length < 4) continue;
    const layer = Number.parseInt(parts[0], 10);
    const mean = Number.parseFloat(parts[1]);
    const std = Number.parseFloat(parts[2]);
    const countNum = Number(parts[3]);
    const voxels = Math.round(countNum);
    if (
      Number.isFinite(layer)
      && Number.isFinite(mean)
      && Number.isFinite(std)
      && Number.isFinite(countNum)
      && voxels >= 0
    ) {
      rows.push({ layer, mean, std, voxels });
    }
  }
  return rows;
}

/** Compute exact integer voxel counts per layer label from the NIfTI layer volume (avoiding 6-sig-fig stream rounding). */
export function exactLayerCounts(layersBytes, maskBytes = null) {
  const layerVoxels = readRawNiftiVoxels(layersBytes);
  const maskVoxels = maskBytes ? readRawNiftiVoxels(maskBytes) : null;
  const counts = new Map();
  for (let i = 0; i < layerVoxels.length; i++) {
    if (maskVoxels && maskVoxels[i] === 0) continue;
    const label = Math.round(layerVoxels[i]);
    if (label > 0) {
      counts.set(label, (counts.get(label) ?? 0) + 1);
    }
  }
  return counts;
}

export function formatProfileCsv(rows) {
  const header = 'layer,mean,std,voxels';
  const body = rows.map((row) => `${row.layer},${row.mean},${row.std},${row.voxels}`);
  return `${[header, ...body].join('\n')}\n`;
}

function readOptionalFile(FS, path) {
  try {
    return FS.readFile(path);
  } catch {
    return null;
  }
}

function cleanupDir(FS, dir) {
  try {
    for (const name of FS.readdir(dir)) {
      if (name !== '.' && name !== '..') {
        FS.unlink(`${dir}/${name}`);
      }
    }
    FS.rmdir(dir);
  } catch {
    // Ignore cleanup errors after an abort.
  }
}

export async function createLayniiRunner({ createModule, wasmBinary, onLog = () => {} }) {
  const module = await createModule({
    noInitialRun: true,
    wasmBinary,
    print: (line) => onLog(String(line)),
    printErr: (line) => onLog(String(line)),
  });
  let next = 0;
  let aborted = null;

  function invoke(command, args) {
    if (aborted) {
      throw new Error(`LayNii module aborted earlier (${aborted}). Create a new runner.`);
    }
    const exitCode = globalThis.process?.exitCode;
    const stack = module.stackSave();
    let code;
    try {
      code = module.callMain([command, ...args]);
    } catch (error) {
      if (globalThis.process) {
        globalThis.process.exitCode = exitCode;
      }
      aborted = error instanceof Error ? error.message : `exception ${error}`;
      throw new Error(`LayNii ${command} aborted (${aborted}). See technical log.`, { cause: error });
    } finally {
      if (!aborted) module.stackRestore(stack);
    }
    if (code !== 0) {
      throw new Error(`LayNii ${command} failed (exit ${code}). See technical log.`);
    }
  }

  return {
    /**
     * Run LN2_LAYERS on a 3D rim NIfTI volume, and optionally LN2_PROFILE on a matched 3D signal volume.
     * All returned NIfTI buffers are uncompressed NIfTI-1 Uint8Arrays copied out of MEMFS.
     */
    async runLayersAndProfile({
      rim,
      signal = null,
      mask = null,
      nrLayers = 3,
      equivol = false,
      iterSmooth = 100,
      thickness = false,
      curvature = false,
      inclBorders = false,
      equalCounts = false,
      noSmooth = false,
      profileSource = null,
    }) {
      const rimBytes = await inflateNifti(rim);
      const rimHeader = inspectNiftiHeader(rimBytes);
      const rimRefusal = volumeBudgetRefusal(rimHeader, 'Rim image');
      if (rimRefusal) throw new Error(rimRefusal);
      const rimHeaderCheck = inspectRimHeader(rimHeader);
      if (!rimHeaderCheck.valid) throw new Error(rimHeaderCheck.reason);
      const rimCheck = inspectRimValues(readRawNiftiVoxels(rimBytes, rimHeader));
      if (!rimCheck.valid) throw new Error(rimCheck.reason);

      let signalBytes = null;
      let signalCaveats = { sclInter: 0, nonFiniteCount: 0, warnings: [] };
      if (signal) {
        signalBytes = await inflateNifti(signal);
        const signalHeader = inspectNiftiHeader(signalBytes);
        const sigRefusal = gridMismatchRefusal(rimHeader, signalHeader, 'Signal image');
        if (sigRefusal) throw new Error(sigRefusal);
        signalCaveats = inspectSignalCaveats(signalHeader, readRawNiftiVoxels(signalBytes, signalHeader));
      }

      let maskBytes = null;
      if (mask) {
        maskBytes = await inflateNifti(mask);
        const maskHeader = inspectNiftiHeader(maskBytes);
        const maskRefusal = gridMismatchRefusal(rimHeader, maskHeader, 'ROI mask');
        if (maskRefusal) throw new Error(maskRefusal);
      }

      const dir = `/laynii-${next++}`;
      const rimPath = `${dir}/rim.nii`;
      const outBase = `${dir}/out.nii`;
      const args = layersArguments({
        rim: rimPath,
        output: outBase,
        nrLayers,
        equivol,
        iterSmooth,
        thickness,
        curvature,
        inclBorders,
        equalCounts,
        noSmooth,
      });

      module.FS.mkdir(dir);
      try {
        module.FS.writeFile(rimPath, rimBytes);
        invoke('LN2_LAYERS', args);

        const layersEquidist = readOptionalFile(module.FS, `${dir}/out_layers_equidist.nii`);
        const metricEquidist = readOptionalFile(module.FS, `${dir}/out_metric_equidist.nii`);
        const midGmEquidist = readOptionalFile(module.FS, `${dir}/out_midGM_equidist.nii`);
        if (!layersEquidist || !metricEquidist) {
          throw new Error('LN2_LAYERS completed without writing expected equidistant outputs.');
        }

        const layersEquivol = equivol ? readOptionalFile(module.FS, `${dir}/out_layers_equivol.nii`) : null;
        const metricEquivol = equivol ? readOptionalFile(module.FS, `${dir}/out_metric_equivol.nii`) : null;
        const midGmEquivol = equivol ? readOptionalFile(module.FS, `${dir}/out_midGM_equivol.nii`) : null;
        const layersEquicount = equalCounts ? readOptionalFile(module.FS, `${dir}/out_layers_equicount.nii`) : null;
        const thicknessMap = thickness ? readOptionalFile(module.FS, `${dir}/out_thickness.nii`) : null;
        const curvatureMap = curvature ? readOptionalFile(module.FS, `${dir}/out_curvature.nii`) : null;

        let profile = null;
        if (signalBytes) {
          // Default to equivolume when enabled, otherwise equidistant (never hijack to equicount unexpectedly).
          const chosenSource = profileSource ?? (equivol ? 'equivol' : 'equidist');
          let layerPath = `${dir}/out_layers_equidist.nii`;
          let profileLayersBytes = layersEquidist;
          let effectiveSource = 'equidist';
          if (chosenSource === 'equivol' && layersEquivol) {
            layerPath = `${dir}/out_layers_equivol.nii`;
            profileLayersBytes = layersEquivol;
            effectiveSource = 'equivol';
          } else if (chosenSource === 'equicount' && layersEquicount) {
            layerPath = `${dir}/out_layers_equicount.nii`;
            profileLayersBytes = layersEquicount;
            effectiveSource = 'equicount';
          }
          const signalPath = `${dir}/signal.nii`;
          const maskPath = maskBytes ? `${dir}/mask.nii` : null;
          const profilePath = `${dir}/profile.txt`;
          module.FS.writeFile(signalPath, signalBytes);
          if (maskBytes) module.FS.writeFile(maskPath, maskBytes);
          invoke('LN2_PROFILE', profileArguments({
            input: signalPath,
            layers: layerPath,
            mask: maskPath,
            output: profilePath,
          }));
          const textBytes = readOptionalFile(module.FS, profilePath);
          if (!textBytes) {
            throw new Error('LN2_PROFILE completed without writing profile output.');
          }
          const text = new TextDecoder().decode(textBytes);
          const exactCounts = exactLayerCounts(profileLayersBytes, maskBytes);
          const rows = parseProfileText(text).map((row) => ({
            ...row,
            voxels: exactCounts.get(row.layer) ?? row.voxels,
          }));
          profile = {
            layerSource: effectiveSource,
            rows,
            text,
            csv: formatProfileCsv(rows),
            warnings: signalCaveats.warnings,
          };
        }

        return {
          layersEquidist,
          metricEquidist,
          midGmEquidist,
          layersEquivol,
          metricEquivol,
          midGmEquivol,
          layersEquicount,
          thickness: thicknessMap,
          curvature: curvatureMap,
          profile,
        };
      } finally {
        if (!aborted) cleanupDir(module.FS, dir);
      }
    },

    /** Run LN2_PROFILE directly on a signal volume and an existing integer layers volume. */
    async runProfile({ signal, layers, mask = null }) {
      const signalBytes = await inflateNifti(signal);
      const layersBytes = await inflateNifti(layers);
      const signalHeader = inspectNiftiHeader(signalBytes);
      const layersHeader = inspectNiftiHeader(layersBytes);
      const budget = volumeBudgetRefusal(layersHeader, 'Layers image');
      if (budget) throw new Error(budget);
      const mismatch = gridMismatchRefusal(layersHeader, signalHeader, 'Signal image');
      if (mismatch) throw new Error(mismatch);
      const signalCaveats = inspectSignalCaveats(signalHeader, readRawNiftiVoxels(signalBytes, signalHeader));

      let maskBytes = null;
      if (mask) {
        maskBytes = await inflateNifti(mask);
        const maskHeader = inspectNiftiHeader(maskBytes);
        const maskMismatch = gridMismatchRefusal(layersHeader, maskHeader, 'ROI mask');
        if (maskMismatch) throw new Error(maskMismatch);
      }

      const dir = `/laynii-${next++}`;
      const signalPath = `${dir}/signal.nii`;
      const layersPath = `${dir}/layers.nii`;
      const maskPath = maskBytes ? `${dir}/mask.nii` : null;
      const profilePath = `${dir}/profile.txt`;
      module.FS.mkdir(dir);
      try {
        module.FS.writeFile(signalPath, signalBytes);
        module.FS.writeFile(layersPath, layersBytes);
        if (maskBytes) module.FS.writeFile(maskPath, maskBytes);
        invoke('LN2_PROFILE', profileArguments({
          input: signalPath,
          layers: layersPath,
          mask: maskPath,
          output: profilePath,
        }));
        const textBytes = readOptionalFile(module.FS, profilePath);
        if (!textBytes) {
          throw new Error('LN2_PROFILE completed without writing profile output.');
        }
        const text = new TextDecoder().decode(textBytes);
        const exactCounts = exactLayerCounts(layersBytes, maskBytes);
        const rows = parseProfileText(text).map((row) => ({
          ...row,
          voxels: exactCounts.get(row.layer) ?? row.voxels,
        }));
        return { rows, text, csv: formatProfileCsv(rows), warnings: signalCaveats.warnings };
      } finally {
        if (!aborted) cleanupDir(module.FS, dir);
      }
    },

    memoryBytes: () => module.HEAPU8?.byteLength ?? null,
  };
}
