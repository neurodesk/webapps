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

test("a shaped-pulse set ranks above the ideal set with the same parameters", () => {
  const sets = [
    { id: "slaser-3t-te30", hzpppm: 127.73, teMs: 30, sequence: "sLASER" },
    { id: "slaser-3t-te30-shaped", hzpppm: 127.73, teMs: 30, sequence: "sLASER", shapedPulses: true },
    { id: "slaser-3t-te35", hzpppm: 127.73, teMs: 35, sequence: "sLASER" },
  ];
  const ranked = rankBases({ hzpppm: 123.25, teMs: 30, sequence: "svs_slaser" }, sets);
  assert.deepEqual(ranked.map((r) => r.basis.id), ["slaser-3t-te30-shaped", "slaser-3t-te30", "slaser-3t-te35"]);
  assert.equal(ranked[0].level, "match");
  // A closer echo time still beats pulse shapes.
  assert.equal(recommendBasis({ hzpppm: 123.25, teMs: 35, sequence: "svs_slaser" }, sets).basis.id, "slaser-3t-te35");
});

test("MEGA-PRESS data get the standard difference set; the MM-suppressed one is a warned choice", () => {
  const sets = [
    { id: "megapress-3t-te68-diff", hzpppm: 127.73, teMs: 68, sequence: "MEGA-PRESS", coEditedMM: true },
    { id: "megapress-3t-te80-diff", hzpppm: 127.73, teMs: 80, sequence: "MEGA-PRESS", coEditedMM: true },
    { id: "megapress-3t-te80-mmsup-diff", hzpppm: 127.73, teMs: 80, sequence: "MEGA-PRESS", mmSuppressed: true },
  ];
  const ranked = rankBases({ hzpppm: 123.25, teMs: 80, sequence: "megapress" }, sets);
  assert.deepEqual(ranked.map((r) => r.basis.id), ["megapress-3t-te80-diff", "megapress-3t-te80-mmsup-diff", "megapress-3t-te68-diff"]);
  assert.equal(ranked[0].level, "match");
  assert.equal(ranked[1].level, "warning");
  assert.match(ranked[1].notes.map((n) => n.text).join(" "), /edit-OFF at 1\.5 ppm/);
  assert.equal(recommendBasis({ hzpppm: 123.25, teMs: 68, sequence: "megapress" }, sets).basis.id, "megapress-3t-te68-diff");
});

// What the app shows beside the basis menu and what the pipeline throws:
// menu order, usability, the overall level and each note's level and text.
const field3T = 127.73;
const set = (id, sequence, overrides = {}) => ({ id, hzpppm: field3T, teMs: 30, sequence, ...overrides });
const order = (data, sets) => rankBases(data, sets).map((r) => r.basis.id);
const notes = (r) => r.notes.map((n) => [n.level, n.text]);

test("scanner spellings of semi-LASER all reach the sLASER family", () => {
  for (const name of ["semi-LASER", "semiLASER", "semi_laser", "s-LASER", "s_LASER", "sLASER"]) {
    assert.equal(sequenceFamily(name), "sLASER", name);
  }
  assert.equal(sequenceFamily("LASER"), "LASER");
  assert.equal(sequenceFamily(undefined), null);
  assert.equal(sequenceFamily(null), null);
});

test("Siemens svs_st and svs_se match with a suffix but not inside a longer word", () => {
  assert.equal(sequenceFamily("svs_st_vapor"), "STEAM");
  assert.equal(sequenceFamily("svs_se_30"), "PRESS");
  assert.equal(sequenceFamily("svs_stx"), null);
  assert.equal(sequenceFamily("svs_sex"), null);
});

test("a related sequence family is the next best choice after the same family", () => {
  const related = {
    sLASER: ["LASER", "PRESS"],
    LASER: ["sLASER"],
    PRESS: ["sLASER"],
    SPECIAL: ["STEAM"],
    STEAM: ["SPECIAL"],
  };
  const families = Object.keys(related);
  for (const data of families) {
    // Equal scores fall back to the id, so the unrelated families ("a-")
    // would sort first unless the relation lifts the related ones ("z-").
    const sets = families.filter((f) => f !== data).map((f) => set(`${related[data].includes(f) ? "z" : "a"}-${f}`, f));
    const ranked = rankBases({ hzpppm: field3T, teMs: 30, sequence: data }, sets);
    const top = ranked.slice(0, related[data].length).map((r) => r.basis.sequence);
    assert.deepEqual(top.sort(), [...related[data]].sort(), `${data} data`);
    for (const r of ranked) {
      assert.equal(r.level, "warning");
      assert.deepEqual(notes(r), [["warning", `Basis is ${r.basis.sequence}; the data are ${data}.`]]);
    }
  }
});

test("a basis matching field, sequence and echo time has no notes", () => {
  const r = assessBasis({ hzpppm: 127.765, teMs: 30, sequence: "PRESS" }, set("press", "PRESS"));
  assert.deepEqual([r.usable, r.level, r.notes], [true, "match", []]);
});

test("an unrecorded field strength, sequence or echo time is noted and ranks below a verified match", () => {
  for (const [data, text] of [
    [{ teMs: 30, sequence: "PRESS" }, "The data do not record the field strength."],
    [{ hzpppm: 0, teMs: 30, sequence: "PRESS" }, "The data do not record the field strength."],
    [{ hzpppm: field3T, teMs: 30 }, "The sequence type could not be read from the data."],
    [{ hzpppm: field3T, sequence: "PRESS" }, "The echo time could not be read from the data."],
    [{ hzpppm: field3T, teMs: 0, sequence: "PRESS" }, "The echo time could not be read from the data."],
  ]) {
    const r = assessBasis(data, set("press", "PRESS"));
    assert.deepEqual([r.usable, r.level, notes(r)], [true, "match", [["info", text]]], text);
  }
  // A user's basis whose header omits a parameter cannot be checked against
  // the data, so a library set that verifiably matches comes first.
  const data = { hzpppm: field3T, teMs: 30, sequence: "PRESS" };
  for (const [unknown, text] of [
    [{ hzpppm: null }, "This basis set does not record its field strength."],
    [{ hzpppm: 0 }, "This basis set does not record its field strength."],
    [{ teMs: null }, "This basis set does not record its echo time."],
    [{ teMs: 0 }, "This basis set does not record its echo time."],
  ]) {
    const r = assessBasis(data, set("custom", "PRESS", unknown));
    assert.deepEqual([r.usable, r.level, notes(r)], [true, "match", [["info", text]]], JSON.stringify(unknown));
    assert.deepEqual(order(data, [set("a-custom", "PRESS", unknown), set("z-library", "PRESS")]), ["z-library", "a-custom"], JSON.stringify(unknown));
  }
});

test("a basis for another field strength is an error naming both fields", () => {
  const r = assessBasis({ hzpppm: field3T, teMs: 30, sequence: "PRESS" }, set("press-7t", "PRESS", { hzpppm: 298.03 }));
  assert.deepEqual([r.usable, r.level, notes(r)], [false, "error", [["error", "Simulated at 7.0 T; the data are 3.0 T."]]]);
});

test("a field strength 5-20 % off is a warning with the difference, ranked below the right field", () => {
  const data = { hzpppm: field3T, teMs: 30, sequence: "PRESS" };
  const off = set("a-off", "PRESS", { hzpppm: field3T * 1.1 });
  const r = assessBasis(data, off);
  assert.deepEqual([r.usable, r.level, notes(r)], [true, "warning", [["warning", "Field strength differs by 10%."]]]);
  assert.deepEqual(order(data, [off, set("z-right", "PRESS")]), ["z-right", "a-off"]);
});

test("echo-time differences: up to 2 ms match, up to 5 ms is noted, beyond 15 ms is biased", () => {
  const data = { hzpppm: field3T, teMs: 30, sequence: "PRESS" };
  const at = (teMs) => assessBasis(data, set("press", "PRESS", { teMs }));
  assert.deepEqual([at(32).level, at(32).notes], ["match", []]);
  assert.deepEqual([at(32.5).level, notes(at(32.5))], ["match", [["info", "TE differs by 2.5 ms."]]]);
  assert.deepEqual([at(35).level, notes(at(35))], ["match", [["info", "TE differs by 5 ms."]]]);
  assert.deepEqual([at(45).level, notes(at(45))], ["warning", [["warning", "TE 45 ms vs 30 ms."]]]);
  assert.deepEqual([at(46).level, notes(at(46))], ["warning", [["warning", "TE 46 ms vs 30 ms: coupled metabolites will be biased."]]]);
});

test("edited and unedited spectra say why one cannot stand in for the other", () => {
  const edited = { hzpppm: field3T, teMs: 68, sequence: "MEGA-PRESS" };
  const press = assessBasis(edited, set("press", "PRESS", { teMs: 68 }));
  assert.deepEqual([press.level, notes(press)], ["error", [["error", "Edited data are fitted as a difference spectrum and need a MEGA-PRESS basis."]]]);
  const unnamed = assessBasis(edited, set("custom", null, { teMs: 68 }));
  assert.deepEqual(notes(unnamed), [["warning", "Check that this is a MEGA-PRESS difference basis: its header names no sequence."]]);
  assert.deepEqual(order(edited, [set("a-custom", null, { teMs: 68 }), set("z-mega", "MEGA-PRESS", { teMs: 68 })]), ["z-mega", "a-custom"]);

  const unedited = { hzpppm: field3T, teMs: 68, sequence: "PRESS" };
  const mega = assessBasis(unedited, set("mega", "MEGA-PRESS", { teMs: 68 }));
  assert.deepEqual([mega.level, notes(mega)], ["error", [["error", "This basis set is for edited (MEGA-PRESS) difference spectra."]]]);
  // An unedited spectrum with an unnamed user basis raises no editing question.
  const plain = assessBasis(unedited, set("custom", null, { teMs: 68 }));
  assert.deepEqual([plain.usable, plain.level, plain.notes], [true, "match", []]);
});

test("data of unknown sequence may use a difference basis, with a warning, after an unedited one", () => {
  const data = { hzpppm: field3T, teMs: 68 };
  const mega = assessBasis(data, set("mega", "MEGA-PRESS", { teMs: 68 }));
  assert.deepEqual([mega.usable, mega.level, notes(mega)], [true, "warning", [["warning", "This basis set is for edited (MEGA-PRESS) difference spectra."]]]);
  assert.deepEqual(order(data, [set("a-mega", "MEGA-PRESS", { teMs: 68 }), set("z-press", "PRESS", { teMs: 68 })]), ["z-press", "a-mega"]);
});

test("an empty library recommends nothing", () => {
  assert.equal(recommendBasis({ hzpppm: field3T, teMs: 30, sequence: "PRESS" }, []), null);
});

test("a .BASIS header is read whatever its case, spacing and exponent letter", () => {
  const h = parseBasisHeader(" $seqpar\n hzpppm=1.2773D2,\n echot = 3.0E1,\n seq='  sLASER '\n idbasi = ' my set '\n $end\n metabo='NAA'\n METABO = ' GABA '\n");
  assert.deepEqual(h, { hzpppm: 127.73, teMs: 30, sequence: "sLASER", id: "my set", metabolites: ["NAA", "GABA"] });
  // A header without SEQ has no sequence, not the next quoted value.
  const bare = parseBasisHeader(" $BASIS1\n IDBASI = 'FID-A press-3t-te30',\n $END\n METABO = 'NAA'\n");
  assert.deepEqual([bare.hzpppm, bare.teMs, bare.sequence], [null, null, null]);
});

test("STEAM basis selection prefers matching mixing time and notes unverified or mismatched TM", () => {
  const unknown = set("a-steam-custom", "STEAM", { teMs: 20 });
  const tm10 = set("b-steam-tm10", "STEAM", { teMs: 20, tmMs: 10 });
  const tm32 = set("z-steam-tm32", "STEAM", { teMs: 20, tmMs: 32 });
  const data = { hzpppm: field3T, teMs: 20, tmMs: 32, sequence: "svs_st" };
  const ranked = rankBases(data, [unknown, tm10, tm32]);
  assert.deepEqual(ranked.map((r) => r.basis.id), ["z-steam-tm32", "a-steam-custom", "b-steam-tm10"]);
  assert.deepEqual([ranked[0].level, ranked[0].notes], ["match", []]);
  assert.deepEqual([ranked[1].level, notes(ranked[1])], ["match", [["info", "This basis set does not record its mixing time."]]]);
  assert.equal(ranked[2].level, "warning");
  assert.match(ranked[2].notes.map((n) => n.text).join(" "), /TM 10 ms vs 32 ms/);

  const noDataTm = assessBasis({ hzpppm: field3T, teMs: 20, sequence: "svs_st" }, tm32);
  assert.deepEqual([noDataTm.usable, noDataTm.level, notes(noDataTm)], [true, "match", [["info", "The mixing time could not be read from the data."]]]);
});
