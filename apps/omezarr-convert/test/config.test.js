// DOM-independent unit tests (Node). Browser behaviour is covered by e2e/.
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseNiftiHeader } from "@neurodesk/webapp-components/file-io/nifti";
import { APP, ARCHIVE_MAX_BYTES, archiveRefusal, conversionReport, describeSource, displayUnit, formSettings, metadataOverrides, noteLine, outputStem, rawBytes } from "../src/config.js";
import { channelColormap, channelNifti, displayGeometry, previewLevel, readSourcePreview, trueMicrometres, voxelMillimetres } from "../src/preview.js";

const source = (extra = {}) => ({
  name: "cells",
  format: "OME-TIFF",
  dtype: "uint16",
  shape: { t: 1, c: 2, z: 4, y: 300, x: 500 },
  scale: { t: null, z: 0.3, y: 65, x: 65 },
  units: { t: null, z: "micrometer", y: "nanometer", x: "nanometer" },
  channels: [{ label: "DAPI", color: "0000FF" }, { label: null, color: null }],
  notes: [],
  ...extra,
});

test("app id is lowercase kebab-case and the config is frozen", () => {
  assert.match(APP.id, /^[a-z][a-z0-9-]*$/);
  assert.ok(Object.isFrozen(APP));
});

test("the form shows X, Y and Z in X's unit, converting Z", () => {
  assert.deepEqual(displayUnit(source()), { name: "nanometer", values: { x: 65, y: 65, z: 300 }, complete: true });
  const inches = displayUnit(source({ scale: { t: null, z: null, y: 0.001, x: 0.001 }, units: { t: null, z: null, y: "inch", x: "inch" } }));
  assert.deepEqual(inches, { name: "micrometer", values: { x: 25.4, y: 25.4 }, complete: false });
});

test("voxel sizes replace the file's only when edited, and then all three are required", () => {
  const sizes = { x: "0.1", y: "0.1", z: "" };
  assert.deepEqual(metadataOverrides({ edited: false, sizes, unit: "micrometer", labels: ["a", ""] }), { labels: ["a", ""] });
  assert.throws(() => metadataOverrides({ edited: true, sizes, unit: "micrometer", labels: [] }), (error) => error.field === "metadata" && /Z voxel size/.test(error.message));
  assert.deepEqual(metadataOverrides({ edited: true, sizes: { x: "", y: " ", z: "" }, unit: "micrometer", labels: [] }), { labels: [] });
  assert.deepEqual(metadataOverrides({ edited: true, sizes: { ...sizes, z: "2" }, unit: "nanometer", labels: [] }), { labels: [], scale: { x: 0.1, y: 0.1, z: 2 }, unit: "nanometer" });
});

test("settings are checked", () => {
  assert.deepEqual(formSettings({ version: "0.4", method: "nearest", chunk: 512, compressionLevel: 1 }), { version: "0.4", method: "nearest", chunk: 512, compressionLevel: 1, destination: "archive" });
  assert.throws(() => formSettings({ version: "0.5", method: "mean", chunk: 256, compressionLevel: NaN }), /compressionLevel must be an integer/);
  assert.throws(() => formSettings({ version: "0.5", method: "mean", chunk: 256, compressionLevel: 6, destination: "cloud" }), /Unknown destination/);
});

test("the description and report name what was read and written", () => {
  assert.equal(describeSource(source(), [{ name: "cells.ome.tif" }]), "cells.ome.tif · 2 ch × 4 × 300 × 500 · uint16 · 65 nm");
  assert.equal(describeSource(source({ shape: { t: 3, c: 1, z: 1, y: 2, x: 2 }, scale: { x: null } }), [{ name: "a" }, { name: "b" }]), "2 files · 1 ch × 1 × 2 × 2 × 3 t · uint16");
  assert.equal(rawBytes(source()), 2 * 4 * 300 * 500 * 2);
  const report = conversionReport({
    source: source(),
    files: ["cells.ome.tif"],
    settings: { version: "0.5", method: "mean", chunk: 256, compressionLevel: 6, destination: "archive" },
    written: { plan: [{ shape: [1, 2, 4, 300, 500], chunks: [1, 1, 1, 256, 256] }], multiscales: {}, omero: {}, chunksWritten: 32, bytesWritten: 1000 },
    seconds: 1.234,
  });
  assert.deepEqual(report.levels, [{ path: "0", shape: [1, 2, 4, 300, 500], chunks: [1, 1, 1, 256, 256] }]);
  assert.equal(report.input.attribution, undefined);
  assert.equal(report.settings.destination, undefined);
  assert.equal(report.seconds, 1.23);
});

test("the preview uses the largest level that fits 1024 pixels and 1 GB, or none", () => {
  assert.equal(previewLevel([[1, 1, 1, 4000, 3000], [1, 1, 1, 2000, 1500], [1, 1, 1, 1000, 750]], 1), 2);
  assert.equal(previewLevel([[1, 1, 1, 300, 200]], 2), 0);
  assert.equal(previewLevel([[1, 1, 1, 5000, 5000], [1, 1, 1, 2500, 2500]], 1), 1);
  // 2 channels × 3000 planes × 1000 × 750 × 2 bytes is 9 GB; the next level, 2.25 GB; then 563 MB.
  assert.equal(previewLevel([[1, 2, 3000, 1000, 750], [1, 2, 3000, 500, 375], [1, 2, 3000, 250, 187]], 2), 2);
  // Even the smallest level of a deep stack is above 1 GB: no preview.
  assert.equal(previewLevel([[1, 2, 20000, 512, 512], [1, 2, 20000, 256, 256]], 4), -1);
  // T is not read: only t = 0 is previewed.
  assert.equal(previewLevel([[1000, 1, 1, 1000, 1000]], 8), 0);
});

test("an archive is refused before conversion when its worst-case store or file count is too large", () => {
  const settings = { version: "0.5", method: "mean", chunk: 256, compressionLevel: 6 };
  assert.equal(archiveRefusal(source(), settings), null);
  // 1 × 1 × 2048 × 512 × 512 uint16 is exactly 1 GiB raw; its pyramid and chunk overhead pass the limit.
  const deep = source({ shape: { t: 1, c: 1, z: 2048, y: 512, x: 512 }, channels: [{ label: null, color: null }] });
  assert.match(archiveRefusal(deep, settings), /can reach 1\.\d+ GiB before compression; an archive is built in memory and holds at most 1 GiB\. Save to a folder instead\./);
  // Small chunks: too many files for a zip without ZIP64.
  const tiled = source({ shape: { t: 1, c: 1, z: 300, y: 1024, x: 1024 }, channels: [{ label: null, color: null }] });
  assert.match(archiveRefusal(tiled, { ...settings, chunk: 64 }), /a zip holds at most 65535/);
  assert.equal(ARCHIVE_MAX_BYTES, 1024 ** 3);
});

test("notes become one line of at most 90 characters, with the detail for its tooltip", () => {
  assert.equal(noteLine([]), null);
  const notes = [
    { summary: "Converts image 1 of 3", detail: "The OME-TIFF holds 3 images; only the first is converted." },
    { summary: "Alpha dropped", detail: "The alpha sample is left out." },
  ];
  assert.deepEqual(noteLine(notes), { text: "Converts image 1 of 3 · Alpha dropped", detail: "The OME-TIFF holds 3 images; only the first is converted. The alpha sample is left out." });
  const many = Array.from({ length: 8 }, (_, index) => ({ summary: `Something changed number ${index}`, detail: `${index}` }));
  const { text } = noteLine(many);
  assert.ok(text.length <= 90, text);
  assert.match(text, /^Something changed number 0 · Something changed number 1 · \+6 more$/);
});

test("outputs are named after the input file, not the image name inside it", () => {
  assert.equal(outputStem({ name: "retina_large crop", stem: "retina-crop" }), "retina-crop");
  assert.equal(outputStem({ name: "x", stem: "a/b:c" }), "a_b_c");
  assert.equal(outputStem({ name: "x", stem: "" }), "image");
});

test("the preview NIfTI is in millimetres: nm and µm are converted, row 0 is at the top", () => {
  const axes = [{ name: "t", type: "time" }, { name: "c", type: "channel" }, { name: "z", type: "space", unit: "micrometer" }, { name: "y", type: "space", unit: "nanometer" }, { name: "x", type: "space", unit: "nanometer" }];
  const [dz, dy, dx] = voxelMillimetres(axes, [1, 1, 0.3, 130, 130]);
  assert.ok(Math.abs(dz - 3e-4) < 1e-15 && Math.abs(dy - 1.3e-4) < 1e-15 && Math.abs(dx - 1.3e-4) < 1e-15);
  assert.deepEqual(voxelMillimetres([{ name: "z" }, { name: "y" }, { name: "x" }], [2, 3, 4]), [2, 3, 4]);
  const file = channelNifti(Uint16Array.from({ length: 2 * 3 * 4 }, (_, i) => i), [2, 3, 4], [dz, dy, dx], "DAPI.nii");
  return file.arrayBuffer().then((buffer) => {
    const header = parseNiftiHeader(buffer);
    assert.deepEqual([header.nx, header.ny, header.nz], [4, 3, 2]);
    assert.equal(header.datatype, 512);
    assert.deepEqual(header.voxelSize.map((value) => Number(value.toPrecision(6))), [1.3e-4, 1.3e-4, 3e-4]);
    assert.equal(Number(header.affine[1][1].toPrecision(6)), -1.3e-4);
    assert.equal(Number(header.affine[1][3].toPrecision(6)), 2.6e-4);
    assert.equal(new Uint16Array(buffer, header.voxOffset, 24)[23], 23);
  });
});

test("channel colours map to NiiVue colormaps", () => {
  assert.deepEqual(["FF0000", "00ff00", "0000FF", "FF00FF", null].map(channelColormap), ["red", "green", "blue", "gray", "gray"]);
});

test("the input preview subsamples Y and X by a power of two and keeps every Z plane", async () => {
  const source = {
    dtype: "uint16",
    shape: { t: 1, c: 2, z: 3, y: 9, x: 5 },
    scale: { t: null, z: 2, y: 0.5, x: 0.5 },
    units: { t: null, z: "micrometer", y: "micrometer", x: "micrometer" },
    readPlane: async (_t, c, z) => Uint16Array.from({ length: 45 }, (_, i) => c * 1000 + z * 100 + i),
  };
  const preview = await readSourcePreview(source, { max: 4 });
  assert.equal(preview.stride, 4);
  assert.deepEqual(preview.shape, [3, 3, 2]);
  assert.deepEqual(preview.spacing, [0.002, 0.002, 0.002]);
  // Row r, column k of plane z is pixel (4r, 4k): index 20r + 4k.
  assert.deepEqual(Array.from(preview.volumes[1].data.subarray(12, 18)), [1200, 1204, 1220, 1224, 1240, 1244]);
  assert.deepEqual(preview.volumes[0].range, [0, 244]);
  assert.equal(await readSourcePreview({ ...source, shape: { t: 1, c: 1, z: 1, y: 65536, x: 32768 } }), null);
});

test("the input preview's ranges cover finite values only", async () => {
  const values = [NaN, Infinity, -Infinity, 3, -2, 5];
  const preview = await readSourcePreview({
    dtype: "float32",
    shape: { t: 1, c: 2, z: 1, y: 2, x: 3 },
    scale: { t: null, z: null, y: null, x: null },
    units: { t: null, z: null, y: null, x: null },
    readPlane: async (_t, c) => Float32Array.from(c ? values.map(() => NaN) : values),
  });
  assert.deepEqual(preview.volumes.map(({ range }) => range), [[-2, 5], [0, 0]]);
});

test("example provenance carries the example's source and licence", () => {
  const attribution = { source: "OME Consortium", license: "CC-BY-4.0" };
  const report = conversionReport({
    source: source({ notes: [{ summary: "Alpha dropped", detail: "The alpha sample is left out." }] }),
    files: ["retina-crop.ome.tif"],
    settings: { version: "0.5", method: "mean", chunk: 256, compressionLevel: 6 },
    written: { plan: [], multiscales: {}, omero: {}, chunksWritten: 0, bytesWritten: 0 },
    seconds: 0,
    attribution,
  });
  assert.deepEqual(report.input.attribution, attribution);
  assert.deepEqual(report.input.notes, ["The alpha sample is left out."]);
});

test("the preview geometry is scaled to 100 mm and locations map back to micrometres", () => {
  const geometry = displayGeometry([32, 515, 771], [2e-4, 2.29e-5, 2.29e-5]);
  assert.ok(Math.abs(771 * geometry.spacing[2] - 100) < 1e-9);
  assert.ok(Math.abs(geometry.spacing[0] / geometry.spacing[2] - 2e-4 / 2.29e-5) < 1e-9);
  const [x, y, z] = trueMicrometres([10 * geometry.spacing[2], geometry.top - 4 * geometry.spacing[1], 3 * geometry.spacing[0]], geometry);
  assert.ok(Math.abs(x - 0.229) < 1e-9 && Math.abs(y - 4 * 0.0229) < 1e-9 && Math.abs(z - 0.6) < 1e-9);
});

test("loading the input preview gives the page turns between synchronous planes", async () => {
  const busy = (ms) => {
    const end = performance.now() + ms;
    while (performance.now() < end);
  };
  const source = {
    dtype: "uint8",
    shape: { t: 1, c: 1, z: 30, y: 8, x: 8 },
    scale: { z: 1, y: 1, x: 1 },
    units: { z: null, y: null, x: null },
    // Like the NIfTI and PNG sources: each plane is ready at once, after some work.
    readPlane() {
      busy(5);
      return new Uint8Array(64);
    },
  };
  let turns = 0;
  let stop = false;
  const tick = () => {
    turns += 1;
    if (!stop) setImmediate(tick);
  };
  setImmediate(tick);
  await readSourcePreview(source);
  stop = true;
  assert.ok(turns >= 3, `the page got ${turns} turns during a 150 ms load`);
});
