import { test } from "node:test";
import assert from "node:assert/strict";
// Loads the WebAssembly module synchronously, so the engine's own init() has nothing to fetch.
import "@neurodesk/samsrf/node";
import { readMz3 } from "@neurodesk/webapp-components/file-io/mesh";
import { createSurfaceViewer } from "../src/viewer.js";
import { freeSurferCurv, freeSurferSurface } from "../../../packages/samsrf/test/fixtures.js";

const FACES = [0, 1, 2, 0, 2, 3, 0, 3, 1, 1, 3, 2];
const INFLATED = [0, 0, 0, 20, 0, 0, 0, 30, 0, 0, 0, 40];
const WHITE = [0, 0, 0, 2, 0, 0, 0, 3, 0, 0, 0, 4];
// A surface the engine reads but NiiVue cannot draw: no vertices.
const EMPTY = Uint8Array.from([0xff, 0xff, 0xfe, ...new TextEncoder().encode("created by test\n\n"), 0, 0, 0, 0, 0, 0, 0, 0]);

const surface = (vertices, name = "lh.inflated") => new File([freeSurferSurface(vertices, FACES)], name);
const curvature = () => new File([freeSurferCurv([0.1, -0.1, 0.2, -0.2])], "lh.curv");

/** A file whose bytes arrive only when the test releases them. */
function heldFile(bytes, name) {
  const file = new File([bytes], name);
  const read = file.arrayBuffer.bind(file);
  let release;
  const released = new Promise((resolve) => { release = resolve; });
  file.arrayBuffer = () => released.then(read);
  return { file, release };
}

/**
 * NiiVue 1.0.0-rc.26's mesh calls as far as the viewer relies on them. Each awaits its file
 * before changing the scene, addMesh adds nothing for a mesh without vertices, and addMeshLayer
 * takes the mesh before it reads the layer, as NiiVue does.
 */
class FakeNiiVue {
  meshes = [];
  #held = new Map();
  attachTo() {
    return Promise.resolve();
  }
  addColormap() {}
  /** Hold the next read of the named file: resolves `reached` when a call waits on it. */
  hold(name) {
    let reached;
    let release;
    const gate = { reached: new Promise((resolve) => { reached = resolve; }), released: new Promise((resolve) => { release = resolve; }) };
    this.#held.set(name, { ...gate, reached });
    return { reached: gate.reached, release };
  }
  async #read(file) {
    const held = this.#held.get(file.name);
    this.#held.delete(file.name);
    if (held) {
      held.reached();
      await held.released;
    }
    return new Uint8Array(await file.arrayBuffer());
  }
  async removeAllMeshes() {
    this.meshes = [];
    await Promise.resolve();
  }
  async addMesh({ url, name }) {
    const { vertices } = await readMz3(await this.#read(url));
    if (vertices.length) this.meshes.push({ name, positions: vertices, layers: [] });
    return this;
  }
  async addMeshLayer(index, { url, name }) {
    const mesh = this.meshes[index];
    if (!mesh) return this;
    await this.#read(url);
    mesh.layers.push(name);
    return this;
  }
  async removeMeshLayer(index, layer) {
    this.meshes[index]?.layers.splice(layer, 1);
    return this;
  }
  async setMeshLayerProperty() {}
}

const shown = (nv) => nv.meshes.map(({ positions, layers }) => ({ positions: [...positions], layers }));
const MAP = new Float32Array(4).fill(1.5);

test("clearing a surface while its curvature loads leaves nothing for the next map", async () => {
  const nv = new FakeNiiVue();
  const viewer = createSurfaceViewer("gl1", nv);
  const curvatureLayer = nv.hold("lh.curv.mz3");
  const loading = viewer.showSurface(surface(INFLATED), curvature());
  await curvatureLayer.reached;
  const clearing = viewer.showSurface(null);
  curvatureLayer.release();
  const outcomes = await Promise.all([loading, clearing]);
  assert.deepEqual(shown(nv), []);
  await viewer.showMap(MAP, "polar");
  assert.equal(viewer.hasSurface, false);
  assert.deepEqual(outcomes, [false, true]);
});

test("a surface replaced while it is read never reaches the viewer", async () => {
  const nv = new FakeNiiVue();
  const viewer = createSurfaceViewer("gl1", nv);
  const first = heldFile(freeSurferSurface(INFLATED, FACES), "lh.inflated");
  const replaced = viewer.showSurface(first.file, curvature());
  const replacement = await viewer.showSurface(surface(WHITE), curvature());
  first.release();
  const outcome = await replaced;
  assert.deepEqual(shown(nv), [{ positions: WHITE, layers: ["lh.curv"] }]);
  assert.equal(viewer.hasSurface, true);
  await viewer.showMap(MAP, "polar");
  assert.deepEqual(shown(nv), [{ positions: WHITE, layers: ["lh.curv", "map"] }]);
  assert.deepEqual([outcome, replacement], [false, true]);
});

test("a surface the viewer cannot draw stays reported over the surface it replaced", async () => {
  const nv = new FakeNiiVue();
  const viewer = createSurfaceViewer("gl1", nv);
  const first = heldFile(freeSurferSurface(INFLATED, FACES), "lh.inflated");
  const replaced = viewer.showSurface(first.file, curvature());
  await assert.rejects(viewer.showSurface(new File([EMPTY], "lh.inflated"), curvature()), /^Error: lh\.inflated: the viewer could not draw this surface\.$/);
  first.release();
  const outcome = await replaced;
  assert.deepEqual(shown(nv), []);
  assert.equal(viewer.hasSurface, false);
  assert.equal(outcome, false);
});

test("a replaced surface that fails to read reports nothing", async () => {
  const nv = new FakeNiiVue();
  const viewer = createSurfaceViewer("gl1", nv);
  const first = heldFile(new TextEncoder().encode("not a surface"), "lh.inflated");
  const replaced = viewer.showSurface(first.file, null);
  const replacement = await viewer.showSurface(surface(WHITE), null);
  first.release();
  await assert.doesNotReject(replaced);
  assert.deepEqual(shown(nv), [{ positions: WHITE, layers: [] }]);
  assert.deepEqual([await replaced, replacement], [false, true]);
});

test("a surface that cannot be read replaces the surface shown", async () => {
  const nv = new FakeNiiVue();
  const viewer = createSurfaceViewer("gl1", nv);
  await viewer.showSurface(surface(INFLATED), curvature());
  await viewer.showMap(MAP, "polar");
  assert.deepEqual(shown(nv), [{ positions: INFLATED, layers: ["lh.curv", "map"] }]);
  await assert.rejects(viewer.showSurface(new File([new TextEncoder().encode("not a surface")], "lh.inflated"), null), /^Error: lh\.inflated: FreeSurfer: unknown surface magic number/);
  assert.deepEqual(shown(nv), []);
  assert.equal(viewer.hasSurface, false);
  await viewer.showMap(MAP, "polar");
  assert.deepEqual(shown(nv), []);
});
