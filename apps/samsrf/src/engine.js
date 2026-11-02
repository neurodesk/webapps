// The one module that talks to the SamSrf engine (@neurodesk/samsrf). Everything
// else in the app reaches the engine through these four exports, and the worker
// pool (pool.js, worker.js) is their only caller apart from tests.
//
// An analysis is shardable by unit (a vertex of the ROI, or of the whole surface
// without one): createJob reads the inputs once, runShard fits units
// [start, end) and can run in any worker, and mergeShards turns the shards into
// SamSrf's map set and the GIfTI files samsrf_export_giis writes.
//
// TODO(samsrf-engine): this file still holds a stub that produces placeholder
// maps so the interface runs end to end. Replace the STUB section with calls to
// @neurodesk/samsrf and set ENGINE.stub to false; keep the exported signatures.

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
 * }} Job
 */

/** Structured-cloneable partial result of runShard; only mergeShards reads it. @typedef {unknown} Shard */

/**
 * @typedef {{
 *   outName: string,
 *   vertexCount: number,
 *   maps: { name: string, values: Float32Array }[], // Srf.Values rows, then Polar and Eccentricity when x0/y0 exist
 *   files: (NamedBytes & { map?: string })[],       // the GIfTI files samsrf_export_giis writes; map names the maps entry each holds
 *   summary: string[],                              // lines for the analysis log
 * }} Result
 */

export const ENGINE = Object.freeze({ stub: true, name: "SamSrf (placeholder engine)" });

/** @param {JobInputs} inputs @returns {Promise<Job>} */
export async function createJob(inputs) {
  return stubCreateJob(inputs);
}

/**
 * @param {Job} job
 * @param {number} start
 * @param {number} end
 * @param {(done: number) => void} onProgress units finished in this shard so far
 * @returns {Promise<Shard>}
 */
export async function runShard(job, start, end, onProgress) {
  return stubRunShard(job, start, end, onProgress);
}

/** @param {Job} job @param {Shard[]} shards @returns {Promise<Result>} */
export async function mergeShards(job, shards) {
  return stubMergeShards(job, shards);
}

// ---- STUB: placeholder maps, no SamSrf numerics. Delete with the engine wiring. ----

const decoder = new TextDecoder();

function stubVertexCount(run) {
  const head = decoder.decode(run.bytes.subarray(0, 1 << 16));
  const match = /Dim0="(\d+)"/.exec(head);
  if (!match) throw new Error(`${run.name} is not a GIfTI time series.`);
  return Number(match[1]);
}

function stubLabelVertices(label) {
  const lines = decoder.decode(label.bytes).split("\n").slice(2);
  return Int32Array.from(lines.filter((line) => line.trim()).map((line) => Number.parseInt(line, 10)));
}

function stubValueNames(analysis, model) {
  if (analysis === "prf") return ["R^2", ...model.Param_Names, "Beta", "Baseline"];
  if (analysis === "rc") return ["R^2", "x0", "y0", "Fwhm", "Beta"];
  return ["R^2", "x0", "y0", "Sigma", "Centre"];
}

async function stubCreateJob(inputs) {
  if (!inputs.runs.length) throw new Error("Add at least one run.");
  const vertexCount = stubVertexCount(inputs.runs[0]);
  const roiVertices = inputs.roi ? stubLabelVertices(inputs.roi) : null;
  const hemisphere = /(^|[^a-z])(lh|rh|bi)([^a-z]|$)/i.exec(inputs.runs[0].name)?.[2].toLowerCase() ?? "srf";
  const valueNames = stubValueNames(inputs.analysis, inputs.model);
  return {
    analysis: inputs.analysis,
    units: roiVertices?.length ?? vertexCount,
    vertexCount,
    outName: `${hemisphere}_${inputs.model.Name}`,
    summary: [
      `${inputs.runs.length} run${inputs.runs.length === 1 ? "" : "s"}, ${vertexCount} vertices${roiVertices ? `, ${roiVertices.length} in ${inputs.roi.name}` : ""}`,
      "Placeholder engine: the maps are synthetic, not a SamSrf fit.",
    ],
    roiVertices,
    valueNames,
  };
}

async function stubRunShard(job, start, end, onProgress) {
  const values = job.valueNames.map(() => new Float32Array(end - start));
  for (let unit = start; unit < end; unit++) {
    const vertex = job.roiVertices ? job.roiVertices[unit] : unit;
    const angle = (vertex % 360) * (Math.PI / 180);
    const radius = 1 + (vertex % 97) / 10;
    const row = unit - start;
    values[0][row] = 0.1 + 0.8 * Math.abs(Math.sin(vertex / 50));
    values[1][row] = radius * Math.cos(angle);
    values[2][row] = radius * Math.sin(angle);
    for (let index = 3; index < values.length; index++) values[index][row] = 0.5 + radius / 4;
    if ((unit - start) % 2000 === 1999) {
      onProgress(unit - start + 1);
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
  }
  onProgress(end - start);
  return { start, end, values };
}

async function stubMergeShards(job, shards) {
  const maps = job.valueNames.map((name) => ({ name, values: new Float32Array(job.vertexCount) }));
  for (const shard of shards) {
    for (let unit = shard.start; unit < shard.end; unit++) {
      const vertex = job.roiVertices ? job.roiVertices[unit] : unit;
      maps.forEach((map, index) => { map.values[vertex] = shard.values[index][unit - shard.start]; });
    }
  }
  const x = maps[1].values;
  const y = maps[2].values;
  const polar = new Float32Array(job.vertexCount);
  const eccentricity = new Float32Array(job.vertexCount);
  for (let vertex = 0; vertex < job.vertexCount; vertex++) {
    polar[vertex] = Math.atan2(y[vertex], x[vertex]) * (180 / Math.PI);
    eccentricity[vertex] = maps[0].values[vertex] === 0 ? 0 : Math.hypot(x[vertex], y[vertex]);
  }
  const files = [
    { name: `${job.outName}_pol.gii`, bytes: stubGifti(polar), map: "Polar" },
    { name: `${job.outName}_ecc.gii`, bytes: stubGifti(eccentricity), map: "Eccentricity" },
    ...maps.map((map) => ({ name: `${job.outName}_${map.name.toLowerCase().replaceAll(" ", "_")}.gii`, bytes: stubGifti(map.values), map: map.name })),
  ];
  return {
    outName: job.outName,
    vertexCount: job.vertexCount,
    maps: [...maps, { name: "Polar", values: polar }, { name: "Eccentricity", values: eccentricity }],
    files,
    summary: [`Placeholder maps for ${job.units} vertices`],
  };
}

function stubGifti(values) {
  const text = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<GIFTI Version="1.0" NumberOfDataArrays="1">',
    `<DataArray Intent="NIFTI_INTENT_NONE" DataType="NIFTI_TYPE_FLOAT32" ArrayIndexingOrder="RowMajorOrder" Dimensionality="1" Dim0="${values.length}" Encoding="ASCII" Endian="LittleEndian" ExternalFileName="" ExternalFileOffset="">`,
    `<Data>${Array.from(values, (value) => value.toPrecision(6)).join(" ")}</Data>`,
    "</DataArray>",
    "</GIFTI>",
  ].join("\n");
  return new TextEncoder().encode(text);
}
