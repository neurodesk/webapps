// DOM-independent unit tests (Node, no browser) of settings, outputs and viewer images.
import { readFileSync } from "node:fs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseNiftiHeader } from "@neurodesk/webapp-components/file-io";
import { APP, SettingsError, provenance, readSettings } from "../src/config.js";
import { DEFAULTS } from "../src/core/pipeline.js";
import { outputStem, parseShiftsCsv, roisCsv, shiftSvg, shiftsCsv, toInputType, traceSvg, tracesCsv } from "../src/outputs.js";
import { displayNifti, displaySpacing, roiColormap } from "../src/display.js";

test("app id is lowercase kebab-case and the config is frozen", () => {
  assert.match(APP.id, /^[a-z][a-z0-9-]*$/);
  assert.ok(Object.isFrozen(APP));
});

test("settings default to the documented values and need a frame rate", () => {
  const settings = readSettings({ motion: "rigid", frameRate: "30" });
  assert.equal(settings.frameRate, 30);
  assert.equal(settings.neuropilCoefficient, 0.7);
  assert.equal(settings.baselinePercentile, 8);
  assert.equal(settings.baselineWindow, 60);
  assert.equal(settings.upsample, 10);
  assert.equal(settings.normalization, "none");
  assert.equal(settings.deconvolution, true);
  assert.deepEqual({ ...settings, frameRate: undefined }, { ...DEFAULTS, frameRate: undefined });
  assert.throws(() => readSettings({ motion: "rigid", frameRate: "" }), (error) => error instanceof SettingsError && error.field === "frameRate");
});

test("each invalid setting names its field", () => {
  const cases = [
    [{ motion: "affine" }, "motion"],
    [{ normalization: "gradient" }, "normalization"],
    [{ maxShift: "2.5" }, "maxShift"],
    [{ upsample: "0" }, "upsample"],
    [{ neuropilCoefficient: "-0.1" }, "neuropilCoefficient"],
    [{ baselinePercentile: "101" }, "baselinePercentile"],
    [{ motion: "piecewise", patchSize: "32", patchOverlap: "32" }, "patchOverlap"],
  ];
  for (const [values, field] of cases) {
    assert.throws(() => readSettings({ motion: "rigid", frameRate: "10", ...values }), (error) => error.field === field, field);
  }
});

test("manual settings apply without depending on any automatic estimate", () => {
  const settings = readSettings({ motion: "piecewise", frameRate: "15.5", diameter: "14", seedZ: "2.5", deconvolution: false, templatePasses: "3" });
  assert.deepEqual([settings.motion, settings.frameRate, settings.diameter, settings.seedZ, settings.deconvolution, settings.templatePasses], ["piecewise", 15.5, 14, 2.5, false, 3]);
});

function cell(id, values) {
  const dff = Float64Array.from(values);
  return {
    id,
    area: 30,
    neuropilPixels: 210,
    centroid: [4.25, 7.5],
    F: dff.map((v) => 100 + v),
    Fneu: dff.map(() => 50),
    corrected: dff.map((v) => 65 + v),
    dff,
    undefinedSamples: 0,
    deconvolution: { c: dff.map((v) => v / 2), s: dff.map((v, t) => (t === 1 ? 0.5 : 0)), g: 0.9, sn: 0.1, baseline: 0.01, lambda: 0.3 },
  };
}

test("CSV outputs carry one row per frame or ROI with named columns", () => {
  const cells = [cell(1, [0, 1, 0.5]), cell(2, [0.2, NaN, 0])];
  const shifts = shiftsCsv({ shifts: [[0.1, -0.2], [1, 2], [0, 0]], patches: null, grid: null }, 2);
  assert.equal(shifts, "frame,time_s,shift_y_px,shift_x_px\n1,0,0.1,-0.2\n2,0.5,1,2\n3,1,0,0\n");
  assert.deepEqual(parseShiftsCsv(shifts), [[0.1, -0.2], [1, 2], [0, 0]]);
  const traces = tracesCsv(cells, 3, 2).split("\n");
  assert.equal(traces[0], "frame,time_s,roi1_F,roi1_Fneu,roi1_Fcorrected,roi1_dFF,roi1_denoised,roi1_spikes,roi2_F,roi2_Fneu,roi2_Fcorrected,roi2_dFF,roi2_denoised,roi2_spikes");
  assert.equal(traces[2].split(",")[5], "1");
  assert.equal(traces[2].split(",")[11], "NaN");
  const rois = roisCsv(cells).split("\n");
  assert.equal(rois[0], "roi,area_px,centroid_y_px,centroid_x_px,neuropil_px,undefined_dff_samples,ar1_g,noise_sd_dff,baseline_dff,lambda,spike_sum");
  assert.equal(rois[1], "1,30,4.25,7.5,210,0,0.9,0.1,0.01,0.3,0.5");
});

test("piecewise shift tables name each patch by grid row and column", () => {
  const grid = { ys: [0, 32], xs: [0, 32, 64] };
  const patches = [Array.from({ length: 6 }, (_, k) => [k, -k])];
  const text = shiftsCsv({ shifts: [[0.5, 0.5]], patches, grid }, 1);
  const [header, row] = text.trim().split("\n");
  assert.ok(header.endsWith("patch_r2_c3_y_px,patch_r2_c3_x_px"));
  assert.ok(row.endsWith("5,-5"));
});

test("SVG plots use currentColor and the shared chart classes, never colour literals", () => {
  for (const svg of [traceSvg([cell(1, [0, 1, 0.5])], 3, 2), shiftSvg([[0, 1], [1, 0]], 2)]) {
    assert.ok(svg.startsWith("<svg xmlns=\"http://www.w3.org/2000/svg\""));
    assert.doesNotMatch(svg, /#[0-9a-f]{3,8}\b|rgb\(/i);
    assert.match(svg, /currentColor/);
    assert.match(svg, /nd-chart/);
  }
});

test("the registered movie keeps an integer input's type, rounded and clamped", () => {
  assert.deepEqual(Array.from(toInputType(Float32Array.from([-3, 1.4, 1.6, 70000]), "uint16")), [0, 1, 2, 65535]);
  assert.deepEqual(Array.from(toInputType(Float32Array.from([-40000, 2.5]), "int16")), [-32768, 3]);
  assert.ok(toInputType(Float32Array.from([1.25]), "float64") instanceof Float32Array);
  assert.equal(outputStem("movie.ome.tif"), "movie");
  assert.equal(outputStem("my movie.TIFF"), "my_movie");
});

test("viewer NIfTIs convert micrometres to millimetres and draw row 0 at the top", async () => {
  assert.deepEqual(displaySpacing({ x: 0.8, y: 0.8 }), [0.0008, 0.0008]);
  assert.deepEqual(displaySpacing({ x: null, y: null }), [1, 1]);
  const file = displayNifti("m.nii", new Float32Array(4 * 3 * 2), { width: 4, height: 3, frames: 2, spacing: [0.0008, 0.0005], frameInterval: 0.25 });
  const header = parseNiftiHeader(await file.arrayBuffer());
  assert.deepEqual(header.dims.slice(0, 5), [4, 4, 3, 1, 2]);
  assert.ok(Math.abs(header.pixDims[1] - 0.0008) < 1e-9);
  assert.ok(Math.abs(header.pixDims[2] - 0.0005) < 1e-9);
  assert.ok(Math.abs(header.affine[1][1] + 0.0005) < 1e-9);
  assert.ok(Math.abs(header.affine[1][3] - 2 * 0.0005) < 1e-9);
});

test("the ROI colour table has a transparent background and one opaque colour per ROI", () => {
  const map = roiColormap(3);
  assert.deepEqual(map.I, [0, 1, 2, 3]);
  assert.deepEqual(map.A, [0, 255, 255, 255]);
  assert.equal(new Set(map.R.slice(1).map((r, i) => `${r},${map.G[i + 1]},${map.B[i + 1]}`)).size, 3);
});

test("provenance records the method, the 0.7 coefficient and the baseline", () => {
  const settings = readSettings({ motion: "piecewise", frameRate: "10" });
  const record = provenance({
    input: { name: "m.tif", size: 10 },
    settings,
    dims: { dtype: "uint16", frames: 50, height: 8, width: 8, metadataKind: "ome" },
    roiSource: "detected",
    cells: [],
    detection: { threshold: 0.2, floor: 0.15, margin: 3, seeds: 0 },
    timings: {},
  });
  assert.equal(record.motionCorrection.patchSizePx, 64);
  assert.equal(record.traces.neuropilCoefficient, 0.7);
  assert.equal(record.traces.baseline, "running 8th percentile over 60 s");
  assert.equal(record.rois.borderMarginPx, 3);
  const manifest = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
  assert.equal(record.version, manifest.version);
  assert.match(record.version, /^\d+\.\d+\.\d{8}$/);
});
