import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { classifyText, parseControl, parseRaw, sortInputs, textHead } from "../src/inputs.js";

const native = new URL("../../../exes/lcmodel/tests/data/test_lcm/", import.meta.url);

test("recognises LCModel's text files", async () => {
  const raw = await readFile(new URL("data.raw", native), "utf8");
  const basis = await readFile(new URL("3t.basis", native), "utf8");
  const control = await readFile(new URL("control.file", native), "utf8");
  assert.equal(classifyText(raw.slice(0, 4096)), "raw");
  assert.equal(classifyText(basis.slice(0, 4096)), "basis");
  assert.equal(classifyText(control.slice(0, 4096)), "control");
  assert.equal(classifyText("\u0000\u0001binary"), null);
  assert.deepEqual(parseControl(control), { hzpppm: 127.786142, deltat: 5e-4, nunfil: 1024, teMs: null });
  const r = parseRaw(raw);
  assert.equal(r.points, 1024);
  assert.equal(r.hzpppm, null);
});

test("reads FID-A's $SEQPAR header", () => {
  const text = " $SEQPAR\n echot= 35.00\n seq= 'PRESS'\n hzpppm= 127.765000\n NumberOfPoints= 2\n dwellTime= 0.000200\n $END\n $NMID\n id='ANONYMOUS ', fmtdat='(2E15.6)'\n volume=8.0\n tramp=1.0\n $END\n  1.000000e+00  2.000000e+00\n  3.000000e+00 -4.000000e+00\n";
  assert.deepEqual(parseRaw(text), { points: 2, hzpppm: 127.765, teMs: 35, deltat: 2e-4, sequence: "PRESS" });
});

test("sorts dropped files and pairs water by name", () => {
  const nmid = " $NMID\n $END\n 1 2\n";
  const sorted = sortInputs([
    { name: "met.raw", head: nmid },
    { name: "met_w.raw", head: nmid },
    { name: "met.h2o", head: nmid },
    { name: "b.basis", head: " $BASIS1\n" },
    { name: "c.control", head: " $LCMODL\n" },
    { name: "meas.dat", head: "" },
  ]);
  assert.deepEqual(sorted.raw.map((f) => f.name), ["met.raw"]);
  assert.deepEqual(sorted.water.map((f) => f.name), ["met_w.raw", "met.h2o"]);
  assert.equal(sorted.basis.length, 1);
  assert.equal(sorted.control.length, 1);
  assert.equal(sorted.other.length, 1);
  assert.equal(textHead(new Uint8Array([0, 0, 0, 0, 0, 1, 2])), "");
  assert.equal(textHead(new TextEncoder().encode(" $NMID")), " $NMID");
});
