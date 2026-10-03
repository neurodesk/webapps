import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { APP, basisLibrary } from "../src/config.js";
import { recommendBasis } from "../src/basis-select.js";

const manifest = JSON.parse(await readFile(new URL("../../../models/lcmodel.manifest.json", import.meta.url), "utf8"));

test("app identity", () => {
  assert.equal(APP.id, "lcmodel");
});

test("every basis set in the manifest has a pinned, checksummed asset", () => {
  const library = basisLibrary(manifest);
  assert.equal(library.length, 25);
  assert.equal(library.filter((b) => b.sequence === "MEGA-PRESS").length, 3);
  assert.equal(library.filter((b) => b.shapedPulses).length, 7);
  for (const set of library) {
    assert.match(set.library.url, new RegExp(`/resolve/${manifest.revision}/lcmodel/basis/${set.id}\\.basis\\.gz$`));
    assert.match(set.library.sha256, /^[0-9a-f]{64}$/);
    assert.ok(set.hzpppm > 60 && set.teMs > 0 && set.sequence);
  }
});

test("the shipped library covers 1.5 T, intermediate TE and short-TE STEAM", () => {
  const library = basisLibrary(manifest);
  const best = (header) => recommendBasis(header, library).basis.id;
  assert.equal(best({ hzpppm: 63.87, teMs: 144, sequence: "PRESS" }), "press-1.5t-te144");
  assert.equal(best({ hzpppm: 63.87, teMs: 20, sequence: "svs_st" }), "steam-1.5t-te20");
  assert.equal(best({ hzpppm: 127.73, teMs: 80, sequence: "PRESS" }), "press-3t-te80-shaped");
  assert.equal(best({ hzpppm: 123.25, teMs: 6, sequence: "STEAM" }), "steam-3t-te8");
  assert.equal(best({ hzpppm: 123.25, teMs: 8.5, sequence: "SPECIAL" }), "special-3t-te8.5");
  assert.equal(best({ hzpppm: 123.25, teMs: 35, sequence: "svs_slaser" }), "slaser-3t-te35-shaped");
});
