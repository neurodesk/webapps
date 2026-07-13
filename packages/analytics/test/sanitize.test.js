// DOM-independent unit tests for the telemetry allow-list (Node, no browser needed).
import { test } from "node:test";
import assert from "node:assert/strict";
import { sanitize } from "../src/index.js";

test("forwards valid, allow-listed primitives", () => {
  const { props } = sanitize("inference_succeeded", {
    app: "musclemap",
    app_version: "1.2.37",
    duration_bucket: "5-30s",
    success: true,
  });
  assert.deepEqual(props, {
    app: "musclemap",
    app_version: "1.2.37",
    duration_bucket: "5-30s",
    success: true,
  });
});

test("drops unknown keys", () => {
  const { props } = sanitize("app_loaded", { app: "musclemap", sneaky: "x" });
  assert.deepEqual(props, { app: "musclemap" });
});

test("drops prohibited patient-derived keys even if value looks benign", () => {
  const { props } = sanitize("file_selected", { filename: "scan.nii", dicom_tag: "0010,0010" });
  assert.deepEqual(props, {});
});

test("rejects nested objects and arrays for allowed keys", () => {
  const { props } = sanitize("app_loaded", { app: { evil: 1 }, app_version: ["1.0.0"] });
  assert.deepEqual(props, {});
});

test("enforces enum membership", () => {
  const { props } = sanitize("inference_started", { browser_class: "netscape" });
  assert.deepEqual(props, {});
});

test("enforces app/version patterns and string length", () => {
  const long = "v".repeat(64);
  const { props } = sanitize("app_loaded", { app: "Not Valid!", app_version: long });
  assert.deepEqual(props, {});
});

test("throws on unknown event name", () => {
  assert.throws(() => sanitize("exfiltrate", {}), /unknown event/);
});
