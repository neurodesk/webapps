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
