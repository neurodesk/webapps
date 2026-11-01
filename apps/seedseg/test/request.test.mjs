import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { operationParametersSchema } from "../../../packages/components/src/automation/parameters.js";
import { segmentRequest } from "../web/js/app/request.js";

const contract = JSON.parse(
  await readFile(new URL("../automation.json", import.meta.url)),
);
const parse = (values) =>
  segmentRequest(
    operationParametersSchema(contract.operations.segment.parameters).parse(
      values,
    ),
  );

test("a pre-v2 request naming v1 checkpoints still runs those checkpoints on v1", () => {
  assert.deepEqual(parse({ models: [123] }), {
    pipeline: "legacy-v1",
    model: "web",
    models: [123],
    folds: [],
    mirror: false,
  });
  assert.deepEqual(parse({ model: "v1" }), {
    pipeline: "legacy-v1",
    model: "web",
    models: [42, 123, 456, 789],
    folds: [],
    mirror: false,
  });
});

test("requests without v1 checkpoints run v2 network 1 unless folds are given", () => {
  assert.deepEqual(parse({}), {
    pipeline: "nnunet-v2",
    model: "web",
    models: [],
    folds: [0],
    mirror: false,
  });
  assert.deepEqual(parse({ folds: [0, 4], mirror: true }), {
    pipeline: "nnunet-v2",
    model: "web",
    models: [],
    folds: [0, 4],
    mirror: true,
  });
});

test("requests mixing v1 checkpoints with v2 are rejected", () => {
  assert.throws(() => parse({ model: "v2", models: [123] }), /v1 checkpoints/);
  assert.throws(() => parse({ models: [123], folds: [0] }), /choose one model/);
  assert.throws(() => parse({ model: "v1", mirror: true }), /apply to v2/);
});
