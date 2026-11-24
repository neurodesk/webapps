import assert from "node:assert/strict";
import test from "node:test";
import { APP, assertValidDims, outputNames, provenance, resolvedSpacingUm, stackNifti, stackTiff, stem } from "../src/config.js";
import { checkSingleChannelStack, formatOf, readVolume } from "../src/input.js";
import { DEFAULT_SETTINGS } from "@neurodesk/denoise/core";

test("APP identity and output names strip TIFF and NIfTI extensions cleanly", () => {
  assert.equal(APP.id, "denoise");
  assert.equal(APP.title, "Denoise");
  assert.equal(stem("sample.ome.tif"), "sample");
  assert.equal(stem("stack.nii.gz"), "stack");
  const names = outputNames("hela.ome.tiff");
  assert.equal(names.tiff, "hela_denoised.tif");
  assert.equal(names.nifti, "hela_denoised.nii.gz");
  assert.equal(names.residualTiff, "hela_residual.tif");
});

test("formatOf recognizes TIFF and NIfTI and rejects unsupported formats", () => {
  assert.equal(formatOf("a.tif"), "tiff");
  assert.equal(formatOf("a.ome.tiff"), "tiff");
  assert.equal(formatOf("a.nii"), "nifti");
  assert.equal(formatOf("a.nii.gz"), "nifti");
  assert.equal(formatOf("a.png"), null);
});

test("checkSingleChannelStack supports 2D, 3D Z and 2D+T stacks and rejects multi-channel", () => {
  assert.equal(checkSingleChannelStack({ pages: 1, metadata: { sizeC: 1, sizeZ: 1, sizeT: 1 } }, "a.tif"), "z");
  assert.equal(checkSingleChannelStack({ pages: 10, metadata: { sizeC: 1, sizeZ: 10, sizeT: 1 } }, "a.tif"), "z");
  assert.equal(checkSingleChannelStack({ pages: 20, metadata: { sizeC: 1, sizeZ: 1, sizeT: 20 } }, "a.tif"), "t");
  assert.throws(
    () => checkSingleChannelStack({ pages: 2, metadata: { sizeC: 2, sizeZ: 1, sizeT: 1 } }, "rgb.tif"),
    /2 channels/,
  );
  assert.throws(
    () => checkSingleChannelStack({ pages: 6, metadata: { sizeC: 1, sizeZ: 2, sizeT: 3 } }, "4d.tif"),
    /both 2 Z planes and 3 time points/,
  );
});

test("TIFF and NIfTI round-trip through readVolume with preserved dimensions, spacing and time metadata", async () => {
  const dims = [3, 8, 10];
  const data = Float32Array.from({ length: 3 * 8 * 10 }, (_, i) => i * 1.5);
  const spacing = { x: 0.25, y: 0.35, z: 0.5 };

  const tiffBytes = stackTiff(data, dims, spacing);
  const tiffVol = await readVolume(new File([tiffBytes], "cells.tif", { type: "image/tiff" }));
  assert.deepEqual(tiffVol.dims, dims);
  assert.equal(tiffVol.axisKind, "z");
  assert.deepEqual(tiffVol.data, data);
  assert.ok(Math.abs(tiffVol.spacingUm.x - 0.25) < 1e-4);
  assert.ok(Math.abs(tiffVol.spacingUm.y - 0.35) < 1e-4);

  // Calibrated 2D+T movie preserves frameInterval and XY calibration in both TIFF and NIfTI (dim[4]).
  const timeTiffBytes = stackTiff(data, dims, spacing, { axisKind: "t", frameInterval: 0.123 });
  const timeVol = await readVolume(new File([timeTiffBytes], "movie.tif", { type: "image/tiff" }));
  assert.deepEqual(timeVol.dims, dims);
  assert.equal(timeVol.axisKind, "t");
  assert.ok(Math.abs(timeVol.frameInterval - 0.123) < 1e-6);
  assert.ok(Math.abs(timeVol.spacingUm.x - 0.25) < 1e-4);
  assert.ok(Math.abs(timeVol.spacingUm.y - 0.35) < 1e-4);
  assert.deepEqual(timeVol.data, data);

  const timeNiftiBytes = stackNifti(data, dims, spacing, { axisKind: "t", frameInterval: 0.123 });
  const timeNiftiView = new DataView(timeNiftiBytes);
  assert.equal(timeNiftiView.getInt16(40, true), 4);
  assert.equal(timeNiftiView.getInt16(46, true), 1);
  assert.equal(timeNiftiView.getInt16(48, true), 3);
  assert.ok(Math.abs(timeNiftiView.getFloat32(92, true) - 0.123) < 1e-6);
  assert.equal(timeNiftiView.getUint8(123), 2 | 8);
  const timeNiftiVol = await readVolume(new File([timeNiftiBytes], "movie.nii", { type: "application/octet-stream" }));
  assert.deepEqual(timeNiftiVol.dims, dims);
  assert.equal(timeNiftiVol.axisKind, "t");
  assert.ok(Math.abs(timeNiftiVol.frameInterval - 0.123) < 1e-6);
  assert.deepEqual(timeNiftiVol.data, data);

  const niftiBytes = stackNifti(data, dims, spacing);
  const niftiVol = await readVolume(new File([niftiBytes], "cells.nii", { type: "application/octet-stream" }));
  assert.deepEqual(niftiVol.dims, dims);
  assert.deepEqual(niftiVol.data, data);
  assert.ok(Math.abs(niftiVol.spacingUm.x - 0.25) < 1e-4);
  assert.ok(Math.abs(niftiVol.spacingUm.z - 0.5) < 1e-4);
});

test("rank-aware 2D NIfTI with unused dim[3] === 0 loads cleanly, enforces maxBytes, converts ms time units, and rejects rank-5 and non-finite inputs", async () => {
  const data = Float32Array.from({ length: 6 * 8 }, (_, i) => i + 1);
  const buf = stackNifti(data, [1, 6, 8], { x: 0.5, y: 0.5, z: 1 });
  const view = new DataView(buf);
  view.setInt16(40, 2, true);
  view.setInt16(46, 0, true);
  const vol = await readVolume(new File([buf], "plane2d.nii", { type: "application/octet-stream" }));
  assert.deepEqual(vol.dims, [1, 6, 8]);
  assert.ok(vol.previewBuffer instanceof ArrayBuffer);
  assert.deepEqual(vol.data, data);

  // Oversized rank-2 NIfTI with dim[3]=0 must still be refused by maxBytes.
  await assert.rejects(
    readVolume(new File([buf], "plane2d.nii", { type: "application/octet-stream" }), { maxBytes: 16 }),
    /too large|limit|exceeds/i,
  );

  // 2D+T NIfTI with millisecond temporal units (250 ms -> 0.25 s).
  const movieData = Float32Array.from({ length: 3 * 6 * 8 }, (_, i) => i + 1);
  const movieBuf = stackNifti(movieData, [3, 6, 8], { x: 0.5, y: 0.5, z: 1 }, { axisKind: "t", frameInterval: 250 });
  const movieView = new DataView(movieBuf);
  movieView.setUint8(123, 2 | 16); // mm + milliseconds
  const movieVol = await readVolume(new File([movieBuf], "ms-movie.nii", { type: "application/octet-stream" }));
  assert.equal(movieVol.axisKind, "t");
  assert.ok(Math.abs(movieVol.frameInterval - 0.25) < 1e-6, `expected 0.25 s, got ${movieVol.frameInterval}`);

  // Rank-5 vector NIfTI AND malformed rank-4 NIfTI with dim[5] > 1 must both be rejected cleanly.
  const vecBuf = movieBuf.slice(0);
  const vecView = new DataView(vecBuf);
  vecView.setInt16(40, 5, true);
  vecView.setInt16(48, 1, true);
  vecView.setInt16(50, 3, true);
  await assert.rejects(
    readVolume(new File([vecBuf], "vec5d.nii", { type: "application/octet-stream" })),
    /5 dimensions/,
  );

  const malformedBuf = movieBuf.slice(0);
  const malformedView = new DataView(malformedBuf);
  malformedView.setInt16(40, 4, true);
  malformedView.setInt16(48, 1, true);
  malformedView.setInt16(50, 3, true);
  await assert.rejects(
    readVolume(new File([malformedBuf], "malformed4d.nii", { type: "application/octet-stream" })),
    /axis 5/,
  );

  const bad = Float32Array.from(data);
  bad[5] = Number.NaN;
  const badTiff = stackTiff(bad, [1, 6, 8], { x: 0.5, y: 0.5, z: 1 });
  await assert.rejects(
    readVolume(new File([badTiff], "bad.tif", { type: "image/tiff" })),
    /non-finite/i,
  );
});

test("assertValidDims rejects dimensions exceeding signed 16-bit NIfTI-1 limit", () => {
  assert.throws(() => assertValidDims([1, 16, 32768]), /32767/);
  assert.throws(() => assertValidDims([1, 32768, 16]), /32767/);
});

test("resolvedSpacingUm falls back to 1 um and provenance includes replayable settings and per-axis diagnostics", () => {
  assert.deepEqual(resolvedSpacingUm({ x: null, y: 0, z: 0.5 }), { x: 1, y: 1, z: 0.5 });
  const record = provenance({
    input: "cells.tif",
    dims: [1, 32, 32],
    axisKind: "z",
    settings: DEFAULT_SETTINGS,
    details: { treesUsed: 20 },
    diagnostics: {
      inputNoiseSigma: 12.345,
      denoisedNoiseSigma: 2.345,
      residualMean: 0.012,
      residualStd: 11.98,
      residualAutocorrX: 0.01234,
      residualAutocorrY: -0.02345,
      residualAutocorrZ: null,
      residualMaxAbsAutocorr: 0.02345,
      noiseFloorDropDb: 14.426,
      structureWarning: false,
    },
    seconds: 1.2,
  });
  assert.equal(record.app, "denoise");
  assert.deepEqual(record.settings, {
    method: "fgr-gbdt",
    mode: "auto",
    nTrees: 80,
    maxDepth: 4,
    maxScale: 8,
    seed: 42,
  });
  assert.equal(record.diagnostics.noiseFloorDropDb, 14.43);
  assert.equal(record.diagnostics.residualAutocorrX, 0.0123);
  assert.equal(record.diagnostics.residualAutocorrY, -0.0234);
  assert.equal(record.diagnostics.residualMaxAbsAutocorr, 0.0234);
  assert.equal(record.diagnostics.structureWarning, false);
});
