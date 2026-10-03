import { test } from "node:test";
import assert from "node:assert/strict";
import { sequenceFamily, assessBasis, rankBases, recommendBasis, parseBasisHeader } from "../src/basis-select.js";

const lib = [
  { id: "press-3t-te30", hzpppm: 127.73, teMs: 30, sequence: "PRESS" },
  { id: "press-3t-te35", hzpppm: 127.73, teMs: 35, sequence: "PRESS" },
  { id: "press-3t-te144", hzpppm: 127.73, teMs: 144, sequence: "PRESS" },
  { id: "steam-3t-te20", hzpppm: 127.73, teMs: 20, sequence: "STEAM" },
  { id: "special-3t-te8.5", hzpppm: 127.73, teMs: 8.5, sequence: "SPECIAL" },
  { id: "slaser-7t-te28", hzpppm: 298.03, teMs: 28, sequence: "sLASER" },
  { id: "megapress-3t-te68-diff", hzpppm: 127.73, teMs: 68, sequence: "MEGA-PRESS" },
];

test("sequence names map to families", () => {
  assert.equal(sequenceFamily("%CustomerSeq%\\jn_svs_special_dev"), "SPECIAL");
  assert.equal(sequenceFamily("%SiemensSeq%\\svs_se"), "PRESS");
  assert.equal(sequenceFamily("svs_st"), "STEAM");
  assert.equal(sequenceFamily("svs_slaser_dkd"), "sLASER");
  assert.equal(sequenceFamily("PROBE-P"), "PRESS");
  assert.equal(sequenceFamily("megapress"), "MEGA-PRESS");
  assert.equal(sequenceFamily(""), null);
});

test("the GE PRESS TE 35 example gets the TE 35 PRESS basis", () => {
  const best = recommendBasis({ hzpppm: 127.765, teMs: 35, sequence: "PRESS" }, lib);
  assert.equal(best.basis.id, "press-3t-te35");
  assert.equal(best.level, "match");
});

test("Siemens 2.89 T SPECIAL TE 8.5 gets the SPECIAL basis within the field tolerance", () => {
  const best = recommendBasis({ hzpppm: 123.247, teMs: 8.5, sequence: "jn_svs_special" }, lib);
  assert.equal(best.basis.id, "special-3t-te8.5");
});

test("a 7 T basis is unusable for 3 T data and ranks last", () => {
  const ranked = rankBases({ hzpppm: 127.7, teMs: 30, sequence: "PRESS" }, lib);
  const sevenT = ranked.find((r) => r.basis.id === "slaser-7t-te28");
  assert.equal(sevenT.usable, false);
  assert.ok(ranked.indexOf(sevenT) > ranked.findLastIndex((r) => r.usable));
  assert.equal(ranked[0].basis.id, "press-3t-te30");
});

test("long-TE data flag a short-TE basis", () => {
  const r = assessBasis({ hzpppm: 127.7, teMs: 144, sequence: "PRESS" }, lib[0]);
  assert.equal(r.level, "warning");
  assert.match(r.notes.map((n) => n.text).join(" "), /biased/);
  assert.equal(recommendBasis({ hzpppm: 127.7, teMs: 144, sequence: "PRESS" }, lib).basis.id, "press-3t-te144");
});

test("no usable basis gives no recommendation", () => {
  assert.equal(recommendBasis({ hzpppm: 63.9, teMs: 30, sequence: "PRESS" }, [lib[5]]), null);
});

test("reads a .BASIS header", () => {
  const h = parseBasisHeader(" $SEQPAR\n FWHMBA = 0.011743,\n HZPPPM = 127.731000,\n ECHOT = 30.00,\n SEQ = 'PRESS' $END\n $BASIS1\n IDBASI = 'FID-A press-3t-te30',\n $END\n $BASIS\n ID = 'Ala',\n METABO = 'Ala',\n $END\n $BASIS\n METABO = 'Asp',\n");
  assert.deepEqual([h.hzpppm, h.teMs, h.sequence, h.id], [127.731, 30, "PRESS", "FID-A press-3t-te30"]);
  assert.deepEqual(h.metabolites, ["Ala", "Asp"]);
});

test("edited data get the MEGA-PRESS difference basis and nothing else", () => {
  const data = { hzpppm: 123.247, teMs: 68, sequence: "%CustomerSeq%\\jn_MEGA_GABA" };
  const ranked = rankBases(data, lib);
  assert.equal(ranked[0].basis.id, "megapress-3t-te68-diff");
  assert.equal(ranked[0].level, "match");
  assert.ok(ranked.slice(1).every((r) => !r.usable), "unedited basis sets are unusable for a difference spectrum");
});

test("unedited data never get the difference basis", () => {
  const r = assessBasis({ hzpppm: 127.7, teMs: 68, sequence: "PRESS" }, lib.at(-1));
  assert.equal(r.usable, false);
  assert.notEqual(recommendBasis({ hzpppm: 127.7, teMs: 68, sequence: "PRESS" }, lib).basis.id, "megapress-3t-te68-diff");
});

test("a user basis that names no sequence is usable for edited data, with a warning", () => {
  const a = assessBasis({ hzpppm: 127.75, teMs: 68, sequence: "MEGA-PRESS" }, { id: "custom", hzpppm: 127.73, teMs: 68, sequence: null });
  assert.equal(a.usable, true);
  assert.equal(a.level, "warning");
  const b = assessBasis({ hzpppm: 127.75, teMs: 68, sequence: "MEGA-PRESS" }, { id: "custom", hzpppm: 127.73, teMs: 68, sequence: "PRESS" });
  assert.equal(b.usable, false);
});
