import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";

const source = await readFile(new URL("../src/main.js", import.meta.url), "utf8");

function section(start, end) {
  const first = source.indexOf(start);
  const last = source.indexOf(end, first);
  assert.ok(first >= 0 && last > first, `Missing source section ${start}`);
  return source.slice(first, last);
}

// Runs main.js's own show, jumpToLesion and setOverlayVisible against a NiiVue whose load waits.
function viewerWithPendingLoad() {
  let finishLoad;
  const nv = {
    volumes: [{}, { opacity: 0.7 }],
    crosshair: [0, 0, 0],
    loadVolumes(layers) {
      return new Promise((resolve) => {
        finishLoad = () => {
          nv.volumes = layers.map((layer) => ({ ...layer }));
          nv.crosshair = [0, 0, 0];
          resolve();
        };
      });
    },
    async setVolume(index, changes) { Object.assign(nv.volumes[index], changes); },
    getCrosshairPos: () => nv.crosshair,
    setCrosshairPos(position) { nv.crosshair = position; },
    drawScene() {},
  };
  const element = () => ({ hidden: false, textContent: "", classList: { toggle() {} }, children: [], setAttribute() {} });
  const elements = new Map();
  const flair = { name: "flair.nii" };
  const context = vm.createContext({
    nv,
    ensureViewer: async () => nv,
    $: (id) => elements.get(id) ?? elements.set(id, element()).get(id),
    log: { log() {} },
    overlayToggle: element(),
    lesionLabel: element(),
    renderLesionNavigator() {},
  });
  vm.runInContext(`
    let viewQueue = Promise.resolve(), viewRevision = 0, viewer = nv, shownFlair = flair;
    let overlayVisible = true, lesionIndex = -1;
    const OVERLAY_OPACITY = 0.7;
    const source = flair;
    const lesions = [{ ml: 0.064, world: [-0.5, -0.5, -0.5] }];
    const outputs = {
      flair: { file: flair },
      mask: { file: { name: "mask.nii" } },
      probability: { file: { name: "probability.nii" } },
    };
    ${section("function setLesions(", "\nasync function editResult(")}
    ${section("function show(stage)", "\nasync function loadFiles(")}
  `, Object.assign(context, { flair }));
  return { context, nv, finishLoad: () => finishLoad() };
}

const settle = (context) => vm.runInContext("viewQueue", context);

test("hiding the overlay while a result loads hides the result that arrives", async () => {
  const { context, nv, finishLoad } = viewerWithPendingLoad();
  vm.runInContext('show("probability")', context);
  await new Promise((resolve) => setImmediate(resolve));
  vm.runInContext("setOverlayVisible(false)", context);
  await new Promise((resolve) => setImmediate(resolve));
  finishLoad();
  await settle(context);
  assert.equal(nv.volumes[1].name, "probability.nii");
  assert.equal(nv.volumes[1].opacity, 0);
});

test("a lesion chosen while a result loads is where the crosshair ends", async () => {
  const { context, nv, finishLoad } = viewerWithPendingLoad();
  vm.runInContext('show("mask")', context);
  await new Promise((resolve) => setImmediate(resolve));
  vm.runInContext("jumpToLesion(1)", context);
  await new Promise((resolve) => setImmediate(resolve));
  finishLoad();
  await settle(context);
  assert.deepEqual([...nv.crosshair], [-0.5, -0.5, -0.5]);
});

test("a view superseded while loading still keeps the crosshair for the view after it", async () => {
  const { context, nv, finishLoad } = viewerWithPendingLoad();
  nv.crosshair = [-0.5, -0.5, -0.5];
  vm.runInContext('show("mask")', context);
  await new Promise((resolve) => setImmediate(resolve));
  vm.runInContext('show("probability")', context);
  finishLoad();
  await new Promise((resolve) => setImmediate(resolve));
  finishLoad();
  await settle(context);
  assert.equal(nv.volumes[1].name, "probability.nii");
  assert.deepEqual([...nv.crosshair], [-0.5, -0.5, -0.5]);
});
