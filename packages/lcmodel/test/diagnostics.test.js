// The messages a site reads when something does not work: LCModel's
// diagnostic codes in words, and what loading found for each dataset.
import { test } from "node:test";
import assert from "node:assert/strict";
import { explainDiagnostic } from "../src/lcmodel-io.js";
import * as pipeline from "../src/pipeline.js";
import { readFile } from "node:fs/promises";
import { loadLcmodel } from "../src/wasm.js";
import { loadMessages } from "../src/pipeline.js";

test("MYBASI 10 names both echo times", () => {
  const text = explainDiagnostic("1     ERROR MYBASI 10", { dataTeMs: 40, basisTeMs: 35 });
  assert.ok(text.startsWith("1     ERROR MYBASI 10: "));
  assert.match(text, /basis set's echo time \(35 ms\) differs from the data's \(40 ms\) by 3 ms or more/);
});

test("MYBASI 11 explains PRESS vs STEAM sequence mismatch", () => {
  const text = explainDiagnostic("1     ERROR MYBASI 11");
  assert.ok(text.startsWith("1     ERROR MYBASI 11: "));
  assert.match(text, /PRESS vs STEAM/);
});

test("repeated messages take LCModel's plural levels and are explained the same", () => {
  assert.match(explainDiagnostic("2    ERRORS MYBASI 10", { dataTeMs: 40, basisTeMs: 35 }), /\(35 ms\) differs from the data's \(40 ms\)/);
  assert.match(explainDiagnostic("3    info's RFALSI 12"), /information; the fit is unaffected/);
  assert.match(explainDiagnostic("2  warnings SPLINE 3"), /section 12, for SPLINE 3/);
  assert.match(explainDiagnostic("1 ILLOGICAL CHECK 1"), /section 12, for CHECK 1/);
});

test("information lines are marked harmless and others point to the manual", () => {
  assert.match(explainDiagnostic("1      info RFALSI 12"), /information; the fit is unaffected/);
  assert.match(explainDiagnostic("2     ERROR SETUP 7"), /section 12, for SETUP 7/);
  assert.equal(explainDiagnostic("not a diagnostic"), "not a diagnostic");
});

test("a skipped series is reported once, and every dataset states its TE and voxel", () => {
  const reason = "DICOM without Siemens spectroscopy data; series 21 \"PRESS\", modality MR";
  const lines = loadMessages({
    errors: [],
    ignored: Array.from({ length: 60 }, (_, k) => ({ file: `sub/21-PRESS/${k}.dcm`, reason })),
    unpairedWater: [],
    datasets: [
      { name: "P1", header: { sequence: "PROBE-P", fieldT: 3, teMs: 30, trMs: 2000, voxel: { sizeMm: [20, 20, 20], centerMm: [-28.718, 77.741, 67.582], source: "GE P-file user8-13, tlhc, trhc, brhc" } } },
      { name: "P2", header: { teMs: 30, voxelNote: "GE P-file revision 24: these image header values do not make a voxel box" } },
      { name: "R", header: { sequence: " *svs_se\r\n", teMs: 30 } },
    ],
  });
  assert.deepEqual(lines[0], { text: `sub/21-PRESS/ (60 files): ${reason}`, level: "info" });
  assert.equal(lines[1].text, "P1: sequence PROBE-P, 3.00 T, TE 30 ms, TR 2000 ms; voxel 20 × 20 × 20 mm at -28.7, 77.7, 67.6 mm (RAS), from GE P-file user8-13, tlhc, trhc, brhc");
  assert.deepEqual(lines[2], { text: "P2: TE 30 ms; no voxel: GE P-file revision 24: these image header values do not make a voxel box", level: "warning" });
  assert.equal(lines[3].text, "R: sequence *svs_se, TE 30 ms; voxel position unavailable");
});


test("RAW acquisition diagnostics use known units and effective overrides", () => {
  const input = pipeline.rawInput({ name: "sample.raw", text: " $SEQPAR\n HZPPPM=127.786142\n ECHOT=35\n DWELLTIME=0.0005\n SEQ='PRESS'\n $END\n $NMID\n ID='test'\n $END\n 1 0\n" });
  assert.deepEqual(pipeline.acquisitionMessage(input.name, input.header), {
    text: "sample.raw: sequence PRESS, 127.786142 MHz, TE 35 ms, dwell time 0.5 ms",
    level: "info",
  });
  const acquisition = pipeline.rawAcquisition(input, { frequencyMHz: 123.2, dwellTimeMs: 0.25 });
  assert.deepEqual(pipeline.acquisitionMessage(input.name, { ...input.header, ...acquisition }), {
    text: "sample.raw: sequence PRESS, 123.2 MHz, TE 35 ms, dwell time 0.25 ms",
    level: "info",
  });
  assert.deepEqual(pipeline.acquisitionMessage("unknown.raw", {}), {
    text: "unknown.raw: acquisition parameters unavailable",
    level: "info",
  });
});

test("unrelated flat skipped files retain their identity", () => {
  assert.deepEqual(loadMessages({ errors: [], datasets: [], ignored: [
    { file: "notes.txt", reason: "unrecognized file" },
    { file: "other.txt", reason: "unrecognized file" },
  ] }), [
    { text: "notes.txt: unrecognized file", level: "info" },
    { text: "other.txt: unrecognized file", level: "info" },
  ]);
});

test("committed WASM groups anatomical DICOM for flat and folder selections", async () => {
  function element(group, tag, vr, text) {
    const encoded = new TextEncoder().encode(text);
    const value = encoded.length % 2 ? Uint8Array.from([...encoded, 32]) : encoded;
    const bytes = new Uint8Array(8 + value.length);
    const view = new DataView(bytes.buffer);
    view.setUint16(0, group, true);
    view.setUint16(2, tag, true);
    bytes.set(new TextEncoder().encode(vr), 4);
    view.setUint16(6, value.length, true);
    bytes.set(value, 8);
    return bytes;
  }
  const image = Uint8Array.from([
    ...new Uint8Array(128), ...new TextEncoder().encode("DICM"),
    ...element(8, 0x16, "UI", "1.2.840.10008.5.1.4.1.1.4"),
    ...element(8, 0x60, "CS", "MR"),
    ...element(8, 0x103e, "LO", "LOCALIZER"),
    ...element(0x20, 0x11, "IS", "21"),
  ]);
  const wasm = await readFile(new URL("../src/lcmodel.wasm", import.meta.url));
  for (const prefix of ["", "21-localizer/"]) {
    const engine = await loadLcmodel(wasm);
    engine.addFile(`${prefix}a.dcm`, image);
    engine.addFile(`${prefix}b.dcm`, image);
    const loaded = engine.load();
    assert.deepEqual(loaded.ignored, []);
    assert.deepEqual(loaded.images, [{ name: prefix ? "21-localizer" : "a", files: [`${prefix}a.dcm`, `${prefix}b.dcm`] }]);
    assert.deepEqual(loadMessages(loaded), []);
  }
});


test("flat ignored DICOM files share one diagnostic without hiding unrelated files", () => {
  const reason = "DICOM without Siemens spectroscopy data";
  assert.deepEqual(loadMessages({ errors: [], datasets: [], ignored: [
    { file: "a.dcm", reason },
    { file: "b.dcm", reason },
    { file: "notes.txt", reason: "unrecognized file" },
  ] }), [
    { text: `Selected folder (2 files): ${reason}`, level: "info" },
    { text: "notes.txt: unrecognized file", level: "info" },
  ]);
});
