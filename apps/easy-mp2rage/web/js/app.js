// Easy MP2RAGE T1 Map, in-browser controller.
// Parses NIfTI in JS (nifti.js), runs the WASM core in a Web Worker, previews
// with a self-contained canvas viewer, and offers client-side downloads. Your
// images/results never leave the tab (the hosted page loads GA4, which sees
// anonymous page views only).
import { readNifti, writeNiftiF32, writeNiftiGz } from './nifti.js';
import { zipStore } from './zip.js';
import { indexBids } from './bids.js';
import initWasm, { parse_dicom_series, write_dicom_t1 } from '../wasm/mp2rage_wasm.js';

let wasmReady;
function ensureWasm() {
  if (!wasmReady) wasmReady = initWasm(new URL('../wasm/mp2rage_wasm_bg.wasm', import.meta.url));
  return wasmReady;
}

const $ = (s) => document.querySelector(s);
const logEl = $('#log');
const log = (m) => { logEl.textContent += m + '\n'; logEl.scrollTop = logEl.scrollHeight; };

// ---- parameter specs -------------------------------------------------------
const MP_SPEC = [
  ['tr', 'TR (s)', 4.3, 5.0, 0.001], ['ti1', 'TI1 (s)', 0.840, 0.700, 0.001],
  ['ti2', 'TI2 (s)', 2.370, 2.500, 0.001], ['fa1', 'flip 1 (°)', 5, 4, 0.1],
  ['fa2', 'flip 2 (°)', 6, 5, 0.1], ['nz1', 'NZslices 1', 64, 64, 1],
  ['nz2', 'NZslices 2', 128, 128, 1], ['trflash', 'TRFLASH (s)', 0.007, 0.0067, 0.0001],
  ['inveff', 'inversion eff.', 0.96, 0.96, 0.01],
];
const SA_SPEC = [
  ['tr', 'TR (s)', 2.4, 2.4, 0.001], ['ti1', 'TD1 (s)', 0.150, 0.150, 0.001],
  ['ti2', 'TD2 (s)', 1.500, 1.500, 0.001], ['fa1', 'flip 1 (°)', 6, 6, 0.1],
  ['fa2', 'flip 2 (°)', 6, 6, 0.1], ['nz1', 'NZslices 1', 24, 24, 1],
  ['nz2', 'NZslices 2', 24, 24, 1], ['trflash', 'TRFLASH (s)', 0.005, 0.005, 0.0001],
  ['avgt1', 'average T1 (s)', 1.5, 1.2, 0.05],
];
const B1_SPEC = [
  ['type', 'map type', 'tfl', 'tfl'], ['refangle', 'ref flip (°)', 80, 80, 1],
];

function buildForm(grid, spec, prefix) {
  grid.innerHTML = '';
  for (const [id, label, d7] of spec) {
    const f = document.createElement('div'); f.className = 'field';
    const lab = document.createElement('label'); lab.textContent = label;
    let inp;
    if (id === 'type') {
      inp = document.createElement('select');
      for (const t of ['tfl', 'percent', 'relative']) { const o = document.createElement('option'); o.value = o.textContent = t; inp.appendChild(o); }
      inp.value = d7;
    } else {
      inp = document.createElement('input'); inp.type = 'number'; inp.value = d7;
      inp.step = spec.find((s) => s[0] === id)[4] ?? 'any';
    }
    inp.id = `${prefix}_${id}`;
    f.appendChild(lab); f.appendChild(inp); grid.appendChild(f);
  }
}
function applyPreset(which) {
  for (const [id, , , d3] of MP_SPEC) { const e = $(`#mp_${id}`); if (e) e.value = which === '3T' ? d3 : MP_SPEC.find(s => s[0] === id)[2]; }
  for (const [id, , , d3] of SA_SPEC) { const e = $(`#sa_${id}`); if (e) e.value = which === '3T' ? d3 : SA_SPEC.find(s => s[0] === id)[2]; }
  $('#paramSrcNote').textContent = which + ' preset';
  $('#paramSource').value = 'manual';
}
buildForm($('#mpGrid'), MP_SPEC, 'mp');
buildForm($('#saGrid'), SA_SPEC, 'sa');
buildForm($('#b1Grid'), B1_SPEC, 'b1');
document.querySelectorAll('.presetbtn').forEach((b) => b.onclick = () => applyPreset(b.dataset.preset));

const num = (id) => parseFloat($(id).value);
const mpParams = () => [num('#mp_tr'), num('#mp_ti1'), num('#mp_ti2'), num('#mp_fa1'), num('#mp_fa2'), num('#mp_nz1'), num('#mp_nz2'), num('#mp_trflash'), num('#mp_inveff')];
const saParams = () => [num('#sa_tr'), num('#sa_ti1'), num('#sa_ti2'), num('#sa_fa1'), num('#sa_fa2'), num('#sa_nz1'), num('#sa_nz2'), num('#sa_trflash'), num('#sa_avgt1')];

// ---- file ingest -----------------------------------------------------------
const ROLES = ['(ignore)', 'UNI', 'INV1', 'INV2', 'SA2RAGE', 'B1 map'];
const state = { files: [], jsons: [] };
let appMode = 'single'; // 'single' (drag/drop, DICOM) or 'bids' (whole directory)

function guessRole(name) {
  const n = name.toLowerCase();
  if (/sa2rage|sa2/.test(n)) return 'SA2RAGE';
  // A flip-angle map ("famp") is unambiguously the B1 map, strongest signal.
  if (/famp|flip.?angle|fa[_-]?map/.test(n)) return 'B1 map';
  // Structural MP2RAGE images are matched BEFORE the weaker b1map/tfl hint:
  // Siemens MP2RAGE is itself a TFL sequence ("tfl3d1"), so "tfl" can appear in
  // UNI/INV filenames and must not shadow their real role.
  // Match the inversions first, and anchor the UNI hint to a token boundary, so a
  // subject/site label containing the trigram "uni" (e.g. sub-uni01, community01)
  // cannot mislabel an INV image as UNI.
  if (/inv-?2|inv2/.test(n)) return 'INV2';
  if (/inv-?1|inv1/.test(n)) return 'INV1';
  if (/(?:^|[_.-])uni(?:t1|den)?(?:[_.-]|$)/.test(n)) return 'UNI';
  // A Siemens TFL B1-mapping sequence (TB1TFL / tfl_b1map) also exports an
  // anatomical reference, that one must be ignored, not used for correction.
  if (/tb1tfl|b1map|_b1\b|tfl.?b1|b1.?map/.test(n)) return /anat/.test(n) ? '(ignore)' : 'B1 map';
  return '(ignore)';
}

async function addFiles(fileList) {
  if (appMode === 'bids') { log('In BIDS mode, switch to "Single dataset" to load individual files.'); return; }
  for (const file of fileList) {
    const lower = file.name.toLowerCase();
    const buf = await file.arrayBuffer();
    if (lower.endsWith('.json')) {
      try {
        const js = JSON.parse(new TextDecoder().decode(buf));
        state.jsons.push({ name: file.name, json: js });
        if ($('#paramSource').value === 'json') applySidecar(file.name, js);
        log(`sidecar: ${file.name}`);
      } catch (e) { log(`could not parse ${file.name}: ${e}`); }
      continue;
    }
    if (!/\.nii(\.gz)?$/.test(lower)) { log(`skipped ${file.name} (not .nii/.nii.gz/.json)`); continue; }
    try {
      const nii = await readNifti(buf);
      const rec = { name: file.name, size: file.size, dims: nii.dims, affine: nii.affine, data: nii.data, role: guessRole(file.name) };
      state.files.push(rec);
      log(`loaded ${file.name}  [${nii.dims.join('×')}]  → ${rec.role}`);
    } catch (e) { log(`failed to read ${file.name}: ${e}`); }
  }
  renderTable(); refreshRunState();
}

function applySidecar(name, js) {
  const n = name.toLowerCase();
  const set = (id, v) => { if (v != null && $(id)) $(id).value = v; };
  if (/inv-?1|inv1/.test(n)) { set('#mp_ti1', js.InversionTime); set('#mp_fa1', js.FlipAngle); }
  if (/inv-?2|inv2/.test(n)) { set('#mp_ti2', js.InversionTime); set('#mp_fa2', js.FlipAngle); }
  if (/mp2rage|uni|inv/.test(n) && js.RepetitionTime) set('#mp_tr', js.RepetitionTime);
  $('#paramSrcNote').textContent = 'from sidecars';
}

function reloadFromJsons() {
  if (!state.jsons.length) { log('no JSON sidecars loaded, drop the .json files too'); return; }
  for (const j of state.jsons) applySidecar(j.name, j.json);
  $('#paramSource').value = 'json';
  log(`reloaded MP2RAGE parameters from ${state.jsons.length} sidecar(s)`);
}
$('#reloadJson').onclick = reloadFromJsons;
$('#paramSource').onchange = () => {
  const v = $('#paramSource').value;
  if (v === 'json') reloadFromJsons();
  else $('#paramSrcNote').textContent = v === 'dicom' ? 'from DICOM headers' : 'manual';
};

function renderTable() {
  const tb = $('#filetable tbody'); tb.innerHTML = '';
  for (const [i, f] of state.files.entries()) {
    const tr = document.createElement('tr');
    const nameTd = document.createElement('td');
    nameTd.className = 'clickname';
    nameTd.title = 'click to preview this image in the viewer';
    nameTd.setAttribute('role', 'button');
    nameTd.setAttribute('tabindex', '0');
    nameTd.setAttribute('aria-label', 'Preview ' + f.name);
    nameTd.innerHTML = `👁 <span>${esc(f.name)}</span>`;
    nameTd.onclick = () => previewInput(f);
    nameTd.onkeydown = (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); previewInput(f); } };
    tr.appendChild(nameTd);
    const dimTd = document.createElement('td'); dimTd.className = 'dim'; dimTd.textContent = f.dims.join(' × ');
    tr.appendChild(dimTd);
    const roleTd = document.createElement('td');
    const sel = document.createElement('select');
    sel.setAttribute('aria-label', 'Role for ' + f.name);
    for (const r of ROLES) { const o = document.createElement('option'); o.value = o.textContent = r; if (r === f.role) o.selected = true; sel.appendChild(o); }
    sel.onchange = () => { f.role = sel.value; refreshRunState(); };
    roleTd.appendChild(sel); tr.appendChild(roleTd);
    const del = document.createElement('td');
    const b = document.createElement('button'); b.className = 'secondary'; b.textContent = '✕'; b.style.padding = '2px 9px';
    b.setAttribute('aria-label', 'Remove ' + f.name);
    b.onclick = () => { state.files.splice(i, 1); renderTable(); refreshRunState(); };
    del.appendChild(b); tr.appendChild(del);
    tb.appendChild(tr);
  }
  // JSON sidecar rows
  for (const [i, j] of state.jsons.entries()) {
    const tr = document.createElement('tr');
    tr.innerHTML = `<td>📄 ${esc(j.name)}</td><td class="dim">JSON</td><td class="dim">parameters (matched by name)</td>`;
    const del = document.createElement('td');
    const b = document.createElement('button'); b.className = 'secondary'; b.textContent = '✕'; b.style.padding = '2px 9px';
    b.onclick = () => { state.jsons.splice(i, 1); renderTable(); };
    del.appendChild(b); tr.appendChild(del);
    tb.appendChild(tr);
  }
  $('#filetable').classList.toggle('hidden', state.files.length === 0 && state.jsons.length === 0);
  renderWarnings();
}

function byRole(r) { return state.files.find((f) => f.role === r); }

// ---- import sanity checks (ND / duplicates / B1 anat-vs-famp) --------------
const esc = (s) => String(s).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));

// DICOM ImageType (0008,0008) tokens for a file, from the DICOM header, or from
// a matching dcm2niix .json sidecar for a NIfTI. Returns an UPPERCASE array or null.
function imageTypeTokens(f) {
  if (f.imageType) return f.imageType.toUpperCase().split('\\').map((s) => s.trim()).filter(Boolean);
  const base = f.name.replace(/\.(nii\.gz|nii)$/i, '').toLowerCase();
  const j = state.jsons.find((x) => x.name.replace(/\.json$/i, '').toLowerCase() === base);
  if (j && Array.isArray(j.json.ImageType)) return j.json.ImageType.map((s) => String(s).toUpperCase().trim());
  return null;
}
// Non-distortion-corrected? ImageType has ND and no DIS2D/DIS3D; else name ends _ND.
function isNonDistCorrected(f) {
  const t = imageTypeTokens(f);
  if (t) return t.includes('ND') && !t.some((x) => x.startsWith('DIS'));
  return /_nd(?=[._-]|$)/i.test(f.name.replace(/\.(nii\.gz|nii)$/i, ''));
}

function renderWarnings() {
  const box = $('#warnings'); if (!box) return;
  const msgs = [];
  const structural = new Set(['UNI', 'INV1', 'INV2']);
  // 1) non-distortion-corrected structural inputs
  for (const f of state.files) {
    if (structural.has(f.role) && isNonDistCorrected(f))
      msgs.push(`“${esc(f.name)}” is a <b>non-distortion-corrected (_ND)</b> image but is set to <b>${f.role}</b>. For quantitative T1 prefer the distortion-corrected (DIS2D/DIS3D) series. <b>Please check!</b>`);
  }
  // 2) more than one image assigned to the same role
  const byrole = {};
  for (const f of state.files) if (f.role !== '(ignore)') (byrole[f.role] ||= []).push(f);
  for (const [role, fs] of Object.entries(byrole))
    if (fs.length > 1)
      msgs.push(`<b>${fs.length} images are set to ${role}</b> (${fs.map((f) => esc(f.name)).join(', ')}). Only one is used, check you picked the right one.`);
  // 3) a B1 sequence's anatomical reference mistaken for the flip-angle (B1) map
  for (const f of state.files) {
    const t = imageTypeTokens(f);
    const isFAM = t && t.includes('FLIP ANGLE MAP');
    const looksAnat = /b1map|tb1tfl|tfl.?b1/i.test(f.name + ' ' + (f.seriesDesc || '')) && t && !isFAM && (t.includes('M') || t.includes('MAGNITUDE'));
    if (f.role === 'B1 map' && looksAnat)
      msgs.push(`“${esc(f.name)}” looks like the B1 sequence’s <b>anatomical reference</b>, not the flip-angle (B1) map. Use the <b>FLIP ANGLE MAP</b> series (usually “famp”) as the B1 map.`);
  }
  box.innerHTML = msgs.map((m) => `<div>⚠ ${m}</div>`).join('');
  box.style.display = msgs.length ? 'block' : 'none';
}

function refreshRunState() {
  const uni = byRole('UNI'), inv1 = byRole('INV1'), inv2 = byRole('INV2'), sa = byRole('SA2RAGE'), b1 = byRole('B1 map');
  const task = $('#taskSel').value;
  $('#regField').style.display = task === 'denoise' ? '' : 'none';
  let ok = false, status = '', mode = null, label = 'Compute';
  if (task === 'denoise') {
    ok = !!(uni && inv1 && inv2);
    label = 'Denoise UNI';
    status = ok ? 'Ready: robust-combination denoising (UNI + INV1 + INV2).' : 'Denoise needs UNI, INV1 and INV2.';
    $('#saBlock').classList.add('hidden'); $('#b1Block').classList.add('hidden');
  } else if (task === 'b1only') {
    mode = 'sa2rage';
    ok = !!(uni && inv2 && sa);
    label = 'Compute B1 map';
    status = ok ? 'Ready: relative B1 map from SA2RAGE.' : 'SA2RAGE → B1 needs UNI, INV2 and SA2RAGE.';
    $('#saBlock').classList.remove('hidden'); $('#b1Block').classList.add('hidden');
  } else {
    mode = sa ? 'sa2rage' : (b1 ? 'b1map' : null);
    ok = !!(uni && mode);
    label = 'Compute T1 map';
    $('#saBlock').classList.toggle('hidden', mode === 'b1map');
    $('#b1Block').classList.toggle('hidden', mode !== 'b1map');
    status = ok
      ? `Ready: ${mode === 'sa2rage' ? 'SA2RAGE' : 'B1-map'} correction${inv2 ? '' : ' (no INV2 → mask from UNI)'}.`
      : 'Need a UNI and a B1 source (SA2RAGE or B1 map).';
    if (ok && sa && b1) status += ' Both a SA2RAGE and a B1 map are loaded, using SA2RAGE; set the B1 map’s role to (ignore) to use it instead.';
  }
  $('#run').disabled = !ok;
  $('#run').textContent = label;
  $('#status').textContent = status;
  return { uni, inv1, inv2, sa, b1, mode, task };
}
$('#taskSel').onchange = refreshRunState;

// ---- DICOM folders --------------------------------------------------------
const getFile = (entry) => new Promise((res) => entry.file(res));

// recursively collect File objects under a directory entry (readEntries is batched)
function collectFiles(dirEntry) {
  return new Promise((resolve) => {
    const reader = dirEntry.createReader();
    const files = [];
    const pump = () => reader.readEntries(async (batch) => {
      if (!batch.length) { resolve(files); return; }
      for (const e of batch) {
        if (e.isFile) files.push(await getFile(e));
        else if (e.isDirectory) files.push(...await collectFiles(e));
      }
      pump();
    }, () => resolve(files));
  });
}

async function addDicomFolder(name, files) {
  if (appMode === 'bids') { log('In BIDS mode, switch to "Single dataset" to load a DICOM folder.'); return; }
  if (!files.length) return;
  log(`reading DICOM folder "${name}" (${files.length} files) …`);
  await ensureWasm();
  const bufs = await Promise.all(files.map((f) => f.arrayBuffer()));
  const total = bufs.reduce((a, b) => a + b.byteLength, 0);
  const concat = new Uint8Array(total), offsets = new Uint32Array(bufs.length + 1);
  let o = 0;
  bufs.forEach((b, i) => { offsets[i] = o; concat.set(new Uint8Array(b), o); o += b.byteLength; });
  offsets[bufs.length] = o;
  let v;
  try { v = parse_dicom_series(concat, offsets); }
  catch (e) { log(`  ${name}: ${e}`); return; }
  const dims = Array.from(v.dims);
  state.files.push({ name, dims, affine: v.affine, data: v.data, role: v.role, dicom: true,
    imageType: v.image_type, seriesDesc: v.series_desc, src: { concat, offsets } });
  log(`  ${name} → [${dims.join('×')}] role ${v.role}${v.image_type ? '  [' + v.image_type + ']' : ''}`);
  const params = Array.from(v.params);
  if (params.length === 7) {
    ['mp_tr', 'mp_ti1', 'mp_ti2', 'mp_fa1', 'mp_fa2', 'mp_nz1', 'mp_nz2'].forEach((id, i) => {
      const el = $('#' + id); if (el) el.value = +params[i].toFixed(4);
    });
    $('#paramSrcNote').textContent = 'from DICOM header';
    $('#paramSource').value = 'dicom';
    log('  auto-filled MP2RAGE parameters from the DICOM ASCCONV header');
  }
  renderTable(); refreshRunState();
}

async function handleDrop(e) {
  const dt = e.dataTransfer;
  // Capture every entry synchronously, dataTransfer.items is emptied once this
  // handler returns, so we must grab all of them before the first await.
  const entries = dt.items ? [...dt.items].map((it) => it.webkitGetAsEntry && it.webkitGetAsEntry()).filter(Boolean) : [];
  if (!entries.length) { if (dt.files?.length) await addFiles(dt.files); return; }
  const folders = entries.filter((en) => en.isDirectory);
  const fileEntries = entries.filter((en) => en.isFile);
  if (folders.length > 1) log(`${folders.length} folders dropped, importing each as its own series …`);
  // loose dropped files (NIfTI/JSON vs. stray DICOM files)
  const dropped = await Promise.all(fileEntries.map(getFile));
  const niftis = dropped.filter((f) => /\.(nii(\.gz)?|json)$/i.test(f.name));
  const loose = dropped.filter((f) => !/\.(nii(\.gz)?|json)$/i.test(f.name));
  if (niftis.length) await addFiles(niftis);
  if (loose.length) await addDicomFolder('(dropped files)', loose);
  // Import every dropped folder; isolate failures so one bad series can't block the rest.
  for (const dir of folders) {
    try { await addDicomFolder(dir.name, await collectFiles(dir)); }
    catch (err) { log(`  ${dir.name}: ${err}`); }
  }
}

// drag & drop
const drop = $('#drop');
drop.onclick = () => $('#file').click();
// keyboard access: the drop zone acts as a button to open the file picker
drop.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); $('#file').click(); }
});
$('#file').onchange = (e) => addFiles(e.target.files);
['dragover', 'dragenter'].forEach((ev) => drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.add('hover'); }));
['dragleave', 'drop'].forEach((ev) => drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.remove('hover'); }));
drop.addEventListener('drop', handleDrop);

// folder picker (reliable DICOM import): groups the selected files by their
// containing directory, so picking one series folder OR a parent of several works.
async function addPickedFolders(fileList) {
  const groups = {};
  for (const f of [...fileList]) {
    const rel = f.webkitRelativePath || f.name;
    const dir = rel.includes('/') ? rel.slice(0, rel.lastIndexOf('/')) : '(folder)';
    (groups[dir] ||= []).push(f);
  }
  for (const [dir, fs] of Object.entries(groups)) {
    const niftis = fs.filter((f) => /\.(nii(\.gz)?|json)$/i.test(f.name));
    const dcm = fs.filter((f) => !/\.(nii(\.gz)?|json)$/i.test(f.name));
    if (niftis.length) await addFiles(niftis);
    if (dcm.length) await addDicomFolder(dir.split('/').pop() || dir, dcm);
  }
}
$('#pickFolder').onclick = () => $('#folder').click();
$('#folder').onchange = (e) => addPickedFolders(e.target.files);

// ---- run -------------------------------------------------------------------
let worker = null;
let running = false;

// A fresh worker per run gives a clean WASM linear-memory heap, the large f64
// intermediates from a previous run are freed with the old instance. This is the
// "clear cache" that stops re-runs from exhausting memory and crashing.
function freshWorker() {
  if (worker) { try { worker.terminate(); } catch (e) { /* ignore */ } }
  worker = new Worker(new URL('./worker.js', import.meta.url), { type: 'module' });
  worker.onerror = (e) => { log('✖ worker error: ' + (e.message || e)); stopProcessing(); };
  return worker;
}

const outputs = {}; // key -> {data, dims, affine, label, range, cmap}
function clearOutputs() { for (const k of Object.keys(outputs)) delete outputs[k]; }
let objectUrls = []; // download blob: URLs, revoked before each rebuild to avoid leaks
function revokeDownloadUrls() { objectUrls.forEach((u) => URL.revokeObjectURL(u)); objectUrls = []; }

// Reset the run UI (after a result, an error, or Stop).
function finishRun() {
  running = false;
  $('#stop').style.display = 'none';
  refreshRunState(); // restores the correct Run label / enabled state
}

// Stop the current run: terminate the worker (aborts in-flight WASM), keep inputs.
function stopProcessing(msg) {
  if (worker) { try { worker.terminate(); } catch (e) { /* ignore */ } worker = null; }
  finishRun();
  // don't leave a BIDS row stuck on "processing…" if the run was stopped
  if (bidsMode && bidsCurrent && bidsCurrent._state === 'running') { bidsCurrent._state = 'loaded'; updateBidsStatus(bidsCurrent); updateBidsActions(bidsCurrent); }
  $('#progress').style.display = 'none'; setProgress(0);
  if (msg) log(msg);
}
$('#stop').onclick = () => stopProcessing('■ stopped, inputs and parameters kept. Ready to run again.');

// Full reset: clear all inputs, parameters, results and logs back to defaults.
function resetAll() {
  if ((state.files.length || state.jsons.length) &&
      !confirm('Reset everything? This clears all loaded images, JSON sidecars, parameters and results.')) return;
  stopProcessing();
  if (bidsMode) closeBids();
  appMode = 'single'; applyModeVisibility(); // back to the default input mode
  state.files = []; state.jsons = [];
  clearOutputs(); lastViews = null; curKey = 't1';
  renderTable();
  $('#viewerWrap').style.display = 'none';
  revokeDownloadUrls(); $('#downloads').innerHTML = '';
  const wb = $('#warnings'); if (wb) { wb.innerHTML = ''; wb.style.display = 'none'; }
  logEl.textContent = '';
  applyPreset('7T');
  buildForm($('#b1Grid'), B1_SPEC, 'b1');
  $('#paramSource').value = 'manual'; $('#paramSrcNote').textContent = 'manual';
  $('#taskSel').value = 't1';
  if ($('#extendFov')) $('#extendFov').checked = false;
  if ($('#deid')) $('#deid').checked = true;
  if ($('#verbose')) $('#verbose').checked = false;
  refreshRunState();
  log('↺ reset, all inputs, parameters and results cleared.');
}
$('#resetAll').onclick = resetAll;

// ---- interactive guided tour ----------------------------------------------
const TOUR = [
  { sel: '.modeToggle', title: 'Step 1. Pick how you load data', body:
    'Use <b>Single dataset</b> to run one scan by drag and drop or a DICOM folder. Use <b>BIDS directory</b> to load a whole dataset: it lists every subject and session, matches the MP2RAGE and fmap files, and gives each one a <b>Calculate</b> button that runs it from its JSON parameters. The map downloads on the row, and <b>Download and unload</b> frees the memory before the next subject. The two modes are separate, so you never mix a single scan with a batch.' },
  { sel: '#drop', title: 'Step 2. Add your data (single mode)', body:
    'Drag whole <b>DICOM folders</b> here (several at once) or <b>.nii / .nii.gz</b> files. Roles (UNI, INV1, INV2, SA2RAGE, B1 map) are guessed from the headers and filenames. Check and fix them in the Role column of the table that appears, and click any file (👁) to preview it. Amber warnings flag non distortion corrected (<code>_ND</code>) images and duplicate or mis assigned series.' },
  { sel: '#paramSource', title: 'Step 3. Sequence parameters', body:
    'Choose where the timing and flip angle values come from: dropped <b>JSON sidecars</b>, the <b>DICOM headers</b> (filled in on import), or type them and use a <b>7T or 3T preset</b>. TRFLASH (the GRE readout TR) is not stored in DICOM, so confirm it from your protocol. A 1&nbsp;ms error is about 40&nbsp;ms in T1.' },
  { sel: '#taskSel', title: 'Step 4. Choose a task', body:
    '<b>Make T1 map</b>: a B1 corrected T1 from MP2RAGE (needs UNI, INV2, and a B1 source, which is SA2RAGE or a B1 map). <b>SA2RAGE to B1 map</b>: just the relative B1 map. <b>Denoise UNI to UNI-DEN</b>: removes the salt and pepper background (needs UNI, INV1, INV2). If a B1 map is smaller than the MP2RAGE you can extend it to the whole brain, but that filled region is an estimate.' },
  { sel: '#run', title: 'Step 5. Compute', body:
    'Press <b>Compute</b> to run in a background worker, so the page stays responsive. <b>Stop</b> cancels and keeps your inputs. <b>Verbose log</b> prints the parameters, each stage, and output statistics. <b>De-identify output DICOM</b> (on by default) removes patient tags from the derived DICOM series.' },
  { sel: '#viewerWrap', title: 'Step 6. Read the result', body:
    'There are three planes. Scroll with the mouse wheel over a panel, or drag the <b>A / C / S</b> sliders. Switch outputs (T1 corrected, T1 uncorrected, B1, UNI) and colormaps. The histogram overlays uncorrected and corrected T1 and marks the <b>white and grey matter peaks</b> automatically, at any field strength.', mayHide: true },
  { sel: '#downloads', title: 'Step 7. Download', body:
    'Save each map as <b>NIfTI</b> (.nii.gz), the derived <b>DICOM</b> T1 series (when the input was a DICOM folder), or <b>everything as one .zip</b>. A <code>parameters.json</code> records every value used.', mayHide: true },
  { sel: '.badge', title: 'Privacy', body:
    'Your images and all processing stay in this browser tab. They are <b>never uploaded</b>, and it works with the network off. The page uses <b>anonymous usage analytics</b> (page views only, for the NeuroDesk team) that never include your images or results. <b>Reset all</b> clears everything so you can start over.' },
];
let tourStep = 0, tourSpotEl = null;
function tourClearSpot() { if (tourSpotEl) { tourSpotEl.classList.remove('tour-spot'); tourSpotEl = null; } }
function tourPositionPop(el) {
  const pop = $('#tourPop');
  pop.style.visibility = 'hidden'; pop.style.display = 'block';
  const pw = pop.offsetWidth, ph = pop.offsetHeight, m = 14;
  let top, left;
  if (el) {
    const r = el.getBoundingClientRect();
    top = r.bottom + m; left = r.left;
    if (top + ph > innerHeight - 8) top = r.top - ph - m;          // above if no room below
    top = Math.max(8, Math.min(top, innerHeight - ph - 8));
    left = Math.max(8, Math.min(left, innerWidth - pw - 8));
  } else {
    top = Math.max(8, (innerHeight - ph) / 2); left = (innerWidth - pw) / 2;
  }
  pop.style.top = top + 'px'; pop.style.left = left + 'px';
  pop.style.visibility = 'visible';
}
function showTourStep(i) {
  tourClearSpot();
  tourStep = Math.max(0, Math.min(TOUR.length - 1, i));
  const s = TOUR[tourStep];
  const el = document.querySelector(s.sel);
  const visible = !!(el && el.offsetParent !== null && el.getClientRects().length);
  $('#tourStepNo').textContent = `Step ${tourStep + 1} of ${TOUR.length}`;
  $('#tourTitle').textContent = s.title;
  $('#tourBody').innerHTML = s.body + (!visible && s.mayHide ? '<br><span class="note">(this section appears once you press Compute)</span>' : '');
  $('#tourBack').style.visibility = tourStep === 0 ? 'hidden' : 'visible';
  $('#tourNext').textContent = tourStep === TOUR.length - 1 ? 'Done ✓' : 'Next ›';
  if (visible) {
    el.classList.add('tour-spot'); tourSpotEl = el;
    el.scrollIntoView({ block: 'center' });
  }
  tourPositionPop(visible ? el : null);
  $('#tourNext').focus();
}
function startTour() { $('#tour').style.display = 'block'; showTourStep(0); }
function endTour() { tourClearSpot(); $('#tour').style.display = 'none'; }
$('#tutorialBtn').onclick = startTour;
$('#tourNext').onclick = () => { tourStep === TOUR.length - 1 ? endTour() : showTourStep(tourStep + 1); };
$('#tourBack').onclick = () => showTourStep(tourStep - 1);
$('#tourSkip').onclick = endTour;
window.addEventListener('resize', () => { if ($('#tour').style.display === 'block') tourPositionPop(tourSpotEl); });
document.addEventListener('keydown', (e) => {
  if ($('#tour').style.display !== 'block') return;
  if (e.key === 'Escape') endTour();
  else if (e.key === 'ArrowRight') $('#tourNext').click();
  else if (e.key === 'ArrowLeft') { if (tourStep > 0) showTourStep(tourStep - 1); }
});

// Validate inputs/params before dispatching to the worker, so empty/NaN fields,
// mismatched grids or a non-2-volume SA2RAGE fail with a clear message instead of
// a silent all-NaN result or a raw WASM panic.
function validateBeforeRun(sel) {
  const { uni, inv1, inv2, sa, mode, task } = sel;
  const d3 = (f) => f.dims.slice(0, 3).join('×');
  const sameGrid = (a, b) => a.dims[0] === b.dims[0] && a.dims[1] === b.dims[1] && a.dims[2] === b.dims[2];
  for (const [nm, f] of [['INV2', inv2], ['INV1', task === 'denoise' ? inv1 : null]]) {
    if (f && !sameGrid(uni, f)) return `${nm} (${d3(f)}) and UNI (${d3(uni)}) have different dimensions. They must be on the same grid.`;
  }
  if (mode === 'sa2rage' && sa && (sa.dims[3] || 1) < 2)
    return `SA2RAGE must be a 2-volume (S1,S2) image, this one is ${sa.dims.slice(0, 4).join('×')}. Load the original 2-volume SA2RAGE.`;
  const bad = [];
  const chk = (names, vals) => names.forEach((n, i) => { if (!Number.isFinite(vals[i])) bad.push(n); });
  chk(['TR', 'TI1', 'TI2', 'FA1', 'FA2', 'NZ1', 'NZ2', 'TRFLASH', 'invEff'], mpParams());
  if (mode === 'sa2rage') chk(['SA-TR', 'SA-TD1', 'SA-TD2', 'SA-FA1', 'SA-FA2', 'SA-NZ1', 'SA-NZ2', 'SA-TRFLASH', 'avgT1'], saParams());
  if (mode === 'b1map' && !Number.isFinite(num('#b1_refangle'))) bad.push('ref flip');
  if (task === 'denoise' && !Number.isFinite(num('#reg'))) bad.push('denoise strength');
  if (bad.length) return `These parameter fields are empty or not a number: ${bad.join(', ')}. Fill them in (or use a preset).`;
  return null;
}

$('#run').onclick = async () => {
  const sel = refreshRunState();
  const { uni, inv1, inv2, sa, b1, mode, task } = sel;
  if ($('#run').disabled || !uni || running) return;
  const err = validateBeforeRun(sel);
  if (err) { log('✖ ' + err); return; }
  running = true;
  $('#run').disabled = true;
  $('#stop').style.display = '';
  clearOutputs();
  $('#downloads').innerHTML = '';
  $('#viewerWrap').style.display = 'none';
  $('#progress').style.display = 'block'; setProgress(5);
  const t0 = performance.now();
  const dims = uni.dims.slice(0, 3);
  if ($('#verbose')?.checked) {
    const roles = state.files.filter((f) => f.role !== '(ignore)').map((f) => `${f.role}=${f.name}`).join(', ');
    log(`  [verbose] task=${task}  mode=${mode || '-'}  grid=${dims.join('×')}`);
    log(`  [verbose] roles: ${roles || '(none)'}`);
    log(`  [verbose] MP2RAGE [TR,TI1,TI2,FA1,FA2,NZ1,NZ2,TRFLASH,invEff] = ${mpParams().map((x) => +x.toFixed(4)).join(', ')}`);
    if (mode === 'sa2rage') log(`  [verbose] SA2RAGE [TR,TD1,TD2,FA1,FA2,NZ1,NZ2,TRFLASH,avgT1] = ${saParams().map((x) => +x.toFixed(4)).join(', ')}`);
    if (mode === 'b1map') log(`  [verbose] B1 map: kind=${$('#b1_type').value} refAngle=${num('#b1_refangle')}° extend-FOV=${$('#extendFov')?.checked}`);
    if (task === 'denoise') log(`  [verbose] denoise β multiplier = ${num('#reg')}`);
  }
  const w = freshWorker();
  w.onmessage = (e) => onResult(e.data, uni, task, mode, t0);
  // Copy every array we post. postMessage transfers *detach* the source buffer,
  // which would empty state.files and crash the next run. Copies keep the loaded
  // inputs pristine and re-runnable.
  const uniCopy = uni.data.slice();
  outputs.uni = { data: uni.data.slice(), dims, affine: uni.affine, label: 'UNI (input)', range: [0, 4095], cmap: 'gray' };

  if (task === 'denoise') {
    log('\n▶ denoise (robust combination) …');
    const inv1Copy = inv1.data.slice(), inv2Copy = inv2.data.slice();
    const msg = { mode: 'denoise', uni: uniCopy, inv1: inv1Copy, inv2: inv2Copy, dims: Uint32Array.from(dims), reg: num('#reg') };
    setProgress(15);
    try { w.postMessage(msg, [uniCopy.buffer, inv1Copy.buffer, inv2Copy.buffer]); }
    catch (err) { log('worker post failed: ' + err); stopProcessing(); }
    return;
  }

  log(`\n▶ ${task === 'b1only' ? 'SA2RAGE → B1 map' : mode + ' correction'} …`);
  const inv2Copy = inv2 ? inv2.data.slice() : uniCopy.slice();
  const msg = { mode, uni: uniCopy, inv2: inv2Copy, dims: Uint32Array.from(dims), uniAff: uni.affine, mp: Float64Array.from(mpParams()) };
  msg.fallback = $('#fallbackUncorr') ? $('#fallbackUncorr').checked : false;
  const transfer = [uniCopy.buffer, inv2Copy.buffer];
  if (mode === 'sa2rage') {
    const saCopy = sa.data.slice();
    msg.sa = saCopy; msg.saDims = Uint32Array.from(sa.dims.slice(0, 3)); msg.saAff = sa.affine;
    msg.saP = Float64Array.from(saParams()); transfer.push(saCopy.buffer);
  } else {
    const b1Copy = b1.data.slice();
    msg.b1 = b1Copy; msg.b1Dims = Uint32Array.from(b1.dims.slice(0, 3)); msg.b1Aff = b1.affine;
    msg.kind = { tfl: 0, percent: 1, relative: 2 }[$('#b1_type').value]; msg.refAngle = num('#b1_refangle');
    msg.extendFov = $('#extendFov') ? $('#extendFov').checked : true;
    transfer.push(b1Copy.buffer);
  }
  setProgress(15);
  try { w.postMessage(msg, transfer); }
  catch (err) { log('worker post failed: ' + err); stopProcessing(); }
};

function setProgress(p) { $('#progress > div').style.width = p + '%'; }

function setupViews(list) {
  const sel = $('#viewSel');
  sel.innerHTML = '';
  for (const [val, label] of list) { const o = document.createElement('option'); o.value = val; o.textContent = label; sel.appendChild(o); }
  sel.value = list[0][0];
}

async function onResult(res, uni, task, mode, t0) {
  if (!running) return; // stale message from a stopped/replaced worker
  if (res.type === 'log') { if ($('#verbose')?.checked) log('  · ' + res.message); return; }
  if (res.type === 'error') {
    const full = String(res.message || 'unknown error');
    log('✖ processing failed: ' + full.split('\n')[0]);
    if (full.includes('\n')) { if ($('#verbose')?.checked) log(full); else log('  (turn on Verbose log for the full error)'); }
    if (bidsMode && bidsCurrent) { bidsCurrent._state = 'error'; updateBidsStatus(bidsCurrent); updateBidsActions(bidsCurrent); }
    $('#progress').style.display = 'none'; setProgress(0); finishRun(); return;
  }
  if (res.type === 'progress') { setProgress(res.pct); if (res.stage && $('#verbose')?.checked) log('  · ' + res.stage); return; }
  if (res.type !== 'result') return;
  setProgress(80);
  const dims = uni.dims.slice(0, 3), aff = uni.affine;
  for (const k of ['t1', 't1u', 'b1', 'unic']) delete outputs[k];
  let views;
  if (task === 'denoise') {
    outputs.unic = { data: res.denoised, dims, affine: aff, label: 'UNI-DEN (denoised)', range: [0, 4095], cmap: 'gray' };
    views = [['unic', 'UNI-DEN (denoised)'], ['uni', 'UNI (input)']];
  } else {
    outputs.t1 = { data: res.t1, dims, affine: aff, label: 'T1 corrected (ms)', range: [500, 2600], cmap: 'viridis' };
    outputs.t1u = { data: res.t1_uncorr, dims, affine: aff, label: 'T1 uncorrected (ms)', range: [500, 2600], cmap: 'viridis' };
    outputs.b1 = { data: res.b1, dims, affine: aff, label: 'B1 (relative)', range: [0.5, 1.3], cmap: 'plasma' };
    outputs.unic = { data: res.uni_corr, dims, affine: aff, label: 'UNI corrected', range: [0, 4095], cmap: 'gray' };
    views = task === 'b1only'
      ? [['b1', 'B1 (relative)'], ['uni', 'UNI (input)']]
      : [['t1', 'T1 corrected (ms)'], ['t1u', 'T1 uncorrected (ms)'], ['b1', 'B1 (relative)'], ['uni', 'UNI (input)']];
  }
  const secs = ((performance.now() - t0) / 1000).toFixed(1);
  log(`✔ done in ${secs}s (wasm ${res.ms?.toFixed(0)} ms)`);
  if ($('#verbose')?.checked) {
    for (const [k, o] of Object.entries(outputs)) {
      if (k === 'uni' || k === '__preview') continue;
      const s = volStats(o.data);
      log(`  [verbose] ${o.label}: ${s.nz} non-zero voxels, median ${s.med.toFixed(k === 'b1' ? 3 : 0)}, range [${s.min.toFixed(0)}, ${s.max.toFixed(0)}]`);
    }
  }
  setProgress(100);
  lastViews = views;
  setupViews(views);
  await buildDownloads(task, mode, uni);
  resetPlanes(dims); // axial ~2/3 up, coronal/sagittal mid
  $('#viewerWrap').style.display = 'block';
  showView($('#viewSel').value);
  bidsEnsureColumn();
  b1SanityWarn(task);
  if (bidsMode && bidsCurrent) await bidsRunComplete(task);
  finishRun();
  setTimeout(() => { $('#progress').style.display = 'none'; setProgress(0); }, 800);
}

// ---- downloads -------------------------------------------------------------
async function buildDownloads(task, mode, uni) {
  const dd = $('#downloads'); revokeDownloadUrls(); dd.innerHTML = '';
  const b1name = mode === 'sa2rage' ? 'B1map_from_SA2RAGE.nii.gz' : 'B1map.nii.gz';
  const items = task === 'denoise'
    ? [['unic', 'UNI_denoised.nii.gz']]
    : task === 'b1only'
      ? [['b1', b1name]]
      : [['t1', 'T1map.nii.gz'], ['b1', b1name], ['t1u', 'T1map_uncorrected.nii.gz'], ['unic', 'UNI_b1corrected.nii.gz']];
  const bundle = []; // {name, data:Uint8Array} for the "download all" zip
  const primaryKey = items[0] ? items[0][0] : null; // t1 / b1 / unic: the session's saved output
  for (const [key, fname] of items) {
    const o = outputs[key]; if (!o) continue;
    const gz = await writeNiftiGz(o.data, o.dims, o.affine);
    addLink(dd, new Blob([gz], { type: 'application/gzip' }), fname, key === primaryKey);
    bundle.push({ name: fname, data: gz });
  }
  // derived DICOM T1 series, only for the T1 task when the UNI input was a DICOM folder
  if (task === 't1' && uni && uni.src && outputs.t1) {
    try {
      await ensureWasm();
      const dims = Uint32Array.from(uni.dims.slice(0, 3));
      // Full millisecond timestamp plus a random suffix: the old low-9-digits salt
      // wrapped every ~11.5 days, so two exports that far apart could reuse UIDs.
      // Date.now() starts with a nonzero digit, so the UID component has no leading zero.
      const salt = String(Date.now()) + String(Math.floor(Math.random() * 1e6)).padStart(6, '0');
      const deid = $('#deid') ? $('#deid').checked : true;
      const dout = write_dicom_t1(uni.src.concat, uni.src.offsets, outputs.t1.data, dims, salt, deid);
      log(deid ? '  DICOM: output will be de-identified (patient tags removed)' : '  DICOM: output keeps source patient tags (de-identify unchecked)');
      const data = dout.data, offs = dout.offsets, files = [];
      for (let i = 0; i < offs.length - 1; i++)
        files.push({ name: `T1map_${String(i + 1).padStart(4, '0')}.dcm`, data: data.subarray(offs[i], offs[i + 1]) });
      addLink(dd, new Blob([zipStore(files)], { type: 'application/zip' }), 'T1map_DICOM.zip', true);
      for (const f of files) bundle.push({ name: `T1map_DICOM/${f.name}`, data: f.data });
      log(`  DICOM: derived ${files.length}-slice T1 series ready (.zip)`);
    } catch (e) { log('DICOM export skipped: ' + e); }
  }
  const prov = {
    software: 'easy-mp2rage-t1map (wasm)', task, mode,
    mp2rage: mpParams(), sa2rage: mode === 'sa2rage' ? saParams() : undefined,
    b1_map_type: mode === 'b1map' ? $('#b1_type').value : undefined,
    note: 'Computed entirely in-browser; no data uploaded.',
  };
  const provBytes = new TextEncoder().encode(JSON.stringify(prov, null, 2));
  addLink(dd, new Blob([provBytes], { type: 'application/json' }), 'parameters.json');
  bundle.push({ name: 'parameters.json', data: provBytes });
  // "download all", one zip of every derivative, shown first and highlighted
  if (bundle.length > 1) {
    const a = addLink(dd, new Blob([zipStore(bundle)], { type: 'application/zip' }), 'all_derivatives.zip', true);
    a.textContent = '⬇ Download all (.zip)';
    a.style.fontWeight = '700';
    a.style.borderColor = 'var(--accent)';
    dd.insertBefore(a, dd.firstChild);
  }
}
function addLink(parent, blob, fname, savesResult = false) {
  const url = URL.createObjectURL(blob); objectUrls.push(url);
  const a = document.createElement('a'); a.href = url; a.download = fname; a.textContent = '⬇ ' + fname;
  // Saving the session's result from the docked viewer must clear the "not
  // downloaded" state, else loadBidsEntry pops a false eviction prompt (and frees
  // the blob) for a result the user already saved. Only links that actually carry
  // the primary output count.
  if (savesResult) a.addEventListener('click', () => {
    if (bidsMode && bidsCurrent && bidsCurrent._state === 'done') { bidsCurrent._downloaded = true; updateBidsActions(bidsCurrent); }
  });
  parent.appendChild(a);
  return a;
}

// ---- built-in canvas slice viewer (self-contained, no external deps) -------
function ramp(stops) {
  return (t) => {
    t = Math.max(0, Math.min(1, t));
    const x = t * (stops.length - 1), i = Math.floor(x), f = x - i;
    const a = stops[i], b = stops[Math.min(i + 1, stops.length - 1)];
    return [a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f, a[2] + (b[2] - a[2]) * f];
  };
}
const CMAPS = {
  gray: (t) => [t * 255, t * 255, t * 255],
  hot: (t) => [Math.min(1, 3 * t) * 255, Math.min(1, Math.max(0, 3 * t - 1)) * 255, Math.min(1, Math.max(0, 3 * t - 2)) * 255],
  viridis: ramp([[68, 1, 84], [59, 82, 139], [33, 145, 140], [94, 201, 98], [253, 231, 37]]),
  plasma: ramp([[13, 8, 135], [126, 3, 168], [204, 71, 120], [248, 149, 64], [240, 249, 33]]),
};
let curKey = 't1';
let lastViews = null; // result view list, so input previews can offer a way back
const planeIdx = { ax: 0, co: 0, sa: 0 }; // current slice index per orthogonal plane

// default slice positions for a freshly shown volume: axial ~2/3 up, others mid
function resetPlanes(dims) {
  const [nx, ny, nz] = dims;
  planeIdx.ax = Math.round((nz - 1) * 2 / 3);
  planeIdx.co = ny >> 1;
  planeIdx.sa = nx >> 1;
}

// quick stats over non-zero voxels (verbose logging)
function volStats(data) {
  const n = data.length, step = Math.max(1, Math.floor(n / 300000));
  const nzv = [];
  let nz = 0, min = Infinity, max = -Infinity;
  for (let i = 0; i < n; i += step) {
    const v = data[i];
    if (v !== 0 && Number.isFinite(v)) { nz++; if (v < min) min = v; if (v > max) max = v; nzv.push(v); }
  }
  nzv.sort((a, b) => a - b);
  const med = nzv.length ? nzv[nzv.length >> 1] : 0;
  return { nz: nz * step, med, min: min === Infinity ? 0 : min, max: max === -Infinity ? 0 : max };
}

// robust display window for an arbitrary input volume (units unknown)
function robustRange(data) {
  const n = data.length;
  const step = Math.max(1, Math.floor(n / 200000));
  const pos = [];
  for (let i = 0; i < n; i += step) { const v = data[i]; if (v > 0) pos.push(v); }
  if (!pos.length) return [0, 1];
  pos.sort((a, b) => a - b);
  const hi = pos[Math.floor(pos.length * 0.99)] || pos[pos.length - 1];
  return [0, hi > 0 ? hi : 1];
}

// Load an input volume into the same slice viewer used for outputs, so inputs
// can be checked visually before/after running.
function previewInput(f, includeResultViews = true) {
  if (!f || !f.data || !f.data.length) { log(`cannot preview ${f?.name || '?'} (no data, re-add the file)`); return; }
  const dims = (f.dims || []).slice(0, 3);
  outputs.__preview = { data: f.data, dims, affine: f.affine, label: 'INPUT · ' + f.name, range: robustRange(f.data), cmap: 'gray' };
  const label = 'INPUT · ' + f.name + (f.role && f.role !== '(ignore)' ? ` (${f.role})` : '');
  // Only offer the in-memory result views alongside the preview when they belong
  // to THIS input's session; a cross-session chip preview must not surface another
  // subject's outputs in the view selector.
  const extra = includeResultViews ? (lastViews || []) : [];
  setupViews([['__preview', label], ...extra]);
  resetPlanes(dims);
  $('#viewerWrap').style.display = 'block';
  $('#viewSel').value = '__preview';
  showView('__preview');
  bidsEnsureColumn();
  if (!bidsMode) $('#viewerWrap').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

function drawPlane(canvas, o, plane, idx) {
  const [nx, ny, nz] = o.dims;
  const cmap = CMAPS[$('#cmapSel').value] || CMAPS.gray;
  const [lo, hi] = o.range;
  let w, h, at;
  if (plane === 'ax') { w = nx; h = ny; at = (x, y) => o.data[x + nx * (y + ny * idx)]; }
  else if (plane === 'co') { w = nx; h = nz; at = (x, y) => o.data[x + nx * (idx + ny * y)]; }
  else { w = ny; h = nz; at = (x, y) => o.data[idx + nx * (x + ny * y)]; }
  canvas.width = w; canvas.height = h;
  const ctx = canvas.getContext('2d');
  const img = ctx.createImageData(w, h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const v = at(x, h - 1 - y); // flip so superior/posterior is up
      let r = 0, g = 0, b = 0;
      if (v > 0 || lo < 0) { const c = cmap((v - lo) / (hi - lo)); r = c[0]; g = c[1]; b = c[2]; }
      const p = (y * w + x) * 4;
      img.data[p] = r; img.data[p + 1] = g; img.data[p + 2] = b; img.data[p + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
}

function drawSlices(o) {
  const [nx, ny, nz] = o.dims;
  const maxOf = { ax: nz - 1, co: ny - 1, sa: nx - 1 };
  for (const [p, id] of [['ax', '#slice_ax'], ['co', '#slice_co'], ['sa', '#slice_sa']]) {
    planeIdx[p] = Math.max(0, Math.min(maxOf[p], planeIdx[p]));
    const sl = $(id); if (sl) { sl.max = maxOf[p]; sl.value = planeIdx[p]; }
  }
  drawPlane($('#cax'), o, 'ax', planeIdx.ax);
  drawPlane($('#cco'), o, 'co', planeIdx.co);
  drawPlane($('#csa'), o, 'sa', planeIdx.sa);
}

function histSmooth(data, rlo, rhi, nb) {
  const bins = new Float64Array(nb);
  for (let i = 0; i < data.length; i++) {
    const v = data[i];
    if (v > rlo && v < rhi) bins[Math.min(nb - 1, ((v - rlo) / (rhi - rlo) * nb) | 0)]++;
  }
  return bins.map((_, b) => (bins[Math.max(0, b - 1)] + 2 * bins[b] + bins[Math.min(nb - 1, b + 1)]) / 4);
}

function drawHistogram(o) {
  const c = $('#hist'); const ctx = c.getContext('2d');
  const W = c.width = (c.clientWidth || 800), H = c.height = 132;
  ctx.clearRect(0, 0, W, H);
  const isT1 = o.label.startsWith('T1');
  const rlo = isT1 ? 400 : o.range[0], rhi = isT1 ? 3200 : o.range[1];
  const nb = 150;
  const pad = 20, top = 18;
  ctx.font = '11px -apple-system,sans-serif';

  // For T1 views, overlay uncorrected (pre) and B1-corrected (post).
  const series = (isT1 && outputs.t1 && outputs.t1u)
    ? [{ data: outputs.t1u.data, color: '#f0b03a', fill: false, label: 'uncorrected' },
       { data: outputs.t1.data, color: '#5aa2ff', fill: true, label: 'B1-corrected' }]
    : [{ data: o.data, color: '#5aa2ff', fill: true, label: o.label }];
  const S = series.map((s) => ({ ...s, sm: histSmooth(s.data, rlo, rhi, nb) }));
  let maxc = 0; for (const s of S) for (const v of s.sm) maxc = Math.max(maxc, v);
  if (maxc === 0) { ctx.fillStyle = '#93a1b0'; ctx.fillText('no data in range', 12, H / 2); return; }
  const xOf = (t) => pad + (t - rlo) / (rhi - rlo) * (W - pad - 8);
  const binT1 = (b) => rlo + (b + 0.5) / nb * (rhi - rlo);

  for (const s of S) {
    ctx.beginPath();
    for (let b = 0; b < nb; b++) {
      const x = xOf(binT1(b)), y = H - pad - (s.sm[b] / maxc) * (H - pad - top);
      b === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
    }
    if (s.fill) {
      ctx.lineTo(xOf(binT1(nb - 1)), H - pad); ctx.lineTo(xOf(binT1(0)), H - pad); ctx.closePath();
      ctx.fillStyle = s.color + 'cc'; ctx.fill();
    } else {
      ctx.strokeStyle = s.color; ctx.lineWidth = 1.6; ctx.stroke();
    }
  }

  ctx.fillStyle = '#93a1b0';
  ctx.fillText(isT1 ? 'T1 histogram (brain)' : `${o.label}, brain histogram`, pad, 12);
  ctx.fillText(String(Math.round(rlo)), pad, H - 5);
  ctx.textAlign = 'right'; ctx.fillText(String(Math.round(rhi)), W - 5, H - 5); ctx.textAlign = 'left';

  // legend (top-right)
  let lx = W - 8;
  for (const s of [...S].reverse()) {
    ctx.textAlign = 'right'; ctx.fillStyle = s.color; ctx.fillText(s.label, lx, 12);
    lx -= ctx.measureText(s.label).width + 22;
    ctx.fillRect(lx + 6, 4, 10, 8);
  }
  ctx.textAlign = 'left';

  if (!isT1) return;
  // WM/GM peaks detected dynamically (field-agnostic: works at 3T and 7T) as the
  // two most prominent modes of the corrected (post) T1 distribution. Lower T1 is
  // white matter, higher is grey matter, true at every field strength.
  const post = S[S.length - 1].sm;
  const modes = topTwoModes(post, nb, binT1);
  const labels = modes.length === 2 ? ['WM', 'GM'] : ['peak'];
  const cols = ['#7cd6ff', '#ffd479'];
  modes.forEach((m, i) => {
    const t = binT1(m);
    const x = xOf(t);
    ctx.strokeStyle = cols[i]; ctx.setLineDash([3, 3]);
    ctx.beginPath(); ctx.moveTo(x, top); ctx.lineTo(x, H - pad); ctx.stroke(); ctx.setLineDash([]);
    ctx.fillStyle = cols[i]; ctx.fillText(`${labels[i]} ~${Math.round(t)}`, Math.min(x + 4, W - 74), top + 6);
  });
}

// The (up to) two most prominent local maxima of a smoothed histogram, returned
// as bin indices sorted low→high T1, requiring a minimum peak height and
// separation so noise ripples aren't picked.
function topTwoModes(sm, nb, binT1) {
  let maxc = 0; for (const v of sm) if (v > maxc) maxc = v;
  if (maxc === 0) return [];
  const minH = 0.12 * maxc;         // ignore tiny ripples
  const minSepMs = 250;             // WM and GM must be at least this far apart
  const cands = [];
  for (let b = 2; b < nb - 2; b++) {
    if (sm[b] >= minH && sm[b] > sm[b - 1] && sm[b] >= sm[b + 1] && sm[b] > sm[b - 2] && sm[b] >= sm[b + 2])
      cands.push(b);
  }
  cands.sort((a, b) => sm[b] - sm[a]); // strongest first
  const picks = [];
  for (const b of cands) {
    if (picks.every((p) => Math.abs(binT1(p) - binT1(b)) > minSepMs)) picks.push(b);
    if (picks.length === 2) break;
  }
  return picks.sort((a, b) => a - b); // low T1 (WM) first
}

// Sanity-check the relative B1 map: a real B1+ transmit field sits near 1.0 and
// varies smoothly. If it is far from 1.0 or wildly non-uniform, the "B1 map" is
// probably a magnitude/anatomical image or the wrong units, and the corrected T1
// is invalid; warn and point the user to the uncorrected T1.
function b1SanityWarn(task) {
  const w = $('#viewWarn'); if (!w) return;
  const o = outputs.b1;
  if (!o || !o.data) { w.style.display = 'none'; return; }
  const d = o.data, n = d.length, step = Math.max(1, Math.floor(n / 300000)), v = [];
  for (let i = 0; i < n; i += step) { const x = d[i]; if (x > 0 && Number.isFinite(x)) v.push(x); }
  if (v.length < 100) { w.style.display = 'none'; return; }
  v.sort((a, b) => a - b);
  const q = (p) => v[Math.min(v.length - 1, Math.floor(v.length * p))];
  const med = q(0.5), spread = med > 0 ? (q(0.9) - q(0.1)) / med : 99;
  // A real B1+ transmit field sits near 1.0. The median is the reliable tell for
  // a magnitude/anatomical image or wrong units. Spread alone is not: a genuine
  // 7T field with cerebellar/temporal drop-out can reach ~0.9, so only treat a
  // very high spread as suspicious when the median is also off (avoids flagging
  // legitimate strong-but-smooth 7T inhomogeneity).
  const bad = med < 0.5 || med > 1.7 || (spread > 1.0 && (med < 0.75 || med > 1.3));
  if (bad) {
    const advise = task === 'b1only'
      ? `This B1 map is unlikely to give a valid correction; check that you selected a flip-angle map (not an anatomical/magnitude image) and the correct B1 type.`
      : `The B1-corrected T1 is likely invalid. Switch the View to <b>T1 uncorrected</b> (also in the downloads), or supply a proper B1 map.`;
    w.innerHTML = `<b>⚠ This B1 map does not look like a B1⁺ field</b> (relative B1 median ${med.toFixed(2)}; a real transmit field sits near 1.0 and varies smoothly). ` +
      `The input may be a magnitude/anatomical image rather than a flip-angle map, or the units/type are wrong. ` + advise;
    w.style.display = 'block';
    log(`⚠ B1 sanity: relative B1 median ${med.toFixed(2)} (expected ~1.0); this does not look like a B1⁺ field.`);
  } else {
    w.style.display = 'none';
  }
}

function showView(key) {
  const o = outputs[key];
  if (!o) return;
  curKey = key;
  if (o.cmap && CMAPS[o.cmap]) $('#cmapSel').value = o.cmap; // per-view default colormap
  $('#viewStat').textContent = `${o.label} · ${o.dims.join('×')} · window [${o.range[0]}, ${o.range[1]}]`;
  drawSlices(o);
  drawHistogram(o);
}
$('#viewSel').onchange = () => showView($('#viewSel').value);
$('#cmapSel').onchange = () => { const o = outputs[curKey]; if (o) drawSlices(o); };
// per-plane sliders
for (const [p, id] of [['ax', '#slice_ax'], ['co', '#slice_co'], ['sa', '#slice_sa']]) {
  const sl = $(id); if (!sl) continue;
  sl.oninput = () => { planeIdx[p] = +sl.value; const o = outputs[curKey]; if (o) drawSlices(o); };
}
// mouse-wheel over any panel scrolls that plane
for (const [cid, p] of [['#cax', 'ax'], ['#cco', 'co'], ['#csa', 'sa']]) {
  const cv = $(cid); if (!cv) continue;
  cv.addEventListener('wheel', (e) => {
    const o = outputs[curKey]; if (!o) return;
    e.preventDefault();
    planeIdx[p] += e.deltaY > 0 ? 1 : -1;
    drawSlices(o);
  }, { passive: false });
}
// redraw slices + histogram when the viewport (and so the docked column) resizes,
// so the histogram re-fits its container dynamically
let _viewerResizeT;
window.addEventListener('resize', () => {
  clearTimeout(_viewerResizeT);
  _viewerResizeT = setTimeout(() => {
    const o = outputs[curKey];
    if (o && $('#viewerWrap').style.display !== 'none') { drawSlices(o); drawHistogram(o); }
  }, 150);
});

// ---- BIDS batch mode -------------------------------------------------------
// Index a BIDS dataset, list every subject/session with role-matching status,
// and run them one at a time through the existing pipeline/viewer. Only one
// entry is ever held in memory: loading the next frees the previous.
let bidsIndex = null, bidsMode = false, bidsCurrent = null, bidsLoading = false;
const baseName = (p) => (p || '').split('/').pop();
const entryLabel = (s) => s._sub + (s.id ? ' · ' + s.id : '');

// ---- input-mode toggle (single vs BIDS are mutually exclusive) ------------
function syncModeButtons() {
  $('#modeSingle').classList.toggle('active', appMode === 'single');
  $('#modeBids').classList.toggle('active', appMode === 'bids');
  $('#modeSingle').setAttribute('aria-selected', appMode === 'single');
  $('#modeBids').setAttribute('aria-selected', appMode === 'bids');
}
function applyModeVisibility() {
  const bids = appMode === 'bids';
  $('#drop').style.display = bids ? 'none' : '';
  $('#dicomRow').style.display = bids ? 'none' : '';
  $('#bidsRow').style.display = bids ? '' : 'none';
  syncModeButtons();
}
function setAppMode(mode) {
  if (mode === appMode) return;
  if (running) { log('Stop the current run before switching modes.'); return; }
  if (bidsMode) closeBids();
  revokeDownloadUrls(); clearOutputs(); lastViews = null; bidsCurrent = null;
  state.files = []; state.jsons = [];
  $('#downloads').innerHTML = ''; $('#viewerWrap').style.display = 'none';
  const wb = $('#warnings'); if (wb) { wb.innerHTML = ''; wb.style.display = 'none'; }
  freeWorker(); renderTable();
  appMode = mode;
  applyModeVisibility();
  refreshRunState();
  log(mode === 'bids' ? 'Switched to BIDS directory mode. Choose a BIDS dataset root.' : 'Switched to single-dataset mode.');
}
$('#modeSingle').onclick = () => setAppMode('single');
$('#modeBids').onclick = () => setAppMode('bids');
applyModeVisibility();

// ---- BIDS side-docked viewer (tree left, viewer sticky on the right) -------
const _viewer = $('#viewerWrap');
const _viewerHome = { parent: _viewer.parentNode, next: _viewer.nextElementSibling };
function dockViewerBids() {
  const slot = $('#bidsViewSlot');
  if (slot && _viewer.parentNode !== slot) { slot.appendChild(_viewer); _viewer.classList.add('docked'); }
}
function undockViewer() {
  if (_viewer.parentNode !== _viewerHome.parent) {
    _viewerHome.next ? _viewerHome.parent.insertBefore(_viewer, _viewerHome.next) : _viewerHome.parent.appendChild(_viewer);
  }
  _viewer.classList.remove('docked');
  _viewer.style.display = ''; // back to CSS default (hidden until a single-mode run)
  const cols = $('#bidsCols'); if (cols) cols.classList.remove('with-viewer');
}
// Keep the right viewer column present in BIDS mode.
function bidsEnsureColumn() { if (!bidsMode) return; const cols = $('#bidsCols'); if (cols) cols.classList.add('with-viewer'); }
// Blank the docked viewer with a short hint when nothing is loaded.
function bidsShowPlaceholder() {
  bidsEnsureColumn();
  _viewer.style.display = 'block';
  $('#viewStat').textContent = 'Load or calculate a session to view it here.';
  for (const id of ['#cax', '#cco', '#csa', '#hist']) { const c = $(id); if (c) c.getContext('2d').clearRect(0, 0, c.width, c.height); }
  $('#downloads').innerHTML = '';
  const vw = $('#viewWarn'); if (vw) vw.style.display = 'none';
}

$('#pickBids').onclick = () => $('#bidsInput').click();
$('#bidsInput').onchange = (e) => loadBidsDirectory(e.target.files);
$('#bidsClose').onclick = closeBids;
$('#bidsNext').onclick = calculateNextBidsEntry;
// Apply a session's per-session options (extend-FOV / fallback / denoise β) plus the
// batch verbose toggle to the shared run controls, right before it is run.
function applyBidsSessionOptions(ses) {
  if ($('#extendFov')) $('#extendFov').checked = !!ses._extendFov;
  if ($('#fallbackUncorr')) $('#fallbackUncorr').checked = !!ses._fallback;
  if ($('#reg')) $('#reg').value = ses._reg;
  if ($('#verbose') && $('#bidsVerbose')) $('#verbose').checked = $('#bidsVerbose').checked;
}
// The toolbar option controls are BATCH DEFAULTS: changing one re-seeds every
// not-yet-run session and re-renders it (per-session controls still override).
function reseedBidsDefaults() {
  if (!bidsIndex || !bidsIndex._flat) return;
  for (const s of bidsIndex._flat) {
    if (s._state === 'pending') {
      s._extendFov = !!$('#bidsExtendFov').checked;
      s._fallback = !!$('#bidsFallback').checked;
      s._reg = +$('#bidsReg').value || 6;
      if (s._el) rerenderBidsSession(s);
    }
  }
}
$('#bidsExtendFov').onchange = reseedBidsDefaults;
$('#bidsFallback').onchange = reseedBidsDefaults;
$('#bidsReg').onchange = reseedBidsDefaults; // change (not input) to avoid re-rendering the tree per keystroke
$('#bidsVerbose').onchange = () => { if ($('#verbose')) $('#verbose').checked = $('#bidsVerbose').checked; };

function closeBids() {
  if (running) stopProcessing();
  undockViewer(); // move the viewer back to its full-width home before clearing

  if (bidsIndex?._flat) for (const s of bidsIndex._flat) if (s._dlUrl) { try { URL.revokeObjectURL(s._dlUrl); } catch (e) { /* */ } s._dlUrl = null; }
  bidsMode = false; bidsCurrent = null; bidsIndex = null;
  // free the loaded session (outputs, inputs, worker heap) and reset the viewer
  clearOutputs(); state.files = []; state.jsons = []; lastViews = null;
  revokeDownloadUrls(); $('#downloads').innerHTML = '';
  $('#viewerWrap').style.display = 'none';
  const wb = $('#warnings'); if (wb) { wb.innerHTML = ''; wb.style.display = 'none'; }
  freeWorker(); renderTable();
  $('#bidsPanel').classList.add('hidden');
  $('#bidsTree').innerHTML = '';
  log('BIDS mode closed.');
}

function loadBidsDirectory(fileList) {
  // normalise every path to start at the "sub-XX/…" segment (strip any parent dirs)
  const entries = [];
  for (const f of [...fileList]) {
    const segs = (f.webkitRelativePath || f.name).replace(/\\/g, '/').split('/');
    const si = segs.findIndex((s) => /^sub-[A-Za-z0-9]+$/.test(s));
    entries.push({ path: si >= 0 ? segs.slice(si).join('/') : segs.join('/'), file: f });
  }
  let idx;
  try { idx = indexBids(entries); }
  catch (err) { log('BIDS: could not index this directory: ' + err); return; }
  if (!idx.nSubjects) { log('BIDS: no sub-* subjects found here. Point at a BIDS dataset root.'); return; }
  bidsIndex = idx; bidsMode = true; bidsCurrent = null;
  bidsIndex._flat = [];
  for (const sub of idx.subjects) for (const ses of sub.sessions) {
    ses._sub = sub.id; ses._roles = { ...ses.roles }; ses._state = 'pending';
    bidsIndex._flat.push(ses);
  }
  const runnable = bidsIndex._flat.filter((s) => s.runnable.t1 || s.runnable.b1only || s.runnable.denoise).length;
  $('#bidsSummary').textContent = `${idx.nSubjects} subject(s) · ${idx.nSessions} session(s) · ${runnable} runnable`;
  renderBidsTree();
  $('#bidsPanel').classList.remove('hidden');
  dockViewerBids(); bidsShowPlaceholder(); // permanent viewer on the right
  $('#bidsPanel').scrollIntoView({ behavior: 'smooth', block: 'start' });
  log(`BIDS: indexed ${idx.nSubjects} subject(s), ${idx.nSessions} session(s); ${runnable} runnable.`);
}

function renderBidsTree() {
  const tree = $('#bidsTree'); tree.innerHTML = '';
  for (const sub of bidsIndex.subjects) {
    const det = document.createElement('details'); det.className = 'bids-sub';
    det.open = bidsIndex.subjects.length <= 6;
    const sum = document.createElement('summary');
    sum.textContent = `${sub.id}, ${sub.sessions.length} session(s)`;
    det.appendChild(sum);
    for (const ses of sub.sessions) det.appendChild(renderBidsSession(ses));
    tree.appendChild(det);
  }
}

const BIDS_ROLES = [['UNI', 'UNI'], ['INV1', 'INV1'], ['INV2', 'INV2'], ['B1SOURCE', 'B1 source']];

const roleLabel = (rk) => ({ UNI: 'UNI', INV1: 'INV1', INV2: 'INV2', B1SOURCE: 'B1 source' }[rk] || rk);
function bidsInitSession(ses) {
  if (ses._task === undefined) ses._task = ses.runnable.t1 ? 't1' : ses.runnable.b1only ? 'b1only' : ses.runnable.denoise ? 'denoise' : null;
  if (ses._editRole === undefined) ses._editRole = 'UNI';
  // per-session processing options (seeded from the toolbar batch defaults)
  if (ses._extendFov === undefined) ses._extendFov = !!($('#bidsExtendFov') && $('#bidsExtendFov').checked);
  if (ses._fallback === undefined) ses._fallback = !!($('#bidsFallback') && $('#bidsFallback').checked);
  if (ses._reg === undefined) ses._reg = ($('#bidsReg') ? +$('#bidsReg').value : 6) || 6;
}
function bidsTasks(ses) {
  const t = [];
  if (ses.runnable.t1) t.push(['t1', 'Make T1 map']);
  if (ses.runnable.b1only) t.push(['b1only', 'SA2RAGE → B1 map']);
  if (ses.runnable.denoise) t.push(['denoise', 'Denoise UNI → UNI-DEN']);
  return t;
}
function bidsRecomputeRunnable(ses) {
  const has = (rk) => !!ses._roles[rk];
  ses.runnable = {
    t1: has('UNI') && has('INV2') && has('B1SOURCE'),
    denoise: has('UNI') && has('INV1') && has('INV2'),
    b1only: has('UNI') && has('INV2') && has('B1SOURCE') && ses.b1kind === 'sa2rage',
  };
  const tasks = bidsTasks(ses).map((x) => x[0]);
  if (!tasks.includes(ses._task)) ses._task = tasks[0] || null;
}
function fillReassign(ses, sel) {
  sel.innerHTML = '';
  const none = document.createElement('option'); none.value = ''; none.textContent = '(none)'; sel.appendChild(none);
  const cur = ses._roles[ses._editRole];
  for (const f of (ses.files || [])) {
    const o = document.createElement('option'); o.value = f.path; o.textContent = baseName(f.path);
    if (cur && cur.path === f.path) o.selected = true;
    sel.appendChild(o);
  }
}
function rerenderBidsSession(ses) {
  const old = ses._el; // capture BEFORE render (renderBidsSession reassigns ses._el)
  const fresh = renderBidsSession(ses);
  if (old && old.parentNode) old.parentNode.replaceChild(fresh, old);
}
function bidsAssignRole(ses, rk, file) {
  ses._roles[rk] = file;
  if (rk === 'B1SOURCE') ses.b1kind = file ? (/tb1srge/i.test(file.path) ? 'sa2rage' : 'b1map') : ses.b1kind;
  // Refresh only THIS role's status, from an actual filename check so a mismatched
  // hand-pick is flagged (warn) rather than shown as a validated green chip. Other
  // roles' statuses stay intact.
  ses.status = { ...ses.status, [rk]: file
    ? (roleFits(rk, file.path)
        ? { state: 'ok', reason: 'manually assigned' }
        : { state: 'warn', reason: `manually assigned; ${baseName(file.path)} does not look like a ${roleLabel(rk)}` })
    : { state: 'missing', reason: 'not assigned' } };
  // Reassigning inputs invalidates any computed result. If it is done but unsaved,
  // offer to download it before it is discarded, then free its blob (previously it
  // leaked and became UI-unreachable with no prompt).
  if (['loaded', 'done', 'unloaded'].includes(ses._state)) {
    if (ses._dlUrl) {
      let triggered = false;
      if (!ses._downloaded &&
          confirm(`Reassigning ${roleLabel(rk)} discards the computed result for ${entryLabel(ses)} (${ses._dlName}), which has not been downloaded. Download it first?`)) {
        bidsDownload(ses); triggered = true;
      }
      if (triggered) deferRevoke(ses._dlUrl);
      else { try { URL.revokeObjectURL(ses._dlUrl); } catch (e) { /* */ } }
      ses._dlUrl = null;
    }
    ses._state = 'pending'; // inputs changed, recompute
  }
  // Keep the index-time warnings (they may flag a real problem with an untouched
  // role) but mark them possibly-stale instead of wiping them silently.
  ses._edited = true;
  bidsRecomputeRunnable(ses);
  rerenderBidsSession(ses);
}
function bidsChipClick(ses, rk, rlabel) {
  previewBidsRole(ses, rk, rlabel);
  ses._editRole = rk;
  if (ses._el) ses._el.querySelectorAll('.chip').forEach((c) => c.classList.toggle('active', c.dataset.rk === rk));
  const rn = ses._el && ses._el.querySelector('.bids-reassign b'); if (rn) rn.textContent = roleLabel(rk);
  if (ses._reassignSel) fillReassign(ses, ses._reassignSel);
}

function renderBidsSession(ses) {
  bidsInitSession(ses);
  const box = document.createElement('div'); box.className = 'bids-ses'; ses._el = box;
  if (bidsCurrent === ses) box.classList.add('current');
  const anyTask = !!(ses.runnable.t1 || ses.runnable.b1only || ses.runnable.denoise);
  const title = document.createElement('div'); title.className = 'lbl';
  title.textContent = entryLabel(ses) + (anyTask ? '' : ', not runnable');
  box.appendChild(title);
  // clickable role chips: preview on the right + pick which role the reassign menu edits
  const roles = document.createElement('div'); roles.className = 'bids-roles';
  for (const [rk, rlabel] of BIDS_ROLES) {
    const st = ses.status[rk] || { state: 'missing' };
    const chosen = ses._roles[rk];
    const cls = !chosen ? 'miss' : st.state === 'ok' ? 'ok' : 'warn';
    const chip = document.createElement('span'); chip.className = 'chip clickable ' + cls; chip.dataset.rk = rk;
    chip.textContent = `${rlabel}: ${chosen ? baseName(chosen.path) : '(none)'}`;
    if (rk === ses._editRole) chip.classList.add('active');
    chip.title = (st.reason ? st.reason + '  ·  ' : '') + (chosen ? 'click to preview and reassign this role' : 'click to reassign this role');
    chip.onclick = () => bidsChipClick(ses, rk, rlabel);
    roles.appendChild(chip);
  }
  box.appendChild(roles);
  // controls: task selector + reassign menu (follows the active chip)
  const ctrl = document.createElement('div'); ctrl.className = 'bids-ctrl';
  const tasks = bidsTasks(ses);
  if (tasks.length) {
    const tl = document.createElement('label'); tl.textContent = 'Task: ';
    const tsel = document.createElement('select');
    for (const [v, lbl] of tasks) { const o = document.createElement('option'); o.value = v; o.textContent = lbl; if (v === ses._task) o.selected = true; tsel.appendChild(o); }
    tsel.onchange = () => { ses._task = tsel.value; rerenderBidsSession(ses); }; // re-render so the task-specific options update
    tl.appendChild(tsel); ctrl.appendChild(tl);
  }
  // task-contextual per-session options
  const mkChk = (labelTxt, checked, onToggle, title) => {
    const l = document.createElement('label'); l.className = 'chk'; if (title) l.title = title;
    const c = document.createElement('input'); c.type = 'checkbox'; c.checked = checked; c.onchange = () => onToggle(c.checked);
    l.appendChild(c); l.appendChild(document.createTextNode(' ' + labelTxt)); ctrl.appendChild(l);
  };
  if (ses._task === 't1') {
    if (ses.b1kind === 'b1map') mkChk('extend B1 FOV', ses._extendFov, (v) => { ses._extendFov = v; }, 'Extend a too-small B1 map to the whole brain (filled regions are estimates).');
    mkChk('fill non-converged', ses._fallback, (v) => { ses._fallback = v; }, 'Fill non-converged T1 voxels (mostly CSF / long-T1) with the uncorrected T1.');
  }
  if (ses._task === 'denoise') {
    const l = document.createElement('label'); l.className = 'chk'; l.title = 'Denoise strength (larger removes more background).';
    l.appendChild(document.createTextNode('denoise β '));
    const n = document.createElement('input'); n.type = 'number'; n.value = ses._reg; n.step = '1'; n.min = '1'; n.style.width = '52px';
    n.oninput = () => { ses._reg = +n.value || 6; };
    l.appendChild(n); ctrl.appendChild(l);
  }
  const rl = document.createElement('label'); rl.className = 'bids-reassign'; rl.appendChild(document.createTextNode('Reassign '));
  const rn = document.createElement('b'); rn.textContent = roleLabel(ses._editRole); rl.appendChild(rn); rl.appendChild(document.createTextNode(': '));
  const rsel = document.createElement('select'); ses._reassignSel = rsel; fillReassign(ses, rsel);
  rsel.onchange = () => bidsAssignRole(ses, ses._editRole, (ses.files || []).find((f) => f.path === rsel.value) || null);
  rl.appendChild(rsel); ctrl.appendChild(rl);
  box.appendChild(ctrl);
  // warnings (index-time QC; flagged stale once the user has hand-edited roles)
  if (ses.warnings?.length) {
    const note = ses._edited ? 'roles manually edited, these index-time notes may be stale  ·  ' : '';
    const w = document.createElement('div'); w.className = 'bids-warn'; w.textContent = '⚠ ' + note + ses.warnings.join('  ·  ');
    box.appendChild(w);
  }
  // actions
  const act = document.createElement('div'); act.className = 'bids-actions'; ses._actEl = act;
  box.appendChild(act);
  const status = document.createElement('span'); status.className = 'bids-status'; ses._statusEl = status;
  box.appendChild(status);
  updateBidsActions(ses); updateBidsStatus(ses);
  return box;
}

function updateBidsStatus(ses) {
  if (!ses._statusEl) return;
  const m = { pending: '', loading: '⋯ loading…', loaded: '● loaded, press Compute', running: '⋯ processing…', done: '✓ done, result in the viewer', error: '✖ error', unloaded: '✓ saved & unloaded' };
  ses._statusEl.textContent = m[ses._state] || '';
}

// Rebuild the per-session buttons for the current state.
function updateBidsActions(ses) {
  const act = ses._actEl; if (!act) return;
  act.innerHTML = '';
  const mk = (txt, fn, cls) => { const b = document.createElement('button'); b.type = 'button'; if (cls) b.className = cls; b.textContent = txt; b.onclick = fn; act.appendChild(b); return b; };
  const dlLink = () => {
    if (!ses._dlUrl) return;
    const a = document.createElement('a'); a.href = ses._dlUrl; a.download = ses._dlName;
    a.textContent = (ses._downloaded ? '⬇ ' : '⬇ Download ') + ses._dlName;
    a.title = ses._downloaded ? 'already downloaded' : 'not downloaded yet';
    if (!ses._downloaded) a.style.fontWeight = '700';
    a.onclick = () => { ses._downloaded = true; };
    act.appendChild(a);
  };
  if (ses._state === 'running') { const s = document.createElement('span'); s.className = 'bids-status'; s.textContent = 'processing… (Stop to cancel)'; act.appendChild(s); return; }
  if (ses._state === 'done') {
    dlLink();
    mk('👁 View', () => viewBidsResult(ses), 'secondary');
    mk('Download & unload', () => downloadUnloadBids(ses), 'secondary');
    return;
  }
  if (ses._state === 'unloaded') {
    dlLink();
    mk('⚙ Recalculate', () => calculateBidsEntry(ses), 'secondary');
    return;
  }
  // pending / loaded / error
  mk('load & edit', () => loadBidsEntry(ses, { scroll: false }), 'secondary');
  if (!bidsTasks(ses).length) { const s = document.createElement('span'); s.className = 'bids-status'; s.textContent = 'not runnable (missing inputs)'; act.appendChild(s); return; }
  const label = ses._task === 'b1only' ? '⚙ Calculate B1 map' : ses._task === 'denoise' ? '⚙ Calculate UNI-DEN' : '⚙ Calculate T1 map';
  mk(label, () => calculateBidsEntry(ses));
}

// Preview one of a session's role images (UNI/INV1/INV2/B1) in the docked right
// viewer. Uses the already-loaded copy when this session is current; otherwise
// reads the file on demand (no need to load/run the whole session).
async function previewBidsRole(ses, rk, rlabel) {
  const f = ses._roles[rk];
  if (!f) { log(`BIDS: no ${rlabel} file for ${entryLabel(ses)}.`); return; }
  const appRole = rk === 'B1SOURCE' ? (ses.b1kind === 'sa2rage' ? 'SA2RAGE' : 'B1 map') : rk;
  if (bidsCurrent === ses) {
    const got = state.files.find((x) => x.role === appRole);
    if (got && got.data && got.data.length) { previewInput(got); return; }
  }
  try {
    bidsEnsureColumn();
    $('#viewStat').textContent = `reading ${baseName(f.path)} …`;
    const buf = await f.file.arrayBuffer();
    const nii = await readNifti(buf);
    // Reading another session's file on demand: its result is not in memory, so
    // do not append lastViews (which belongs to whatever session is current).
    previewInput({ name: baseName(f.path), dims: nii.dims, affine: nii.affine, data: nii.data, role: appRole }, false);
  } catch (e) { log(`BIDS: could not preview ${baseName(f.path)}: ${e}`); }
}

// Load one entry's files + parameters into the shared pipeline. Frees whatever
// was loaded before, so only one session is ever in memory.
async function loadBidsEntry(ses, opts = {}) {
  if (running) { log('BIDS: a run is in progress, Stop it first.'); return false; }
  if (bidsLoading) { log('BIDS: a session is still loading, one moment.'); return false; }
  bidsLoading = true;
  const scroll = opts.scroll !== false;
  // starting a different session unloads the previous done result (and frees its
  // download blob). Prompt to download it first if it hasn't been saved.
  if (bidsCurrent && bidsCurrent !== ses && bidsCurrent._state === 'done') {
    const prev = bidsCurrent;
    let triggered = false;
    if (prev._dlUrl && !prev._downloaded &&
        confirm(`The result for ${entryLabel(prev)} (${prev._dlName}) has not been downloaded and will be freed to make room for the next session. Download it now?`)) {
      bidsDownload(prev); triggered = true;
    }
    if (prev._dlUrl) {
      // If we just kicked off a download, defer the revoke so it isn't aborted;
      // otherwise the blob is unused and can be freed now.
      if (triggered) deferRevoke(prev._dlUrl);
      else { try { URL.revokeObjectURL(prev._dlUrl); } catch (e) { /* */ } }
      prev._dlUrl = null;
    }
    prev._state = 'unloaded'; updateBidsStatus(prev); updateBidsActions(prev);
  }
  bidsCurrent = ses;
  revokeDownloadUrls(); clearOutputs(); lastViews = null;
  state.files = []; state.jsons = [];
  bidsShowPlaceholder();
  if (ses._dlUrl) { try { URL.revokeObjectURL(ses._dlUrl); } catch (e) { /* */ } ses._dlUrl = null; }
  for (const s of bidsIndex._flat) if (s._el) s._el.classList.toggle('current', s === ses);
  ses._state = 'loading'; updateBidsStatus(ses); updateBidsActions(ses);
  try {
    let b1type = 'tfl';
    for (const rk of ['UNI', 'INV1', 'INV2', 'B1SOURCE']) {
      const f = ses._roles[rk]; if (!f) continue;
      let role;
      if (rk === 'B1SOURCE') {
        role = ses.b1kind === 'sa2rage' ? 'SA2RAGE' : 'B1 map';
        b1type = /tb1tfl/i.test(f.path) ? 'tfl' : /tb1map|rb1cor/i.test(f.path) ? 'percent' : 'tfl';
      } else role = rk;
      const buf = await f.file.arrayBuffer();
      const nii = await readNifti(buf);
      state.files.push({ name: baseName(f.path), size: f.file.size, dims: nii.dims, affine: nii.affine, data: nii.data, role, bids: true });
    }
    for (const sc of (ses.sidecars || [])) {
      try { state.jsons.push({ name: baseName(sc.path), json: JSON.parse(await sc.file.text()) }); } catch (e) { /* ignore */ }
    }
    // Reset the parameter form to a field-appropriate preset FIRST, so values never
    // leak from the previous session; then overlay this session's sidecar values.
    // Coerce first: real sidecars sometimes store MagneticFieldStrength as a
    // string ("7", "6.98"), which Number.isFinite() would reject and silently
    // fall back to the 3T preset for a 7T scan.
    const b0 = state.jsons.map((j) => parseFloat(j.json.MagneticFieldStrength)).find((v) => Number.isFinite(v));
    applyPreset(b0 && b0 >= 6.5 ? '7T' : '3T');
    if (state.jsons.length) { for (const j of state.jsons) applySidecar(j.name, j.json); $('#paramSource').value = 'json'; $('#paramSrcNote').textContent = 'from sidecars'; }
    else $('#paramSrcNote').textContent = (b0 && b0 >= 6.5 ? '7T' : '3T') + ' preset (no sidecars)';
    if (ses.b1kind !== 'sa2rage' && $('#b1_type')) $('#b1_type').value = b1type;
    applyBidsSessionOptions(ses); // this session's extend-FOV / fallback / denoise β
    $('#taskSel').value = ses._task || (ses.runnable.t1 ? 't1' : ses.runnable.denoise ? 'denoise' : 't1');
    renderTable(); refreshRunState();
    ses._state = 'loaded'; updateBidsStatus(ses); updateBidsActions(ses);
    log(`BIDS: loaded ${entryLabel(ses)} (${state.files.map((f) => f.role).join(', ')}${state.jsons.length ? '; params from ' + state.jsons.length + ' sidecar(s)' : ''}).`);
    // show the input on the right immediately (no page scroll); user can click other roles to preview them
    const uniFile = state.files.find((f) => f.role === 'UNI') || state.files[0];
    if (uniFile) previewInput(uniFile);
    void scroll;
    return true;
  } catch (err) {
    ses._state = 'error'; updateBidsStatus(ses); updateBidsActions(ses);
    log(`BIDS: failed to load ${entryLabel(ses)}: ${err}`);
    return false;
  } finally {
    bidsLoading = false;
  }
}

// One click: load this session (params from its JSON sidecars + preset defaults)
// and run it. TRFLASH is not in BIDS, so it comes from the current preset.
async function calculateBidsEntry(ses) {
  if (running) { log('BIDS: a run is already in progress, Stop it first.'); return; }
  if (bidsLoading) { log('BIDS: a session is still loading, one moment.'); return; }
  const ok = await loadBidsEntry(ses, { scroll: false });
  if (!ok) return;
  const sel = refreshRunState();
  const err = validateBeforeRun(sel);
  if ($('#run').disabled || err) {
    log(`BIDS: cannot calculate ${entryLabel(ses)}${err ? ': ' + err : ' (missing inputs).'}`);
    ses._state = 'error'; updateBidsStatus(ses); updateBidsActions(ses); return;
  }
  ses._state = 'running'; updateBidsStatus(ses); updateBidsActions(ses);
  $('#run').click(); // reuse the validated run path; onResult → bidsRunComplete
}

function bidsOutName(ses, task) {
  const stem = ses._sub + (ses.id ? '_' + ses.id : '');
  if (task === 'denoise') return `${stem}_desc-denoised_UNIT1.nii.gz`;
  if (task === 'b1only') return `${stem}_B1map.nii.gz`;
  return `${stem}_T1map.nii.gz`;
}

// Revoke a blob URL that was just handed to a click()-triggered download on a
// later tick. Revoking synchronously right after a.click() can abort the still-
// queued download (the browser has not finished reading the blob yet), which on
// Firefox/Safari and multi-MB files silently loses the file. A short defer lets
// the download task grab the blob first, then frees it.
function deferRevoke(url) {
  if (!url) return;
  setTimeout(() => { try { URL.revokeObjectURL(url); } catch (e) { /* */ } }, 4000);
}

// Light sanity check that a manually reassigned file plausibly matches the role,
// so a hand-picked mismatch is flagged rather than shown as a validated green chip.
function roleFits(rk, path) {
  const b = String(path || '').toLowerCase();
  if (rk === 'UNI') return /unit1|_uni|uniden|mp2rage|_t1w/.test(b);
  if (rk === 'INV1') return /inv-?1/.test(b) || /_mp2rage/.test(b);
  if (rk === 'INV2') return /inv-?2/.test(b) || /_mp2rage/.test(b);
  if (rk === 'B1SOURCE') return /tb1tfl|tb1srge|tb1map|rb1cor|b1|fmap|sa2rage/.test(b);
  return true;
}

function bidsDownload(ses) {
  if (!ses._dlUrl) return;
  const a = document.createElement('a'); a.href = ses._dlUrl; a.download = ses._dlName; a.style.display = 'none';
  document.body.appendChild(a); a.click(); a.remove();
  ses._downloaded = true;
}

async function bidsRunComplete(task) {
  const ses = bidsCurrent; if (!ses) return;
  ses._state = 'done'; updateBidsStatus(ses);
  const key = task === 'denoise' ? 'unic' : task === 'b1only' ? 'b1' : 't1';
  const o = outputs[key];
  if (o) {
    const fname = bidsOutName(ses, task);
    const gz = await writeNiftiGz(o.data, o.dims, o.affine);
    if (ses._dlUrl) { try { URL.revokeObjectURL(ses._dlUrl); } catch (e) { /* */ } }
    ses._dlUrl = URL.createObjectURL(new Blob([gz], { type: 'application/gzip' }));
    ses._dlName = fname; ses._downloaded = false;
    if ($('#bidsAutoDl')?.checked) { bidsDownload(ses); log(`BIDS: ${entryLabel(ses)} → downloaded ${fname}`); }
    else log(`BIDS: ${entryLabel(ses)} done → ${fname}. Review it, then download it (⬇ on the row) before the next session.`);
  }
  updateBidsActions(ses);
  $('#viewerWrap').scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function viewBidsResult(ses) {
  if (bidsCurrent !== ses || (!outputs.t1 && !outputs.unic)) { log('BIDS: result no longer in memory, Recalculate to view.'); return; }
  $('#viewerWrap').style.display = 'block';
  showView($('#viewSel').value);
  $('#viewerWrap').scrollIntoView({ behavior: 'smooth', block: 'start' });
}

// Free the (idle) worker's WASM heap, the big ~GB allocation, between subjects.
function freeWorker() { if (worker && !running) { try { worker.terminate(); } catch (e) { /* */ } worker = null; } }

// Save the output (if not already) and free ALL of this session's memory.
function downloadUnloadBids(ses) {
  const had = !!ses._dlUrl;
  bidsDownload(ses);
  if (ses._dlUrl) { if (had) deferRevoke(ses._dlUrl); ses._dlUrl = null; } // saved; free the blob after the download task grabs it
  clearOutputs(); state.files = []; state.jsons = []; lastViews = null;
  revokeDownloadUrls();
  bidsShowPlaceholder();
  freeWorker();
  if (ses._el) ses._el.classList.remove('current');
  if (bidsCurrent === ses) bidsCurrent = null;
  ses._state = 'unloaded'; updateBidsStatus(ses); updateBidsActions(ses);
  log(`BIDS: ${entryLabel(ses)} saved and unloaded, memory freed.`);
}

// Calculate the next unprocessed runnable session (sequential batch, one click each).
function calculateNextBidsEntry() {
  if (!bidsIndex) { log('BIDS: no dataset loaded.'); return; }
  if (running) { log('BIDS: a run is in progress, wait for it or Stop.'); return; }
  const list = bidsIndex._flat;
  const start = bidsCurrent ? list.indexOf(bidsCurrent) + 1 : 0;
  for (let n = 0; n < list.length; n++) {
    const s = list[(start + n) % list.length];
    if ((s.runnable.t1 || s.runnable.b1only || s.runnable.denoise) && s._state !== 'done' && s._state !== 'unloaded') {
      if (s._el) { const d = s._el.closest('details'); if (d) d.open = true; }
      calculateBidsEntry(s);
      return;
    }
  }
  log('BIDS: all runnable sessions are processed. 🎉');
}

refreshRunState();
log('Ready. Drop files or DICOM folders, pick a task, and Compute. All image processing runs locally, your images never leave the tab.');
