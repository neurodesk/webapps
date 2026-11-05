import { test } from "node:test";
import assert from "node:assert/strict";
import { readSwc, writeSwc } from "../src/morph/swc.js";
import { analyse, buildMorphology, measure, shollCrossings } from "../src/morph/morphometrics.js";
import { bifurcationsCsv, morphometricsCsv, shollCsv } from "../src/morph/outputs.js";
import { morphologyMesh, TYPE_COLORS } from "../src/morph/tubes.js";

const codes = (issues) => issues.map((issue) => issue.code).sort();
const swc = (...rows) => rows.join("\n");

// A soma and one basal dendrite along x that forks at x = 10 into two 10 µm branches.
const FORK = swc(
  "# soma, then a basal dendrite",
  "1 1 0 0 0 5 -1",
  "2 3 5 0 0 1 1",
  "3 3 10 0 0 1 2",
  "4 3 10 10 0 0.5 3",
  "5 3 20 0 0 0.5 3",
);

test("a clean file has no issues and the expected tree", () => {
  const { samples, issues } = readSwc(FORK);
  assert.deepEqual(issues, []);
  const morphology = buildMorphology(samples);
  assert.deepEqual(morphology.center, [0, 0, 0]);
  assert.equal(morphology.neurites.length, 1);
  const features = measure(morphology);
  assert.equal(features.sections, 3);
  assert.equal(features.bifurcations, 1);
  assert.equal(features.terminals, 2);
  assert.equal(features.totalLength, 25);
  assert.equal(features.maxPathDistance, 15);
  assert.equal(features.maxBranchOrder, 1);
  assert.equal(features.maxStrahlerOrder, 2);
  assert.ok(Math.abs(features.localBifurcationAngles[0] - Math.PI / 2) < 1e-12);
  assert.equal(features.maxRadialDistance, 20);
});

test("frustum surface and volume match the analytic cone", () => {
  const { samples } = readSwc(swc("1 1 0 0 0 1 -1", "2 2 0 0 0 2 1", "3 2 0 0 3 1 2"));
  const features = measure(buildMorphology(samples));
  assert.ok(Math.abs(features.surfaceArea - Math.PI * 3 * Math.hypot(1, 3)) < 1e-9);
  assert.ok(Math.abs(features.volume - (Math.PI * 3 * (4 + 2 + 1)) / 3) < 1e-9);
});

test("structural faults are always repaired and reported", () => {
  const text = swc(
    "1 1 0 0 0 5 -1",
    "not a sample line",
    "3 3 10 0 0 1 2", // listed before its parent
    "2 3 5 0 0 1 1",
    "2 3 99 99 99 1 1", // repeated id
    "4 3 0 5 0 1 42", // missing parent
    "5 3 0 6 0 1 6", // 5 and 6 form a cycle
    "6 3 0 7 0 1 5",
  );
  const { samples, issues } = readSwc(text);
  assert.deepEqual(codes(issues.filter((issue) => issue.severity === "error")), ["cycle", "duplicate-id", "malformed-line", "missing-parent"]);
  assert.ok(issues.filter((issue) => issue.severity === "error").every((issue) => issue.repaired));
  assert.deepEqual(issues.find((issue) => issue.code === "malformed-line").lines, [2]);
  assert.deepEqual(issues.find((issue) => issue.code === "duplicate-id").lines, [5]);
  assert.ok(codes(issues).includes("unsorted"));
  const order = samples.map((s) => s.id);
  assert.ok(order.indexOf(2) < order.indexOf(3), "parents come first");
  assert.ok(codes(issues).includes("disconnected-neurite"));
  assert.equal(buildMorphology(samples).neurites.length, 3);
});

test("zero radii and repeated points are repaired only on request", () => {
  const text = swc("1 1 0 0 0 5 -1", "2 3 5 0 0 1 1", "3 3 5 0 0 0 2", "4 3 10 0 0 0 3", "5 3 10 5 0 2 4", "6 3 15 0 0 1 4");
  const raw = readSwc(text, { repair: false });
  assert.deepEqual(codes(raw.issues), ["nonpositive-radius", "zero-length-segment"]);
  assert.ok(raw.issues.every((issue) => !issue.repaired));
  assert.equal(raw.samples.length, 6);
  const fixed = readSwc(text);
  assert.deepEqual(codes(fixed.issues), ["nonpositive-radius", "zero-length-segment"]);
  assert.ok(fixed.issues.every((issue) => issue.repaired));
  assert.deepEqual(fixed.samples.map((s) => s.id), [1, 2, 4, 5, 6]);
  assert.equal(fixed.samples.find((s) => s.id === 4).parent, 2);
  assert.equal(fixed.samples.find((s) => s.id === 4).r, 1, "the nearest positive radius above");
  assert.equal(measure(buildMorphology(fixed.samples)).totalLength, measure(buildMorphology(raw.samples)).totalLength);
});

test("a type change without branching starts a section; a multifurcation has no angle", () => {
  const text = swc("1 1 0 0 0 5 -1", "2 3 0 5 0 1 1", "3 2 0 10 0 1 2", "4 2 5 15 0 1 3", "5 2 -5 15 0 1 3", "6 2 0 20 0 1 3");
  const { samples, issues } = readSwc(text);
  assert.deepEqual(codes(issues), ["multifurcation", "type-change"]);
  const features = measure(buildMorphology(samples));
  assert.equal(features.sections, 5);
  assert.equal(features.bifurcations, 0);
  assert.equal(features.forkingPoints, 1);
  assert.deepEqual(features.localBifurcationAngles, []);
  assert.equal(features.maxBranchOrder, 2);
});

test("no soma: distances run from the first sample, and the file still measures", () => {
  const { samples, issues } = readSwc(swc("1 3 0 0 0 1 -1", "2 3 0 0 40 1 1"));
  assert.deepEqual(codes(issues), ["no-soma", "z-jump"]);
  const morphology = buildMorphology(samples);
  assert.deepEqual(morphology.center, [0, 0, 0]);
  assert.equal(measure(morphology).maxRadialDistance, 40);
});

test("an empty file is refused", () => {
  assert.throws(() => readSwc("# only a comment\n"), /no SWC samples/);
});

test("Sholl counts a branch each time it crosses a sphere, including on the sphere", () => {
  // Out to 15, back to 5 and out to 25 along x: radii 10 and 15 are each crossed three times.
  const { samples } = readSwc(swc("1 1 0 0 0 1 -1", "2 3 1 0 0 1 1", "3 3 15 0 0 1 2", "4 3 5 1 0 1 3", "5 3 25 1 0 1 4"));
  assert.deepEqual(shollCrossings(buildMorphology(samples), [10, 15, 30]), [3, 3, 0]);
});

test("written SWC reads back to the same samples", () => {
  const { samples } = readSwc(FORK);
  const again = readSwc(writeSwc(samples, ["round trip"]));
  assert.deepEqual(again.samples.map(({ line, ...s }) => s), samples.map(({ line, ...s }) => s));
  assert.match(writeSwc(samples, ["round trip"]), /^# round trip\n1 1 0 0 0 5 -1\n/);
});

test("the tables carry one row per neuron and type, radius and bifurcation", () => {
  const { samples } = readSwc(FORK);
  const neurons = [{ name: "fork.swc", analysis: analyse(buildMorphology(samples), 5) }];
  const morphometrics = morphometricsCsv(neurons).trim().split("\n");
  assert.equal(morphometrics.length, 3, "header, all and basal");
  assert.match(morphometrics[0], /^neuron,neurite_type,neurites,sections,bifurcations,/);
  assert.match(morphometrics[1], /^fork\.swc,all,1,3,1,1,2,25,/);
  assert.match(morphometrics[1], /,90,90$/);
  assert.deepEqual(shollCsv(neurons).trim().split("\n").slice(0, 3), [
    "neuron,radius_um,all_intersections,axon_intersections,basal_intersections,apical_intersections",
    "fork.swc,5,1,0,1,0",
    "fork.swc,10,3,0,3,0",
  ]);
  assert.deepEqual(bifurcationsCsv(neurons).trim().split("\n")[1], "fork.swc,basal,0,5,10,90,90");
});

test("the mesh is a tube per section and a sphere per soma sample, coloured by type", () => {
  const { samples } = readSwc(FORK);
  const mesh = morphologyMesh(buildMorphology(samples), 20);
  const vertices = mesh.vertices.length / 3;
  assert.equal(vertices, 7 * 8 + (2 + 2 + 2) * 8, "a 7-ring soma sphere and two rings per two-point section");
  assert.equal(mesh.colors.length, vertices * 4);
  assert.ok(Math.max(...mesh.faces) < vertices);
  assert.deepEqual([...mesh.colors.slice(-4)], TYPE_COLORS[3]);
  assert.deepEqual(mesh.types, [1, 3]);
});

test("a neurite's zero radius never borrows the soma's", () => {
  const { samples } = readSwc(swc("1 1 0 0 0 5 -1", "2 2 0 5 0 0 1", "3 2 0 10 0 1.5 2"));
  assert.equal(samples.find((s) => s.id === 2).r, 1.5);
});

test("repairing a long chain of zero radii takes linear time", () => {
  const rows = ["1 1 0 0 0 5 -1"];
  // No positive radius anywhere in the dendrite: every sample searches and finds nothing.
  for (let id = 2; id <= 50001; id++) rows.push(`${id} 3 ${id} 0 0 0 ${id - 1}`);
  const text = rows.join("\n");
  // The fastest of two reads with and without repair; the difference is the repair's cost.
  const time = (repair) => Math.min(...[0, 1].map(() => {
    const start = performance.now();
    readSwc(text, { repair });
    return performance.now() - start;
  }));
  const extra = time(true) - time(false);
  assert.ok(extra < 500, `repairing 50,000 zero radii added ${Math.round(extra)} ms`);
  const { issues } = readSwc(text);
  assert.deepEqual(issues.map(({ code, repaired }) => [code, repaired]), [["nonpositive-radius", false]]);
  const tip = readSwc(`${text}\n50002 3 50002 0 0 0.5 50001`).samples;
  assert.ok(tip.filter((s) => s.type === 3).every((s) => s.r === 0.5), "with a positive tip, each takes its radius from below");
});

test("repair takes the nearest positive radius above, else the nearest below", () => {
  // 2 (0) -> 3 (0) -> {4 (0) -> 6 (3), 5 (2)}: nothing above, so 2 and 3 take 5's radius, one step nearer than 6's.
  const text = swc("1 1 0 0 0 5 -1", "2 3 1 0 0 0 1", "3 3 2 0 0 0 2", "4 3 3 1 0 0 3", "5 3 3 -1 0 2 3", "6 3 4 1 0 3 4", "7 3 5 1 0 0 6");
  const radius = Object.fromEntries(readSwc(text).samples.map((s) => [s.id, s.r]));
  assert.deepEqual(radius, { 1: 5, 2: 2, 3: 2, 4: 3, 5: 2, 6: 3, 7: 3 });
});

for (const [kind, radius] of [["zero", "0"], ["negative", "-1"]]) {
  test(`a neurite of only ${kind} radii stays unrepaired, reported, with area and volume blank`, () => {
    const { samples, issues } = readSwc(swc("1 1 0 0 0 5 -1", `2 3 5 0 0 ${radius} 1`, `3 3 10 0 0 ${radius} 2`));
    const unrepaired = issues.filter((issue) => issue.code === "nonpositive-radius");
    assert.equal(unrepaired.length, 1);
    assert.equal(unrepaired[0].repaired, false);
    assert.deepEqual(unrepaired[0].lines, [2, 3]);
    assert.match(unrepaired[0].message, /left blank/);
    const analysis = analyse(buildMorphology(samples), 5, { unknownZeroRadii: true });
    assert.equal(analysis.features.all.surfaceArea, null);
    assert.equal(analysis.features.basal.volume, null);
    assert.equal(analysis.features.all.totalLength, 5, "length does not depend on radius");
    const row = morphometricsCsv([{ name: "x.swc", analysis }]).split("\n")[1].split(",");
    assert.deepEqual([row[8], row[9]], ["", ""], "surface_area_um2 and volume_um3 are blank");
  });
}

test("without repair a zero radius is measured as NeuroM does, a negative one is not", () => {
  const zero = readSwc(swc("1 1 0 0 0 5 -1", "2 3 5 0 0 0 1", "3 3 10 0 0 1 2"), { repair: false });
  assert.equal(measure(buildMorphology(zero.samples)).surfaceArea, Math.PI * Math.hypot(1, 5));
  assert.doesNotMatch(zero.issues.find((issue) => issue.code === "nonpositive-radius").message, /blank/);
  const negative = readSwc(swc("1 1 0 0 0 5 -1", "2 3 5 0 0 -1 1", "3 3 10 0 0 1 2"), { repair: false });
  assert.equal(measure(buildMorphology(negative.samples)).surfaceArea, null);
  assert.match(negative.issues.find((issue) => issue.code === "nonpositive-radius").message, /left blank/);
});

test("the header comments are kept for the repaired file, before the repair note", () => {
  const text = swc("# ORIGINAL_SOURCE Neurolucida", "# CONTRIBUTOR Turner_DA", "#REFERENCE doi:10.0/x", "1 1 0 0 0 5 -1", "2 3 5 0 0 0 1", "3 3 10 0 0 1 2  # inline");
  const { samples, header } = readSwc(text);
  assert.deepEqual(header, ["# ORIGINAL_SOURCE Neurolucida", "# CONTRIBUTOR Turner_DA", "#REFERENCE doi:10.0/x"]);
  const written = writeSwc(samples, [...header, "Repaired by NeuroMorph"]);
  assert.match(written, /^# ORIGINAL_SOURCE Neurolucida\n# CONTRIBUTOR Turner_DA\n#REFERENCE doi:10\.0\/x\n# Repaired by NeuroMorph\n1 1 0 0 0 5 -1\n/);
});

test("Sholl counts match counting every radius for every segment", () => {
  // A random walk that wanders in and out, with segment ends landing exactly on spheres.
  let seed = 7;
  const random = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  const rows = ["1 1 0 0 0 1 -1"];
  for (let id = 2; id < 400; id++) {
    const parent = id === 2 ? 1 : 2 + Math.floor(random() * (id - 2));
    const step = () => Math.round((random() - 0.5) * 60);
    rows.push(`${id} ${2 + (id % 3)} ${step()} ${step()} ${step()} 1 ${parent}`);
  }
  const morphology = buildMorphology(readSwc(rows.join("\n")).samples);
  const radii = Array.from({ length: 60 }, (_, k) => k + 1);
  const brute = new Array(radii.length).fill(0);
  const [cx, cy, cz] = morphology.center;
  const d2 = (p) => (p[0] - cx) ** 2 + (p[1] - cy) ** 2 + (p[2] - cz) ** 2;
  for (const neurite of morphology.neurites) {
    for (const { points } of neurite.sections) {
      for (let k = 1; k < points.length; k++) {
        const [low, high] = [Math.min(d2(points[k - 1]), d2(points[k])), Math.max(d2(points[k - 1]), d2(points[k]))];
        radii.forEach((r, i) => { if (low <= r * r && r * r <= high) brute[i]++; });
      }
    }
  }
  assert.deepEqual(shollCrossings(morphology, radii), brute);
  assert.ok(brute.some((count) => count > 0));
});

test("a repeated point lends its radius before it is merged", () => {
  const { samples, issues } = readSwc(swc("1 1 0 0 0 5 -1", "2 3 5 0 0 0 1", "3 3 5 0 0 2 2", "4 3 10 0 0 0 3"));
  assert.deepEqual(samples.map((s) => [s.id, s.r]), [[1, 5], [2, 2], [4, 2]]);
  assert.ok(!issues.some((issue) => issue.code === "nonpositive-radius" && !issue.repaired));
  const features = measure(buildMorphology(samples), 3, { unknownZeroRadii: true });
  assert.ok(features.surfaceArea > 0);
  assert.ok(features.volume > 0);
});

test("a whole neurite counts under its first sample's type, as NeuroM does", () => {
  // NeuroM 4.0.6 gives basal total_length 12 and 3 sections for this file.
  const { samples, issues } = readSwc(swc("1 1 0 0 0 1 -1", "2 3 0 1 0 0.5 1", "3 3 0 2 0 0.5 2", "4 3 1 2 0 0.5 3", "5 7 0 12 0 0.5 3"));
  const analysis = analyse(buildMorphology(samples), 5);
  assert.equal(analysis.features.basal.totalLength, 12);
  assert.equal(analysis.features.basal.sections, 3);
  assert.deepEqual(analysis.sholl.crossings.basal, analysis.sholl.crossings.all);
  const custom = issues.find((issue) => issue.code === "custom-type");
  assert.match(custom.message, /a neurite counts under the type of its first sample/);
  assert.doesNotMatch(custom.message, /; counted under All only$/);
});

test("a type-1 sample inside a neurite borrows a neurite radius, as it is measured", () => {
  const { samples, issues } = readSwc(swc("1 1 0 0 0 5 -1", "2 3 5 0 0 1 1", "3 1 10 0 0 0 2", "4 3 15 0 0 1 3"));
  assert.equal(samples.find((s) => s.id === 3).r, 1);
  assert.ok(issues.some((issue) => issue.code === "nonpositive-radius" && issue.repaired));
  const features = measure(buildMorphology(samples), 3, { unknownZeroRadii: true });
  assert.equal(features.zeroRadii, 0);
  assert.ok(features.surfaceArea > 0);
});

test("a header entry with line breaks is written as comment lines", () => {
  const { samples } = readSwc(FORK);
  const text = writeSwc(samples, ["# original", "Repaired from evil\n9 3 1 1 1 1 1\r\n=cmd"]);
  assert.ok(text.split("\n").filter((line) => line.trim() && !/^\d/.test(line)).every((line) => line.startsWith("#")));
  const reread = readSwc(text, { repair: false });
  assert.deepEqual(reread.samples.map((s) => s.id), samples.map((s) => s.id));
  assert.deepEqual(reread.issues, []);
});

test("text a spreadsheet would run as a formula is neutralised in every table", () => {
  const { samples } = readSwc(FORK);
  const analysis = analyse(buildMorphology(samples), 5);
  const names = ["=HYPERLINK(1)", "+1", "-cmd", "@SUM(A1)", "\tx", "\rx"];
  const neurons = names.map((name) => ({ name, analysis }));
  for (const table of [morphometricsCsv(neurons), shollCsv(neurons), bifurcationsCsv(neurons)]) {
    for (const name of names) assert.ok(!table.split("\n").some((line) => line.startsWith(name.replace(/^\r/, ""))), `${name} leads a row`);
    assert.match(table, /^'=HYPERLINK\(1\),/m);
    assert.match(table, /^'\+1,/m);
    assert.match(table, /^'-cmd,/m);
    assert.match(table, /^'@SUM\(A1\),/m);
    assert.match(table, /^'\tx,/m);
    assert.match(table, /^"'\rx",/m);
  }
  const negative = morphometricsCsv([{ name: "n", analysis: { features: { ...analysis.features, all: { ...analysis.features.all, totalLength: -2.5 } } } }]);
  assert.match(negative.split("\n")[1], /,-2\.5,/);
});
