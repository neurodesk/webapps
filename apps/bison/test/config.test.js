// DOM-independent unit tests (Node, no browser). Browser behaviour is covered by the
// Playwright tests in e2e/; Node tests must not import modules that touch `document`.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { CLASS_SLUGS, outputNames } from "@neurodesk/bison";
import {
  APP,
  CLASSES,
  MIN_DEVICE_MEMORY_GB,
  STATUS_MAX_CHARS,
  classifyFraction,
  heldBaseUrl,
  inputMode,
  labelColormap,
  legendOf,
  memoryRefusal,
  modeHint,
  resultRows,
  stageFraction,
  statusLine,
  volumeLines,
} from "../src/config.js";

const examples = JSON.parse(await readFile(new URL("../examples.json", import.meta.url), "utf8"));

test("app id is lowercase kebab-case and the config is frozen", () => {
  assert.match(APP.id, /^[a-z][a-z0-9-]*$/);
  assert.ok(Object.isFrozen(APP));
});

test("the inputs decide the mode: a T1 runs BISON, a T1 and a FLAIR run BISON-WMH", () => {
  assert.equal(inputMode({ t1: {}, flair: null }), "t1");
  assert.equal(inputMode({ t1: {}, flair: {} }), "t1-flair");
  assert.equal(inputMode({ t1: null, flair: {} }), null);
  assert.equal(inputMode({ t1: null, flair: null }), null);
  assert.match(modeHint("t1"), /^BISON: 8 tissue classes/);
  assert.match(modeHint("t1-flair"), /^BISON-WMH: 9 classes/);
  assert.match(modeHint(null), /Load a T1/);
  for (const mode of ["t1", "t1-flair", null]) assert.ok(modeHint(mode).length <= 90, "visible help stays under 90 characters");
});

test("a device that reports too little memory is refused; one that reports none may run", () => {
  assert.equal(MIN_DEVICE_MEMORY_GB, 8);
  assert.equal(memoryRefusal(undefined), null);
  assert.equal(memoryRefusal(Number.NaN), null);
  assert.equal(memoryRefusal(8), null);
  assert.equal(memoryRefusal(16), null);
  assert.match(memoryRefusal(4), /reports 4 GB of memory\. BISON needs 8 GB or more\./);
  assert.match(memoryRefusal(0.5), /0\.5 GB/);
});

test("the classes follow the pipeline's label order, and BISON-WMH adds WMH as label 9", () => {
  assert.deepEqual(CLASSES.map(({ slug }) => slug), CLASS_SLUGS);
  assert.deepEqual(CLASSES.map(({ label }) => label), [1, 2, 3, 4, 5, 6, 7, 8, 9]);
  const t1 = labelColormap("t1");
  const wmh = labelColormap("t1-flair");
  assert.deepEqual(t1.I, [0, 1, 2, 3, 4, 5, 6, 7, 8]);
  assert.deepEqual(wmh.I, [0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
  assert.equal(wmh.labels[9], "WMH");
  assert.equal(wmh.A[0], 0, "background is transparent");
  for (const map of [t1, wmh]) {
    for (const channel of ["R", "G", "B", "A", "labels"]) assert.equal(map[channel].length, map.I.length);
  }
  const colours = new Set(CLASSES.map(({ color }) => color.join(",")));
  assert.equal(colours.size, CLASSES.length, "every class has its own colour");
});

test("the legend lists every class of the mode with its volume", () => {
  const { labels, metrics } = legendOf("t1", [{ label: 1, ml: 20.5 }, { label: 8, ml: 450 }]);
  assert.equal(labels.length, 8);
  assert.deepEqual(labels[0], { index: 1, name: "Ventricles", color: [120, 18, 134, 255] });
  assert.deepEqual(metrics.labelVolumes, { 1: 20.5, 8: 450 });
  assert.equal(legendOf("t1-flair").labels.at(-1).name, "WMH");
  assert.deepEqual(volumeLines([{ label: 9, ml: 1.234 }]), ["WMH: 1.23 mL"]);
});

test("progress moves through the stages in pipeline order and the classifier fills its share", () => {
  const order = [
    "Registering T1 to the template (affine)",
    "Denoising T1",
    "Correcting T1 intensity non-uniformity",
    "Normalising T1 intensities",
    "Registering T1 to the template (affine + SyN)",
    "Resampling t1/sp_1 to the T1",
    "Registering FLAIR to T1 (rigid)",
    "Denoising FLAIR",
    "Correcting FLAIR intensity non-uniformity",
    "Normalising FLAIR intensities",
    "Classifying tissues",
    "Writing results",
  ];
  const fractions = order.map(stageFraction);
  assert.ok(fractions.every((value) => typeof value === "number"), "every stage message is known");
  for (let k = 1; k < fractions.length; k++) assert.ok(fractions[k] > fractions[k - 1], `${order[k]} starts after ${order[k - 1]}`);
  assert.equal(stageFraction("Registering T1 to the template (affine)"), 0.04, "the affine stage is not taken for the SyN one");
  assert.equal(stageFraction("Something else"), null);
  assert.equal(classifyFraction(0), stageFraction("Classifying tissues"));
  assert.ok(classifyFraction(1) <= stageFraction("Writing results"));
  assert.equal(classifyFraction(2), classifyFraction(1));
});

test("long messages are cut to one sentence for the status line", () => {
  assert.equal(statusLine("Short."), "Short.");
  const message = "The BISON model files are not published yet, so this app cannot segment images. Their authors must first allow publication.";
  assert.equal(statusLine(message), "The BISON model files are not published yet, so this app cannot segment images.");
  const long = statusLine("x".repeat(200));
  assert.equal(long.length, STATUS_MAX_CHARS - 1);
  assert.ok(long.endsWith("…"));
});

test("the held-asset base becomes an absolute directory URL, and none is null", () => {
  assert.equal(heldBaseUrl(undefined, "http://127.0.0.1:4197"), null);
  assert.equal(heldBaseUrl("", "http://127.0.0.1:4197"), null);
  assert.equal(heldBaseUrl("/bison/bison-assets", "http://127.0.0.1:4197"), "http://127.0.0.1:4197/bison/bison-assets/");
  assert.equal(heldBaseUrl("https://example.org/assets/", "http://127.0.0.1:4197"), "https://example.org/assets/");
});

test("the Output rows follow the pipeline's file names: labels, one probability per class, mask", () => {
  for (const [mode, classes] of [["t1", 8], ["t1-flair", 9]]) {
    const names = outputNames("sub-01_T1w.nii.gz", mode);
    const files = [names.labels, ...names.probabilities.map(({ name }) => name), names.mask].map((name) => ({ name }));
    const rows = resultRows(files);
    const keys = Object.keys(rows);
    assert.equal(keys.length, classes + 2);
    assert.equal(keys[0], "labels");
    assert.equal(keys.at(-1), "mask");
    assert.equal(rows["prob-wm"].description, "WM probability");
    assert.equal(rows["prob-wm"].kind, "probability");
    assert.equal(Boolean(rows["prob-wmh"]), mode === "t1-flair");
  }
  assert.throws(() => resultRows([{ name: "other.nii.gz" }]), /unexpected file/);
  assert.throws(() => resultRows([{ name: "a_bison-prob-bone.nii.gz" }]), /unexpected file/);
  assert.throws(() => resultRows([{ name: "a_bison-mask.nii.gz" }]), /no label map/);
});

test("the examples are the pinned ds007522 T1, and the T1 with its FLAIR", () => {
  assert.deepEqual(examples.map(({ id }) => id), ["t1", "t1-flair"]);
  assert.deepEqual(examples[0].files.map(({ role }) => role), ["t1"]);
  assert.deepEqual(examples[1].files.map(({ role }) => role), ["t1", "flair"]);
  for (const { files } of examples) {
    for (const file of files) {
      assert.match(file.url, /^https:\/\/huggingface\.co\/datasets\/neurodeskorg\/webapps\/resolve\/[0-9a-f]{40}\/bison\/examples\//);
      assert.match(file.sha256, /^[0-9a-f]{64}$/);
      assert.ok(file.bytes > 0);
      assert.ok(file.url.endsWith(`/${file.name}`));
    }
  }
  assert.deepEqual(examples[1].files[0], examples[0].files[0], "both examples use the same T1");
});
