// The one module that talks to the SamSrf engine (@neurodesk/samsrf). Everything
// else in the app reaches the engine through these four exports, and the worker
// pool (pool.js, worker.js) is their only caller apart from tests.
//
// An analysis is shardable by unit (a vertex of the ROI, or of the whole surface
// without one): createJob reads the inputs once, runShard fits units
// [start, end) and can run in any worker, and mergeShards turns the shards into
// SamSrf's map set and the GIfTI files samsrf_export_giis writes.
//
// Each worker holds one WebAssembly instance. createJob builds the `createJob`
// spec of @neurodesk/samsrf and prepares the analysis once to validate it and
// count its vertices; every worker prepares its own copy from that spec (for
// prf this generates the search space) the first time it runs a shard.

import {
  createJob as createSamsrfJob,
  exportGiis,
  exportConvention,
  init,
  polarAndEccentricity,
  readApertures,
  readBensonTemplate,
  readFreeSurferCurv,
  readFreeSurferLabel,
  readFreeSurferSurface,
  readGiftiRun,
  readGiftiSurface,
  RunAccumulator,
} from "@neurodesk/samsrf";
import { resolveHemisphere } from "@neurodesk/samsrf/inputs";

/** @typedef {import('./models.js').Analysis} Analysis */
/** @typedef {import('./inputs.js').SurfaceRole} SurfaceRole */

/**
 * A file as the worker receives it.
 * @typedef {{ name: string, bytes: Uint8Array }} NamedBytes
 */

/**
 * @typedef {{
 *   analysis: Analysis,
 *   model: Record<string, unknown>,   // SamSrf model JSON (Models/Json/*.json shape); Hrf may be "Inf"
 *   runs: NamedBytes[],               // GIfTI time series, one per run, in run order
 *   apertures: NamedBytes | null,     // SamSrf .mat, NIfTI or animated GIF (prf and rc)
 *   roi: NamedBytes | null,           // FreeSurfer .label restricting the analysis
 *   surfaces: Partial<Record<SurfaceRole, NamedBytes>>, // FreeSurfer surfaces, curv and area, or a GIfTI mesh
 *   template: NamedBytes | null,      // cf: template map GIfTI (polar, eccentricity, ROI arrays)
 *   seed: NamedBytes | null,          // cf: seed region .label
 *   normalise: boolean,               // detrend and z-score each run (SamSrfAnalysis -norm)
 *   average: boolean,                 // average runs (true) or concatenate them (SamSrfAnalysis -aver)
 * }} JobInputs
 */

/**
 * Structured-cloneable; the pool copies it into every worker.
 * @typedef {{
 *   analysis: Analysis,
 *   units: number,          // shardable units; runShard takes 0 <= start < end <= units
 *   vertexCount: number,    // vertices of the full surface, the length of every map
 *   outName: string,        // SamSrf's OutFile, e.g. lh_pRF_Gaussian
 *   summary: string[],      // lines for the analysis log (inputs, model, preprocessing)
 *   spec: object,           // the @neurodesk/samsrf createJob spec (typed arrays)
 *   prepared: number,       // Date.now() when the inputs were read, for the fit's timing
 * }} Job
 */

/** Structured-cloneable partial result of runShard (Job.run's bytes); only mergeShards reads it. @typedef {Uint8Array} Shard */

/**
 * @typedef {{
 *   outName: string,
 *   vertexCount: number,
 *   maps: { name: string, values: Float32Array }[], // Srf.Values rows, then Polar and Eccentricity when x0/y0 exist
 *   files: (NamedBytes & { map?: string })[],       // the GIfTI files samsrf_export_giis writes; map names the maps entry each holds
 *   summary: string[],                              // lines for the analysis log
 * }} Result
 */

export const ENGINE = Object.freeze({ stub: false, name: "SamSrf (@neurodesk/samsrf)" });

/**
 * @param {JobInputs} inputs
 * @param {(done: number, total: number) => void} [onProgress] search-space points generated (prf)
 * @returns {Promise<Job>}
 */
export async function createJob(inputs, onProgress) {
  if (!inputs.runs.length) throw new Error("Add at least one run.");
  const convention = exportConvention(inputs.model.Export_Convention);
  const hemisphere = resolveHemisphere([
    ...inputs.runs.map(file => file.name),
    inputs.roi?.name,
    inputs.seed?.name,
    inputs.template?.name,
    ...Object.values(inputs.surfaces).map(file => file.name),
  ], { required: inputs.analysis === "cf" });
  await init();
  const started = Date.now();
  const roi = inputs.roi ? readLabel(inputs.roi) : null;
  const seed = inputs.analysis === "cf" && inputs.seed ? readLabel(inputs.seed) : null;
  const keep = roi ? Uint32Array.from(new Set([...roi, ...(seed ?? [])])).sort() : null;
  const precision = inputs.model.Data_Precision === "single" ? "single" : "double";
  const data = preprocess(inputs.runs, keep, { ...inputs, precision });
  const spec = {
    kind: inputs.analysis,
    model: JSON.stringify(inputs.model),
    data: { volumes: data.volumes, vertices: data.kept ?? allVertices(data.totalVertices), courses: data.data },
    roi: roi ?? undefined,
    noiseCeiling: data.noiseCeiling ?? undefined,
    globalSignal: data.globalSignal ?? undefined,
    totalVertices: data.totalVertices,
  };
  if (inputs.analysis === "cf") {
    if (!inputs.template || !seed || !inputs.surfaces.area) throw new Error("Connective fields need a template map, a seed label and a surface area file.");
    spec.seed = { vertices: seed, template: fromFile(inputs.template, (bytes) => readBensonTemplate(bytes, hemisphere === "rh" ? "rh" : "lh")) };
    spec.area = fromFile(inputs.surfaces.area, readFreeSurferCurv);
    if (Number(inputs.model.Smoothing) > 0) spec.surface = readSurface(inputs.surfaces);
  } else {
    if (!inputs.apertures) throw new Error("Add the stimulus apertures.");
    spec.apertures = fromFile(inputs.apertures, (bytes) => {
      const apertures = readApertures(bytes, apertureFormat(inputs.apertures.name));
      try {
        return apertures.serialize();
      } finally {
        apertures.free();
      }
    });
  }
  const read = Date.now();

  let gridPoints = 0;
  const job = createSamsrfJob(spec, (done, total) => {
    gridPoints = total;
    onProgress?.(done, total);
  });
  const prepared = Date.now();
  // The first worker keeps this instance for its own shards.
  const appJob = {
    analysis: inputs.analysis,
    units: job.vertexCount,
    vertexCount: data.totalVertices,
    outName: `${hemisphere}_${job.modelName}${job.outSuffix}`,
    exportConvention: convention,
    summary: [
      `${inputs.runs.length} run${inputs.runs.length === 1 ? "" : "s"} of ${data.volumes} volumes on ${data.totalVertices} vertices${inputs.runs.length > 1 ? `, ${inputs.average ? "averaged" : "concatenated"}` : ""}${inputs.normalise ? ", detrended and z-scored" : ""} (${seconds(read - started)})`,
      roi ? `ROI ${inputs.roi.name}: ${roi.length} vertices` : "No ROI: every vertex is analysed",
      ...(seed ? [`Seed ${inputs.seed.name}: ${seed.length} vertices`] : []),
      `Analysis ${job.modelName}${job.outSuffix}: ${job.vertexCount} vertices, maps ${job.values.join(", ")}`,
      `Map export: ${convention}; data precision: ${precision === "single" ? "MATLAB single" : "double"}`,
      ...(gridPoints ? [`Search space: ${gridPoints} grid points per worker (${seconds(prepared - read)})`] : []),
    ],
    spec,
    prepared,
  };
  cached = { key: appJob, job };
  return appJob;
}

/**
 * @param {Job} job
 * @param {number} start
 * @param {number} end
 * @param {(done: number) => void} onProgress units finished in this shard so far
 * @returns {Promise<Shard>}
 */
export async function runShard(job, start, end, onProgress) {
  const handle = await jobHandle(job);
  return handle.run(start, end, (done) => onProgress(done));
}

/** @param {Job} job @param {Shard[]} shards @returns {Promise<Result>} */
export async function mergeShards(job, shards) {
  const handle = await jobHandle(job);
  const { maps } = handle.merge(shards);
  const vertices = maps.vertices;
  const rows = maps.values.map((name, row) => ({ name, values: Float32Array.from(maps.data.subarray(row * vertices, (row + 1) * vertices)) }));
  const derived = polarAndEccentricity(maps, job.exportConvention);
  if (derived) {
    rows.push({ name: "Polar", values: Float32Array.from(derived.polar) }, { name: "Eccentricity", values: Float32Array.from(derived.eccentricity) });
  }
  const mapOfFile = new Map(rows.map(({ name }) => [giiName(job.outName, name), name]));
  mapOfFile.set(`${job.outName}_pol.gii`, "Polar");
  mapOfFile.set(`${job.outName}_ecc.gii`, "Eccentricity");
  const files = exportGiis(maps, job.outName, null, job.exportConvention).map(({ name, bytes }) => ({ name, bytes, map: mapOfFile.get(name) }));
  return {
    outName: job.outName,
    vertexCount: vertices,
    maps: rows,
    files,
    summary: [`Analysed ${job.units} vertices in ${seconds(Date.now() - job.prepared)}`],
  };
}

// ---- Inputs ----

/** The wasm Job of this worker, built from the job's spec the first time a worker needs it. */
let cached = null;

async function jobHandle(job) {
  if (cached?.key === job) return cached.job;
  await init();
  cached?.job.free();
  cached = null;
  cached = { key: job, job: createSamsrfJob(job.spec) };
  return cached.job;
}

/** Wrap a reader's error with the file name. */
function fromFile(file, read) {
  try {
    return read(file.bytes);
  } catch (error) {
    throw new Error(`${file.name}: ${error.message}`, { cause: error });
  }
}

function readLabel(file) {
  return fromFile(file, readFreeSurferLabel).vertices;
}

/** Combine the runs as samsrf_gii2srf does, one run in WebAssembly memory at a time. */
function preprocess(runs, keep, { normalise, average, precision }) {
  let accumulator = null;
  try {
    for (const file of runs) {
      const run = fromFile(file, readGiftiRun);
      try {
        accumulator ??= new RunAccumulator(run.vertices, keep, {
          normalise: normalise ? "zscore" : "none",
          combine: average ? "average" : "concatenate",
          noiseCeiling: true,
          globalSignal: true,
          precision,
        });
        fromFile(file, () => accumulator.pushRun(run));
      } finally {
        run.free();
      }
    }
    return accumulator.finish();
  } finally {
    accumulator?.free();
  }
}

function allVertices(count) {
  return Uint32Array.from({ length: count }, (_, index) => index);
}

function readSurface(surfaces) {
  const file = surfaces.white ?? surfaces.mesh;
  if (!file) throw new Error("Smoothing needs the white surface.");
  const mesh = fromFile(file, /\.gii$/i.test(file.name) ? readGiftiSurface : readFreeSurferSurface);
  if (mesh.faceSize !== 3) throw new Error(`${file.name}: smoothing needs a triangle mesh.`);
  return { vertices: mesh.vertices, faces: mesh.faces };
}

function apertureFormat(name) {
  if (/\.mat$/i.test(name)) return "mat";
  if (/\.gif$/i.test(name)) return "gif";
  if (/\.nii(\.gz)?$/i.test(name)) return "nii";
  throw new Error(`${name}: apertures must be a .mat, NIfTI or GIF file.`);
}

/** The file name samsrf_export_giis gives a map row. */
function giiName(prefix, row) {
  return `${prefix}_${row.toLowerCase().replaceAll(" ", "_")}.gii`;
}

function seconds(ms) {
  return `${(ms / 1000).toFixed(1)} s`;
}
