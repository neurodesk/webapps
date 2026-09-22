import NiiVue, { lookupColorMap, MULTIPLANAR_TYPE, SHOW_RENDER, SLICE_TYPE } from '@niivue/niivue';
import '@neurodesk/webapp-components/styles/imaging-workspace.css';
import { mountImagingWorkspace } from '@neurodesk/webapp-components/core/mount-imaging-workspace';
import { bindFileDrop, createConsole, createExampleSelector, createInfoDialog, createViewerToolbar } from '@neurodesk/webapp-components/ui';
import { downloadBlob } from '@neurodesk/webapp-components/file-io';
import { fetchModel } from '@neurodesk/webapp-components/worker';
import { toTsv } from '@neurodesk/nii2tvx';
import { APP, ATLASES, DEFAULT_ATLAS, GRID, TEMPLATE, assignInputs, damagedBundles } from './config.js';
import examples from '../examples.json';
import './styles.css';

const $ = (id) => document.getElementById(id);
let template;

mountImagingWorkspace({
  controls: '#controls',
  viewer: '#viewer',
  status: '#status',
  title: 'Disconnectome',
  subtitle: 'White-matter bundles severed by a lesion, in your browser',
  mark: 'D',
  // No Standalone control: that dialog is rendered by the shell from registry/standalone.json,
  // and nii2tvx ships no packaged release or container yet. About carries the terminal pointer.
  controlsContract: { about: '#aboutBtn', privacy: '#privacyBtn' },
});

const log = createConsole({ id: 'technicalLog' });
$('viewer').append(log);
const info = createInfoDialog({ id: 'infoDialog' });
$('aboutBtn').onclick = () => info.open('About Disconnectome', $('aboutContent'));
$('privacyBtn').onclick = () => info.open('Privacy', $('privacyContent'));
const viewer = new NiiVue({ isDragDropEnabled: false, backgroundColor: [0, 0, 0, 1] });
const toolbar = createViewerToolbar({
  window: false, overlay: false, colormap: false, download: false, screenshot: false,
  views: [
    { id: 'multiplanar', label: '3-Plane', active: true },
    { id: 'render', label: '3D' },
  ].map((view) => ({
    ...view,
    onClick: () => {
      if (!ready) return;
      viewer.sliceType = view.id === 'render' ? SLICE_TYPE.RENDER : SLICE_TYPE.MULTIPLANAR;
      viewer.drawScene();
      toolbar.setActive(view.id);
    },
  })),
});
$('viewer').prepend(toolbar);

const exampleControl = createExampleSelector({
  examples,
  onLoad: async (example, { fetchFiles, assertCurrent }) => {
    // Hold the run button down for the whole download: the selector disables only itself, and
    // the old lesion is still loaded until loadInputs replaces it.
    setBusy(true);
    try {
      const files = await fetchFiles();
      assertCurrent();
      await loadInputs(files, `${example.label} loaded · generate the disconnectome when ready`);
    } finally {
      setBusy(false);
    }
  },
  onStatus: (message, error) => status(message, error),
});
exampleControl.select.id = 'example';
exampleControl.querySelector('label').htmlFor = 'example';
$('exampleControl').replaceWith(exampleControl);

let ready = false;
let busy = false;
let lesion = null;
let anatomical = null;
let result = null;    // { tracts, fractions, id, atlas }
let drawnAtlas = null; // which atlas's geometry the viewer currently holds
let atlas = DEFAULT_ATLAS;
let worker = null;
let timer;

// Viridis straight from NiiVue, so the tract colours and the colorbar are the same ramp the
// rest of the catalog uses rather than an approximation of it. The LUT is four control points
// at uneven positions (I = [0, 64, 192, 255]); interpolating over the array index instead of
// over I would put the stops at thirds and quietly shift every colour.
const VIRIDIS = lookupColorMap('viridis');
function viridis(t) {
  const position = Math.min(1, Math.max(0, t)) * VIRIDIS.I.at(-1);
  const high = Math.max(1, VIRIDIS.I.findIndex((stop) => stop >= position));
  const low = high - 1;
  const mix = (position - VIRIDIS.I[low]) / (VIRIDIS.I[high] - VIRIDIS.I[low]);
  const channel = (values) => Math.round(values[low] + (values[high] - values[low]) * mix);
  return [channel(VIRIDIS.R), channel(VIRIDIS.G), channel(VIRIDIS.B), 255];
}

// Paint the legend from the same LUT the bundles use, so the two cannot drift.
function paintColorbar() {
  const stops = Array.from({ length: 11 }, (_, i) => {
    const [r, g, b] = viridis(i / 10);
    return `rgb(${r} ${g} ${b}) ${i * 10}%`;
  });
  $('colorbar').querySelector('.dc-colorbar-ramp').style.background = `linear-gradient(to right, ${stops.join(', ')})`;
}

function status(message, error = false) {
  $('statusText').textContent = message;
  $('statusText').classList.toggle('error', error);
  log.log(message, error ? 'error' : 'info');
}

/** The example selector runs its own load outside runTask, so both paths refresh here. */
function refreshActions() {
  $('runButton').disabled = busy || !lesion || !ready;
  $('saveButton').disabled = busy || !result;
}

function setBusy(value) {
  busy = value;
  for (const id of ['imageInput', 'threshold', 'atlasSelect']) $(id).disabled = value;
  exampleControl.setDisabled(value);
  refreshActions();
  if (!value) { clearInterval(timer); $('elapsed').textContent = ''; }
}

async function attachViewer() {
  if (ready) return;
  await viewer.attachTo('gl1');
  viewer.multiplanarType = MULTIPLANAR_TYPE.GRID;
  viewer.sliceType = SLICE_TYPE.MULTIPLANAR;
  viewer.showRender = SHOW_RENDER.ALWAYS;
  viewer.isLegendVisible = false;
  viewer.createExtensionContext().on('locationChange', (event) => { $('location').textContent = event.detail.string; });
  ready = true;
}

async function loadTemplate() {
  const { url, bytes, sha256, name } = TEMPLATE;
  return new File([await fetchModel({ url, integrity: { bytes, sha256 } })], name);
}

/** Anatomical (or the MNI template) underneath, lesion in red on top at 70 %. */
async function showImages() {
  const backdrop = anatomical ?? (template ??= await loadTemplate());
  const volumes = [{ url: backdrop, name: backdrop.name }];
  if (lesion) volumes.push({ url: lesion, name: lesion.name, colormap: 'red', opacity: 0.7 });
  await viewer.loadVolumes(volumes);
  $('emptyState').hidden = true;
  $('imageLabel').textContent = [anatomical ? 'ANATOMICAL' : 'MNI152 TEMPLATE', lesion ? 'LESION' : null]
    .filter(Boolean).join(' · ');
}

async function loadInputs(files, describe) {
  const chosen = assignInputs(files);
  if (chosen.error) throw new Error(chosen.error);
  lesion = chosen.lesion;
  anatomical = chosen.anatomical;
  result = null;
  $('outputSection').open = false;
  $('colorbar').hidden = true;
  $('damageSummary').hidden = true;
  // The mesh stays: a new lesion rescores the same parcellation, and paintTracts hides every
  // bundle through groupColors until it does. Reloading it would refetch up to 18.9 MB.
  if (drawnAtlas) await viewer.setTractOptions(0, { groupColors: {} });
  await showImages();
  $('lesionInfo').hidden = false;
  $('lesionInfo').textContent = `Lesion: ${lesion.name}`;
  $('anatomicalInfo').hidden = !anatomical;
  if (anatomical) $('anatomicalInfo').textContent = `Anatomical: ${anatomical.name}`;
  refreshActions();
  status(describe ?? `${lesion.name} loaded · generate the disconnectome when ready`);
}

async function runTask(message, task) {
  if (busy) return;
  setBusy(true);
  status(message);
  try {
    await task();
  } catch (error) {
    status(error instanceof Error ? error.message : String(error), true);
  } finally {
    setBusy(false);
  }
}

$('imageInput').onchange = () => {
  const files = Array.from($('imageInput').files);
  $('imageInput').value = '';
  if (files.length) void runTask('Reading images…', () => loadInputs(files));
};
bindFileDrop($('dropZone'), (files) => void runTask('Reading images…', async () => loadInputs(await files)));

/** Colour every bundle at or above the slider, hide the rest. groupColors does both in one
 *  call, so the slider never reloads geometry. */
async function paintTracts() {
  if (!result || drawnAtlas !== result.atlas) return;
  const threshold = Number($('threshold').value) / 100;
  const shown = damagedBundles(result.tracts, result.fractions, Math.max(threshold, Number.EPSILON));
  const colors = {};
  // The ramp runs from the slider to 100 %, so raising the slider re-spreads the remaining
  // bundles over the whole colormap instead of crowding them at one end.
  const span = Math.max(1e-6, 1 - threshold);
  for (const { name, fraction } of shown) colors[name] = viridis((fraction - threshold) / span);
  await viewer.setTractOptions(0, { groupColors: colors, fiberRadius: 0.5 });
  $('colorbarMin').textContent = `${Math.round(threshold * 100)}%`;
  const worst = shown.length ? shown[0].fraction : 0;
  $('colorbarNote').textContent = shown.length
    ? `${shown.length} of ${result.tracts.length} bundles shown · worst ${(worst * 100).toFixed(1)}%`
    : 'No bundle reaches this threshold';
  $('damageSummary').hidden = false;
  $('damageSummary').textContent = shown.length
    ? `Most disconnected: ${shown.slice(0, 3).map((row) => `${row.name} ${(row.fraction * 100).toFixed(0)}%`).join(', ')}`
    : 'No bundle reaches this threshold';
}

for (const entry of ATLASES) $('atlasSelect').add(new Option(entry.label, entry.id));
$('atlasSelect').value = atlas.id;

function describeAtlas() {
  $('atlasHint').textContent = `Each of the ${atlas.bundles} bundles is scored by the fraction of its `
    + `streamlines passing through the lesion. Changing atlas discards the current result: the two are `
    + `different parcellations, so their bundles do not correspond.`;
}

$('atlasSelect').onchange = () => {
  atlas = ATLASES.find((entry) => entry.id === $('atlasSelect').value) ?? DEFAULT_ATLAS;
  describeAtlas();
  result = null;
  $('colorbar').hidden = true;
  $('damageSummary').hidden = true;
  // The bundles on screen belong to the old parcellation, so clear them rather than leaving
  // them coloured by a result that no longer applies.
  void runTask(`${atlas.label} selected · generate the disconnectome when ready`, async () => {
    await viewer.removeAllMeshes();
    drawnAtlas = null;
  });
};

$('threshold').oninput = () => {
  $('thresholdValue').textContent = $('threshold').value;
  void paintTracts();
};

/** The manifest carries the display atlas's checksum, so verify it rather than handing an
 *  unchecked download straight to the mesh parser. */
async function loadTracts(source) {
  const { url, bytes, sha256, filename } = source.trx;
  const data = await fetchModel({ url, integrity: { bytes, sha256 } }, {
    onProgress: ({ fraction }) => status(`Loading the tract geometry · ${((fraction ?? 0) * 100).toFixed(0)}%`),
  });
  // loadMeshes takes a File as well as a URL, and NiiVue picks the reader from the extension:
  // an object URL has none and is read as MZ3.
  const name = filename.split('/').pop();
  await viewer.loadMeshes([{ url: new File([data], name), name }]);
}

/** One worker for the session: it holds each opened atlas, so switching back and forth does
 *  not inflate and parse the same file again. */
function runDisconnectome(scored, job) {
  worker ??= new Worker(new URL('./disconnect-worker.js', import.meta.url), { type: 'module' });
  return new Promise((resolve, reject) => {
    worker.onmessage = ({ data }) => {
      if (data.type === 'progress') { $('progress').value = data.value; status(data.message); }
      if (data.type === 'error') reject(new Error(data.message));
      if (data.type === 'result') resolve(data);
    };
    worker.onerror = (event) => reject(new Error(event.message || 'The disconnection worker could not run.'));
    scored.arrayBuffer().then((bytes) => worker.postMessage({ atlas: job, lesion: bytes }, [bytes]), reject);
  });
}

$('runButton').onclick = () => void runTask('Starting…', async () => {
  const started = performance.now();
  timer = setInterval(() => { $('elapsed').textContent = `${Math.round((performance.now() - started) / 1000)} s`; }, 1000);
  $('progress').value = 0;
  // Pin the inputs for this run: an example can finish downloading while it is in flight, and
  // labelling one lesion's fractions with another lesion's name is worse than any crash.
  const scored = lesion;
  const runAtlas = atlas;
  let data;
  try {
    data = await runDisconnectome(scored, runAtlas.tvx);
  } catch (error) {
    // The core reports a grid mismatch by name; say what to do about it.
    const message = /grid|dim|sto_xyz/i.test(error.message)
      ? `${error.message} This lesion is not on the ${GRID.dim.join(' × ')} MNI152 1 mm grid; normalize it with SYNcro first.`
      : error.message;
    throw new Error(message);
  }
  result = { ...data, id: scored.name.replace(/\.nii(\.gz)?$/i, ''), atlas: runAtlas.id };

  if (drawnAtlas !== runAtlas.id) {
    status('Loading the tract geometry…');
    await loadTracts(runAtlas);
    drawnAtlas = runAtlas.id;
  }
  // Load-bearing, not cosmetic: the 3D volume render is opaque, so without a clip plane every
  // bundle inside the brain is invisible. Verified by removing it and watching them disappear.
  viewer.setClipPlanes([[0.1, 180, 20]]);
  viewer.sliceType = SLICE_TYPE.RENDER;
  toolbar.setActive('render');
  $('colorbar').hidden = false;
  $('outputSection').open = true;
  await paintTracts();
  $('progress').value = 1;
  const damaged = damagedBundles(result.tracts, result.fractions, Number.EPSILON);
  status(`${damaged.length} of ${result.tracts.length} bundles disconnected · ${((performance.now() - started) / 1000).toFixed(1)} s`);
});

$('saveButton').onclick = () => {
  if (!result) return;
  const tsv = toTsv(result.tracts, [{ id: result.id, fractions: result.fractions }]);
  // The atlas is in the name: the two produce different tables for the same lesion.
  downloadBlob(new Blob([tsv], { type: 'text/tab-separated-values' }), `${result.id}_${result.atlas}_disconnectome.tsv`);
};

async function init() {
  // The template now comes over the network: until it is drawn, an example load would race it
  // for the viewer and have its status overwritten.
  setBusy(true);
  paintColorbar();
  describeAtlas();
  try {
    await attachViewer();
    await showImages();
    status('Ready · choose an example or drop a lesion map');
  } catch (error) {
    $('viewerError').hidden = false;
    $('viewerError').textContent = `Visualization unavailable: ${error instanceof Error ? error.message : error}`;
  }
  setBusy(false);
}

window.addEventListener('pagehide', () => { worker?.terminate(); clearInterval(timer); });
void init();

export default Object.freeze({ APP, viridis, paintTracts });
