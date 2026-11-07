// DOM-independent unit tests (Node). Browser behaviour is covered by e2e/.
import { gzipSync } from "node:zlib";
import { test } from "node:test";
import assert from "node:assert/strict";
import { createNiftiFromVolume, parseNiftiHeader } from "@neurodesk/webapp-components/file-io";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { writeTiffStack } from "@neurodesk/webapp-components/file-io/tiff";
import { APP, EXAMPLE_OPTICS, checkPsfSpacing, niftiGeometry, niftiSpacingUm, outputNames, provenance, setNiftiSpacing, spacingComplete, stackNifti, stackTiff, stem } from "../src/config.js";
import { formatOf, readVolume } from "../src/input.js";
import { stageNotices } from "../scripts/stage-notices.mjs";
import examples from "../examples.json" with { type: "json" };

test("app id and every example has optics", () => {
  assert.equal(APP.id, "deconvolution");
  for (const example of examples) assert.ok(EXAMPLE_OPTICS[example.id], example.id);
});

test("output names keep the input stem", () => {
  assert.equal(stem("cells.ome.tif"), "cells");
  assert.equal(stem("cells.nii.gz"), "cells");
  assert.deepEqual(outputNames("a.b.TIFF"), {
    tiff: "a.b_deconvolved.tif",
    nifti: "a.b_deconvolved.nii.gz",
    psfTiff: "a.b_psf.tif",
    psfNifti: "a.b_psf.nii.gz",
    previewNifti: "a.b.nii.gz",
  });
  assert.equal(formatOf("x.ome.tiff"), "tiff");
  assert.equal(formatOf("x.nii.gz"), "nifti");
  assert.equal(formatOf("x.czi"), null);
});

test("NIfTI headers written from a micrometre stack hold millimetres", () => {
  const dims = [3, 4, 5];
  const header = parseNiftiHeader(createNiftiFromVolume({ hdr: niftiGeometry(dims, { x: 0.065, y: 0.065, z: 0.13 }), img: new Float32Array(60) }));
  assert.deepEqual(header.dims.slice(0, 4), [3, 5, 4, 3]);
  assert.ok(Math.abs(header.pixDims[1] - 6.5e-5) < 1e-12 && Math.abs(header.pixDims[3] - 1.3e-4) < 1e-12, String(header.pixDims));
  assert.equal(header.xyztUnits & 7, 2);
  // The affine flips y so TIFF row 0 is shown at the top, as in ImageJ.
  assert.ok(Math.abs(header.affine[1][1] + 6.5e-5) < 1e-12);
  assert.ok(Math.abs(header.affine[1][3] - 3 * 6.5e-5) < 1e-12);
  assert.deepEqual(niftiSpacingUm(header), { x: header.pixDims[1] * 1000, y: header.pixDims[2] * 1000, z: header.pixDims[3] * 1000 });
});

test("NIfTI spacing honours xyzt_units", () => {
  const header = (units) => ({ xyztUnits: units, voxelSize: [0.5, 0.5, 2] });
  assert.deepEqual(niftiSpacingUm(header(3)), { x: 0.5, y: 0.5, z: 2 });
  assert.deepEqual(niftiSpacingUm(header(2)), { x: 500, y: 500, z: 2000 });
  assert.deepEqual(niftiSpacingUm(header(10)), { x: 500, y: 500, z: 2000 });
  assert.deepEqual(niftiSpacingUm(header(1)), { x: 500000, y: 500000, z: 2000000 });
});

test("readVolume reads TIFF and NIfTI into the same [z][y][x] layout and micrometres", async () => {
  const data = Float32Array.from({ length: 2 * 3 * 4 }, (_, i) => i);
  const spacingUm = { x: 0.2, y: 0.2, z: 0.5 };
  const tiff = await readVolume(new File([stackTiff(data, [2, 3, 4], spacingUm)], "s.tif"));
  assert.deepEqual(tiff.dims, [2, 3, 4]);
  assert.deepEqual(Array.from(tiff.data), Array.from(data));
  assert.equal(tiff.spacingUm.z, 0.5);
  assert.equal(tiff.spacingSource, "ImageJ");
  const nifti = await readVolume(new File([createNiftiFromVolume({ hdr: niftiGeometry([2, 3, 4], spacingUm), img: data })], "s.nii"));
  assert.deepEqual(nifti.dims, [2, 3, 4]);
  assert.deepEqual(Array.from(nifti.data), Array.from(data));
  for (const axis of ["x", "y", "z"]) assert.ok(Math.abs(nifti.spacingUm[axis] - spacingUm[axis]) < 1e-6, axis);
  await assert.rejects(readVolume(new File(["x"], "s.png")), /not a TIFF or NIfTI/);
  await assert.rejects(readVolume(new File([], "s.tif")), /empty/);
});

test("spacing must be positive on every axis", () => {
  assert.ok(spacingComplete({ x: 0.1, y: 0.1, z: 0.2 }));
  assert.ok(!spacingComplete({ x: 0.1, y: 0.1, z: null }));
  assert.ok(!spacingComplete({ x: Number.NaN, y: 0.1, z: 0.2 }));
});

test("provenance names the PSF and method", () => {
  const record = provenance({
    input: "a.tif",
    dims: [2, 3, 4],
    spacingUm: { x: 0.1, y: 0.1, z: 0.2 },
    optics: { modality: "confocal", na: 1.4, ni: 1.518, ns: 1.47, emissionUm: 0.525, excitationUm: 0.488, depthUm: 0 },
    psf: { source: "theoretical", dims: [27, 43, 43] },
    settings: { method: "rltv", iterations: 10, tvWeight: 0.002 },
  });
  assert.equal(record.psf.source, "Gibson-Lanni");
  assert.equal(record.psf.excitationNm, 488);
  assert.match(record.method, /Dey et al/);
  assert.deepEqual(record.dimensions, { x: 4, y: 3, z: 2 });
});

/** The voxel-to-world matrix of a NIfTI-1 header's qform (NIfTI-1 standard, as nibabel's get_qform). */
function qformMatrix(view) {
  const f = (offset) => view.getFloat32(offset, true);
  const [b, c, d] = [f(256), f(260), f(264)];
  const a = Math.sqrt(Math.max(0, 1 - (b * b + c * c + d * d)));
  const rotation = [
    [a * a + b * b - c * c - d * d, 2 * (b * c - a * d), 2 * (b * d + a * c)],
    [2 * (b * c + a * d), a * a + c * c - b * b - d * d, 2 * (c * d - a * b)],
    [2 * (b * d - a * c), 2 * (c * d + a * b), a * a + d * d - c * c - b * b],
  ];
  const qfac = f(76) < 0 ? -1 : 1;
  const scale = [f(80), f(84), f(88) * qfac];
  return rotation.map((row, i) => [...row.map((value, j) => value * scale[j]), f(268 + 4 * i)]);
}

const sformMatrix = (view) => [0, 1, 2].map((row) => [0, 1, 2, 3].map((column) => view.getFloat32(280 + 16 * row + 4 * column, true)));

function assertMatricesClose(actual, expected, tolerance = 1e-12) {
  actual.forEach((row, i) => row.forEach((value, j) => assert.ok(Math.abs(value - expected[i][j]) <= tolerance, `[${i}][${j}] ${value} vs ${expected[i][j]}\n${JSON.stringify(actual)}\n${JSON.stringify(expected)}`)));
}

test("a NIfTI written from a TIFF stack has a qform equal to its sform, y flipped", () => {
  const view = new DataView(stackNifti(new Float32Array(60), [3, 4, 5], { x: 0.065, y: 0.065, z: 0.13 }));
  assert.equal(view.getInt16(252, true), 1);
  assert.equal(view.getInt16(254, true), 1);
  const sform = sformMatrix(view);
  assert.ok(sform[1][1] < 0, "y is flipped");
  assertMatricesClose(qformMatrix(view), sform);
});

test("edited spacing rewrites a NIfTI input's pixdims and sform scales, keeping orientation and origin", () => {
  // An oblique sform in micrometres (xyzt_units 3): x along -x, y and z rotated 30° about x.
  const header = new Uint8Array(stackNifti(new Float32Array(60), [3, 4, 5], { x: 1, y: 1, z: 1 })).slice(0, 352).buffer;
  const view = new DataView(header);
  view.setUint8(123, 3);
  const cos = Math.cos(Math.PI / 6);
  const sin = Math.sin(Math.PI / 6);
  const rows = [[-0.2, 0, 0, 5], [0, 0.2 * cos, -0.6 * sin, -7], [0, 0.2 * sin, 0.6 * cos, 11]];
  rows.forEach((row, i) => row.forEach((value, j) => view.setFloat32(280 + 16 * i + 4 * j, value, true)));
  [0.2, 0.2, 0.6].forEach((value, i) => view.setFloat32(80 + 4 * i, value, true));
  const out = new DataView(setNiftiSpacing(header, { x: 0.1, y: 0.1, z: 0.3 }));
  assert.deepEqual([80, 84, 88].map((offset) => Number(out.getFloat32(offset, true).toPrecision(6))), [0.1, 0.1, 0.3]);
  const halved = rows.map((row) => [...row.slice(0, 3).map((value) => value / 2), row[3]]);
  assertMatricesClose(sformMatrix(out), halved, 1e-6);
  // A millimetre header stores the same micrometres as millimetres.
  out.setUint8(123, 2);
  setNiftiSpacing(header, { x: 0.1, y: 0.1, z: 0.3 });
  assert.ok(Math.abs(out.getFloat32(80, true) - 1e-4) < 1e-10);
});

test("readVolume takes edited NIfTI spacing round trip through setNiftiSpacing", async () => {
  const buffer = setNiftiSpacing(stackNifti(new Float32Array(60), [3, 4, 5], { x: 0.065, y: 0.065, z: 0.13 }), { x: 0.08, y: 0.08, z: 0.2 });
  const volume = await readVolume(new File([buffer], "edited.nii"));
  for (const [axis, want] of [["x", 0.08], ["y", 0.08], ["z", 0.2]]) assert.ok(Math.abs(volume.spacingUm[axis] - want) < 1e-6, axis);
  const view = new DataView(buffer);
  assertMatricesClose(qformMatrix(view), sformMatrix(view));
});

test("TIFF channels, time points, OME series and non-square pixels are refused", async () => {
  const tiff = (description, pages = 2, pixelSize = null) => new File([writeTiffStack({ width: 2, height: 2, data: new Uint16Array(4 * pages), description, pixelSize })], "s.tif");
  const ome = (sizes, extra = "") => `<OME xmlns="x"><Image ID="Image:0"><Pixels DimensionOrder="XYZCT" SizeX="2" SizeY="2" ${sizes}/></Image>${extra}</OME>`;
  await assert.rejects(readVolume(tiff(ome('SizeC="2" SizeZ="1" SizeT="1"'))), /2 channels/);
  await assert.rejects(readVolume(tiff(ome('SizeC="1" SizeZ="1" SizeT="2"'))), /2 time points/);
  await assert.rejects(readVolume(tiff(ome('SizeC="1" SizeZ="2" SizeT="1"', '<Image ID="Image:1"><Pixels SizeX="2" SizeY="2"/></Image>'))), /2 image series/);
  await assert.rejects(readVolume(tiff("ImageJ=1.11a\nimages=2\nframes=2\n")), /2 time points/);
  await assert.rejects(readVolume(tiff("ImageJ=1.11a\nimages=2\nchannels=2\n")), /2 channels/);
  await assert.rejects(readVolume(tiff("ImageJ=1.11a\nimages=2\nunit=micron\n", 2, { x: 0.1, y: 0.2 })), /square pixels/);
  // Unlabelled pages, plain or ImageJ, are z planes.
  assert.deepEqual((await readVolume(tiff("", 3))).dims, [3, 2, 2]);
  assert.deepEqual((await readVolume(tiff("ImageJ=1.11a\nimages=3\nslices=3\n", 3))).dims, [3, 2, 2]);
  assert.equal((await readVolume(tiff(ome('SizeC="1" SizeZ="2" SizeT="1" PhysicalSizeX="0.1" PhysicalSizeY="0.1"')))).spacingSource, "OME-XML");
  // A plain TIFF's resolution tags are a print size, not a voxel size.
  const plain = await readVolume(tiff("", 2, { x: 0.5, y: 0.5 }));
  assert.deepEqual([plain.spacingUm, plain.spacingSource], [{ x: null, y: null, z: null }, null]);
});

test("a NIfTI with non-square pixels is refused", async () => {
  await assert.rejects(readVolume(new File([stackNifti(new Float32Array(60), [3, 4, 5], { x: 0.1, y: 0.15, z: 0.3 })], "oblong.nii")), /0\.1 × 0\.15 µm pixels; this app needs square pixels/);
});

test("a measured PSF is checked against the image's spacing on all three axes", () => {
  const image = { x: 0.1, y: 0.1, z: 0.25 };
  assert.equal(checkPsfSpacing({ x: 0.1, y: 0.1, z: 0.25 }, image, "bead.tif"), null);
  assert.throws(() => checkPsfSpacing({ x: 0.1, y: 0.2, z: 0.25 }, image, "bead.tif"), /along y/);
  assert.throws(() => checkPsfSpacing({ x: 0.1, y: 0.1, z: 0.5 }, image, "bead.tif"), /along z/);
  assert.match(checkPsfSpacing({ x: null, y: null, z: null }, image, "bead.tif"), /bead\.tif records no voxel size along x, y, z; it is taken to be on the image's 0\.1 × 0\.1 × 0\.25 µm grid/);
});

test("the staged notices name the crates the module links, with their copyright lines", async () => {
  const out = await mkdtemp(join(process.env.TMPDIR ?? ".", "deconvolution-notices-"));
  try {
    const names = await stageNotices(out);
    const read = (name) => readFile(join(out, name), "utf8");
    assert.ok(names.includes("deconvolution-THIRD_PARTY_NOTICES.md"));
    const notices = await read("deconvolution-THIRD_PARTY_NOTICES.md");
    for (const [crate, line] of [["wasm-bindgen 0.2.130", "Copyright (c) 2014 Alex Crichton"], ["rustfft 6.4.1", "Copyright (c) 2015 The RustFFT Developers"], ["realfft 3.5.1", "Copyright (c) 2020 Henrik Enquist and RealFFT contributors"], ["num-complex 0.4.6", "Copyright (c) 2014 The Rust Project Developers"], ["libm 0.2.16", "Copyright (c) 2018 Jorge Aparicio"], ["unicode-ident 1.0.27", "Copyright © 1991-2023 Unicode, Inc."]]) {
      const section = notices.split("\n## ").find((part) => part.startsWith(crate));
      assert.ok(section, `${crate} is listed`);
      assert.ok(section.includes(line), `${crate}: ${line}`);
    }
    assert.match(await read("deconvolution-NOTICE.txt"), /Copyright \(C\) 1993 by Sun Microsystems, Inc\./);
    assert.match(await read("geotiff-LICENSE.txt"), /MIT License/);
  } finally {
    await rm(out, { recursive: true, force: true });
  }
});

// A File that refuses to be read whole, so a refusal is shown to come from its header.
class HeaderOnlyFile extends File {
  arrayBuffer() {
    assert.fail("must not read the whole file");
  }
}

test("input size and cancellation are checked before reading source bytes", async () => {
  const file = { name: "large.nii", size: 1025, arrayBuffer() { assert.fail("must not read oversized input"); } };
  await assert.rejects(readVolume(file, { maxFileBytes: 1024 }), { name: "InputTooLargeError", message: /Input too large/ });
  await assert.rejects(readVolume(file, { signal: AbortSignal.abort() }), { name: "AbortError" });
});

test("the voxel limit counts voxels, not the header bytes around them", async () => {
  const voxels = new Float32Array(4096);
  const nifti = stackNifti(voxels, [16, 16, 16], { x: 1, y: 1, z: 1 });
  const tiff = stackTiff(voxels, [16, 16, 16], { x: 1, y: 1, z: 1 });
  assert.ok(nifti.byteLength > voxels.byteLength && tiff.byteLength > voxels.byteLength);
  assert.deepEqual((await readVolume(new File([nifti], "stack.nii"), { maxBytes: voxels.byteLength })).dims, [16, 16, 16]);
  assert.deepEqual((await readVolume(new File([tiff], "stack.tif"), { maxBytes: voxels.byteLength })).dims, [16, 16, 16]);
  await assert.rejects(readVolume(new File([tiff], "stack.tif"), { maxBytes: voxels.byteLength - 1 }), { name: "InputTooLargeError", message: /Decoded TIFF stack too large/ });
  // An 8-bit TIFF is counted as the Float32 array it is read into, as a NIfTI is.
  const bytes = stackTiff(new Uint8Array(4096), [16, 16, 16], { x: 1, y: 1, z: 1 });
  await assert.rejects(readVolume(new File([bytes], "stack8.tif"), { maxBytes: 4096 }), { name: "InputTooLargeError", message: /Decoded TIFF stack too large/ });
  const read = await readVolume(new File([bytes], "stack8.tif"), { maxBytes: voxels.byteLength });
  assert.ok(read.data instanceof Float32Array);
});

test("compressed NIfTI accepts the exact decoded limit and refuses larger images from its header", async () => {
  const voxels = new Float32Array(4096);
  const bytes = gzipSync(new Uint8Array(stackNifti(voxels, [16, 16, 16], { x: 1, y: 1, z: 1 })));
  const volume = await readVolume(new File([bytes], "stack.nii.gz"), { maxBytes: voxels.byteLength });
  assert.deepEqual(volume.dims, [16, 16, 16]);
  // An int8 NIfTI is counted as the Float32 array it is read into, before it is inflated.
  const int8 = gzipSync(new Uint8Array(createNiftiFromVolume({ hdr: niftiGeometry([16, 16, 16], { x: 1, y: 1, z: 1 }), img: new Int8Array(4096) })));
  for (const file of [new HeaderOnlyFile([bytes], "stack.nii.gz"), new HeaderOnlyFile([int8], "int8.nii.gz")]) {
    await assert.rejects(readVolume(file, { maxBytes: voxels.byteLength - 1 }), { name: "InputTooLargeError", message: /Decoded image too large/ }, file.name);
  }
});

test("a NIfTI header that understates its data stops inflating at the file limit", { timeout: 5000 }, async (t) => {
  const header = new Uint8Array(stackNifti(new Float32Array(8), [2, 2, 2], { x: 1, y: 1, z: 1 }).slice(0, 352));
  const streams = [];
  t.mock.method(globalThis, "DecompressionStream", function () {
    const stream = { chunks: 0, cancelled: false };
    streams.push(stream);
    return {
      readable: new ReadableStream({
        // Finite, so a missing backstop reads it to the end and fails the assertions below.
        pull(controller) {
          if (stream.chunks === 64) controller.close();
          else controller.enqueue(stream.chunks++ ? new Uint8Array(256) : header);
        },
        cancel() { stream.cancelled = true; },
      }),
      writable: new WritableStream(),
    };
  });
  const file = new File([new Uint8Array([0x1f, 0x8b])], "large.nii.gz");
  await assert.rejects(readVolume(file, { maxFileBytes: 1024 }), { name: "InputTooLargeError", message: /Decompressed NIfTI too large/ });
  const inflate = streams.at(-1);
  assert.ok(inflate.cancelled);
  assert.ok(inflate.chunks <= 6, `consumed ${inflate.chunks} chunks`);
});
