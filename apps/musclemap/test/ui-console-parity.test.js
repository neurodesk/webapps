// Parity test: the shared ConsoleOutput, configured with MuscleMap's theming options, must
// render byte-identical DOM to MuscleMap's ORIGINAL ConsoleOutput for its used surface —
// single-arg log() with prefix-derived level colouring, and clear(). Original archived in
// test/fixtures/. Uses jsdom (real DOM) since this is DOM-heavy; timestamps are normalized.
import { test } from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { ConsoleOutput as Shared } from "../../../packages/components/src/ui/ConsoleOutput.js";
import { ConsoleOutput as Original } from "./fixtures/ConsoleOutput.original.js";

// The options MuscleMap passes (kept in sync with web/js/musclemap-app.js).
const MUSCLEMAP_OPTS = {
  lineClass: "console-line",
  timeClass: "console-time",
  messageClass: "console-message",
  separator: " ",
  levelOn: "message",
  levelClass: (level) => (level === "info" ? "" : level),
  deriveLevel: (text) => {
    const n = String(text).trim().toLowerCase();
    if (n.startsWith("warning:")) return "warning";
    if (n.startsWith("error:") || n.includes("failed")) return "error";
    return "info";
  },
  mirror: () => {}, // silence during test; mirroring is not part of the DOM contract
};

const MESSAGES = [
  "Loading NIfTI volume",
  "Warning: low memory",
  "Error: model failed to load",
  "Resample step failed",
  "Segmentation complete",
];

const normalize = (html) => html.replace(/\[\d\d:\d\d:\d\d\]/g, "[TIME]");

test("shared ConsoleOutput renders identical DOM to the archived original", () => {
  const dom = new JSDOM("<!doctype html><body></body>");
  const { document } = dom.window;
  const prev = globalThis.document;
  globalThis.document = document;
  try {
    const origEl = document.createElement("div");
    origEl.id = "consoleOutput";
    document.body.appendChild(origEl);
    const libEl = document.createElement("div");
    document.body.appendChild(libEl);

    const orig = new Original("consoleOutput"); // logs into #consoleOutput via getElementById
    const lib = new Shared({ element: libEl, ...MUSCLEMAP_OPTS });

    for (const m of MESSAGES) {
      orig.log(m);
      lib.log(m);
    }
    assert.equal(normalize(libEl.innerHTML), normalize(origEl.innerHTML));

    // Sanity: semantic level classes actually landed on the message span.
    assert.match(libEl.innerHTML, /class="console-message warning"/);
    assert.match(libEl.innerHTML, /class="console-message error"/);

    // clear() parity.
    orig.clear();
    lib.clear();
    assert.equal(libEl.innerHTML, origEl.innerHTML);
    assert.equal(libEl.innerHTML, "");
  } finally {
    globalThis.document = prev;
  }
});
