// DOM-independent unit test (Node, no browser).
// The shared memory crash monitor rewrites raw engine errors in the status bar.
// DWI2TRX writes its own memory explanations there (a partial tractogram, a
// saved TRX whose preview ran out of memory); they must reach the user as written.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { isRawMemoryErrorText } from "@neurodesk/webapp-components/ui/memory-crash";

const source = await readFile(new URL("../src/main.ts", import.meta.url), "utf8");

const appMessages = [
  "TRX saved, but the 3D preview ran out of memory. Use “Save TRX” to download it.",
  "Out of memory: raise the Seed/Stop FA thresholds or lower Density for the full set.",
];

test("DWI2TRX memory explanations still exist in the app source", () => {
  for (const message of appMessages) {
    assert.ok(source.includes(message), `update this test: ${message}`);
  }
  assert.ok(source.includes("`Partial: ${count} streamlines from ${seedNote} (${deviceLost ? 'GPU device lost' : 'out of memory'}).`"));
});

test("the memory crash monitor treats DWI2TRX memory explanations as app prose", () => {
  const samples = [
    ...appMessages,
    "Partial: 1,200 streamlines from 5,000 of 9,000 seeds (out of memory).",
  ];
  for (const sample of samples) {
    assert.equal(isRawMemoryErrorText(sample), false, sample);
  }
});
