// Settings validation, theoretical resolution, OME optics and output tables.
import { test } from "node:test";
import assert from "node:assert/strict";
import { APP, SettingsError, boxHalfWidth, checkStack, readSettings, saturationLevel, suggestedAnalysis } from "../src/config.js";
import { omeOptics, theoreticalResolution } from "../src/core/optics.js";
import { beadsCsv, csv, outputStem } from "../src/outputs.js";
import { displayAffine, displaySpacing } from "../src/display.js";

const PSF = { analysis: "psf", microscope: "widefield", na: "0.95", refractiveIndex: "1", emission: "525", excitation: "", pixelX: "0.126", pixelY: "0.126", zStep: "0.133", boxRadius: "", prominence: "", minR2: "0.95", excludeSaturated: true };

test("app id is lowercase kebab-case and the config is frozen", () => {
  assert.match(APP.id, /^[a-z][a-z0-9-]*$/);
  assert.ok(Object.isFrozen(APP));
});

test("theoretical resolution follows Faklaris et al. 2022", () => {
  const wf = theoreticalResolution({ type: "widefield", na: 0.95, refractiveIndex: 1, emission: 525 });
  assert.ok(Math.abs(wf.lateral - (0.51 * 0.525) / 0.95) < 1e-15);
  assert.ok(Math.abs(wf.axial - (1.77 * 0.525) / 0.95 ** 2) < 1e-15);
  const cf = theoreticalResolution({ type: "confocal", na: 1.4, refractiveIndex: 1.518, excitation: 488 });
  assert.ok(Math.abs(cf.axial - (0.88 * 0.488) / (1.518 - Math.sqrt(1.518 ** 2 - 1.96))) < 1e-15);
  assert.ok(Math.abs(theoreticalResolution({ type: "multiphoton", na: 1, refractiveIndex: 1.33, excitation: 900 }).lateral - (0.383 * 0.9) / 1) < 1e-15);
  assert.throws(() => theoreticalResolution({ type: "confocal", na: 1.4, refractiveIndex: 1.518, emission: 520 }), /excitation/);
  assert.throws(() => theoreticalResolution({ type: "widefield", na: 1.4, refractiveIndex: 1.33, emission: 520 }), /below/);
});

test("OME optics are read whatever the prefix, quote style or entities", () => {
  const xml = `<?xml version="1.0"?><ome:OME xmlns:ome="http://www.openmicroscopy.org/Schemas/OME/2016-06"><ome:Instrument><ome:Objective ID='Objective:0' LensNA='1.4' Immersion="Oil"/></ome:Instrument><ome:Image><ome:ObjectiveSettings ID="Objective:0" RefractiveIndex="1.518"/><ome:Pixels><ome:Channel AcquisitionMode="LaserScanningConfocalMicroscopy" ExcitationWavelength="0.488" ExcitationWavelengthUnit="&#181;m" EmissionWavelength="520"/></ome:Pixels></ome:Image></ome:OME>`;
  assert.deepEqual(omeOptics(xml), { na: 1.4, refractiveIndex: 1.518, emission: 520, excitation: 488, type: "confocal" });
  assert.deepEqual(omeOptics("ImageJ=1.53"), { na: null, refractiveIndex: null, emission: null, excitation: null, type: null });
  assert.equal(omeOptics('<OME><Objective LensNA="0.3" Immersion="Air"/></OME>').refractiveIndex, 1);
});

test("PSF settings need the optics and voxel size; field settings do not", () => {
  const settings = readSettings(PSF);
  assert.equal(settings.zStep, 0.133);
  assert.equal(boxHalfWidth(settings), Math.round((4 * settings.theory.lateral) / 0.126));
  assert.equal(boxHalfWidth({ ...settings, boxRadius: 1 }), 8);
  for (const field of ["na", "pixelX", "zStep", "emission", "minR2"]) {
    assert.throws(() => readSettings({ ...PSF, [field]: "" }), (error) => error instanceof SettingsError && error.field === field);
  }
  assert.throws(() => readSettings({ ...PSF, na: "1.2" }), (error) => error.field === "na");
  assert.throws(() => readSettings({ ...PSF, microscope: "confocal" }), (error) => error.field === "excitation");
  assert.deepEqual(readSettings({ analysis: "field", step: "10", blur: true, referenceZone: false }), { analysis: "field", blur: true, referenceZone: false, step: 10 });
  assert.throws(() => readSettings({ analysis: "field", step: "0" }), (error) => error.field === "step");
});

test("stacks the app cannot interpret are refused from their headers", () => {
  const base = { width: 512, height: 512, pages: 81, metadata: { kind: "ome", images: 1, sizeC: 1, sizeZ: 81, sizeT: 1 } };
  assert.doesNotThrow(() => checkStack(base));
  assert.throws(() => checkStack({ ...base, metadata: { ...base.metadata, images: 2 } }), /series/);
  assert.throws(() => checkStack({ ...base, metadata: { ...base.metadata, sizeC: 3 } }), /channels/);
  assert.throws(() => checkStack({ ...base, metadata: { ...base.metadata, sizeZ: 1, sizeT: 81 } }), /time series/);
  assert.throws(() => checkStack({ ...base, pages: 4000, width: 2048, height: 2048 }), /limit/);
  assert.equal(saturationLevel("uint8"), 255);
  assert.equal(saturationLevel("float32"), null);
  assert.equal(suggestedAnalysis(81), "psf");
  assert.equal(suggestedAnalysis(1), "field");
});

test("tables quote text and keep numbers short; names lose the TIFF extension", () => {
  assert.equal(csv(["a", "b"], [["x, y", 1 / 3], [null, NaN]]), 'a,b\n"x, y",0.33333333\n,\n');
  assert.equal(outputStem("beads.ome.tif"), "beads");
  assert.equal(outputStem("field.TIFF"), "field");
  const text = beadsCsv([{ id: 1, peakX: 3, peakY: 4, prominence: 50, rejection: "edge" }], { x: 0.1, y: 0.1, z: 0.2 });
  assert.match(text.split("\n")[1], /^1,rejected: box leaves the image,3,4,,0\.3,0\.4,/);
});

test("the viewer's NIfTI spacing is the voxel size in millimetres", () => {
  assert.deepEqual(displaySpacing({ x: 0.126, y: 0.126, z: 0.133 }), [0.000126, 0.000126, 0.000133]);
  assert.deepEqual(displayAffine(512, [0.000126, 0.000126, 0.000133])[1], [0, -0.000126, 0, 511 * 0.000126]);
});
