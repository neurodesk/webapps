import assert from "node:assert/strict";
import { test } from "node:test";
import { formatMs, groupEchoes, parseEchoTimes } from "../src/inputs.js";

const file = (name, text = "") => ({ name, text: async () => text });

test("sidecars give echo times and order", async () => {
  const files = [
    file("e3_bold.nii.gz"), file("e1_bold.nii.gz"), file("e2_bold.nii.gz"),
    file("e1_bold.json", '{"EchoTime": 0.0152}'), file("e2_bold.json", '{"EchoTime": 0.03532}'),
    file("e3_bold.json", '{"EchoTime": 0.05542}'), file("events.tsv"),
  ];
  const { echoes, echoTimes, ignored } = await groupEchoes(files);
  assert.deepEqual(echoes.map((e) => e.file.name), ["e1_bold.nii.gz", "e2_bold.nii.gz", "e3_bold.nii.gz"]);
  assert.equal(echoTimes, "15.2 35.32 55.42");
  assert.deepEqual(ignored, ["events.tsv"]);
});

test("without sidecars echoes sort by name and need typed times", async () => {
  const { echoes, echoTimes } = await groupEchoes([file("echo-10.nii"), file("echo-2.nii")]);
  assert.deepEqual(echoes.map((e) => e.file.name), ["echo-2.nii", "echo-10.nii"]);
  assert.equal(echoTimes, "");
});

test("echo-time field", () => {
  assert.deepEqual(parseEchoTimes("15.2, 35.32 55.42", 3), [15.2, 35.32, 55.42]);
  assert.throws(() => parseEchoTimes("15 30", 3), /Give 3 echo times/);
  assert.throws(() => parseEchoTimes("30 15", 2), /increase/);
  assert.throws(() => parseEchoTimes("15 x", 2), /positive/);
  assert.equal(formatMs(0.03532), "35.32");
});

test("a confounds TSV is the regressors; events are ignored", async () => {
  const echo = [file("e1.nii.gz"), file("e2.nii.gz"), file("e3.nii.gz")];
  const pick = async (...names) => (await groupEchoes([...echo, ...names.map((n) => file(n))])).regressors?.name ?? null;
  assert.equal(await pick("sub-01_events.tsv", "sub-01_desc-confounds_timeseries.tsv", "other.tsv"), "sub-01_desc-confounds_timeseries.tsv");
  assert.equal(await pick("events.tsv", "motion.tsv"), "motion.tsv");
  assert.equal(await pick("a.tsv", "b.tsv"), null);
  assert.equal(await pick("sub-01_task-motor_events.tsv"), null);
});
