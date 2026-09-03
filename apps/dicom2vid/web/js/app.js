// MRI2VID controller. Runs entirely on the client: ingest files, group DICOM
// series, read the selected volume, window and preview it, and encode a video.
// No network requests are made for image data.

import { collectFromDrop, collectFromPicker, readPrefix } from './ingest.js';
import {
  detectKind, sniffDicom, readDicomSeries, readDicomHeader, readNifti, readMgz,
} from './readers/index.js';
import { groupSeries } from './series.js';
import { ORIENTATIONS } from './volume.js';
import {
  orientationGeometry, resolveSliceIndices, extractFrame, normalizeParams,
  colorNormalizeParams, rotateFrame, resizeFrame, histogramBins,
} from './pipeline.js';
import { volumeToNifti } from './nifti_write.js';
import { encodeVideo, probeEncoders } from './encode.js';
import { drawFrame, drawAnnotation, sliceLabel } from './annotate.js';
import { Niivue } from './vendor/niivue.js';

const $ = (id) => document.getElementById(id);
const round4 = (x) => Math.round(x * 10000) / 10000;

const S = {
  sources: [],
  selectedId: null,
  volume: null,
  dataNorm: null,
  colorNorm: null,
  hist: null,
  win: { min: 0, max: 1, lo: 0, hi: 1 },
  rotate: 0,
  scaleX: 1,
  scaleY: 1,
  preview: { sliceIndices: [], total: 0, idx: 0 },
  playTimer: null,
  running: false,
  stopFlag: false,
  resultUrl: null,
  nv: null,
  nvUrl: null,
};

// Monotonic load token: only the newest folder drop / series selection commits.
let loadGen = 0;

// ---- utilities ----
function setStatus(msg, isErr = false) {
  const el = $('status');
  el.textContent = msg || '';
  el.classList.toggle('err', !!isErr);
}
function setProgress(p) {
  $('progressWrap').classList.toggle('hidden', p <= 0 || p >= 1);
  $('progressBar').style.width = `${Math.round(p * 100)}%`;
}
function parseIntOrNull(v) {
  const s = String(v).trim();
  if (s === '') return null;
  const n = parseInt(s, 10);
  return Number.isFinite(n) ? n : null;
}
function baseName(name) {
  return String(name).replace(/\.(dcm|ima|nii\.gz|nii|mgz|mgh)$/i, '').replace(/[^\w.-]+/g, '_') || 'video';
}

// ---- ingest ----
async function handleFiles(fileRecs) {
  if (!fileRecs || fileRecs.length === 0) return;
  const gen = ++loadGen;
  setStatus('Reading files...');
  stopPlay();

  const dicomFiles = [];
  const volumeFiles = [];
  for (const rec of fileRecs) {
    const kind = detectKind(rec.name);
    if (kind === 'dicom') dicomFiles.push(rec);
    else if (kind === 'nifti' || kind === 'mgz') volumeFiles.push({ rec, kind });
    else {
      try {
        const prefix = await readPrefix(rec.file, 200);
        if (sniffDicom(new Uint8Array(prefix))) dicomFiles.push(rec);
      } catch (_) { /* ignore unreadable */ }
    }
  }

  const sources = [];
  if (dicomFiles.length) {
    const headers = [];
    const byName = new Map();
    for (const rec of dicomFiles) {
      try {
        const prefix = await readPrefix(rec.file);
        const h = readDicomHeader(prefix, rec.name);
        if (!h.rows || !h.cols) continue; // skip DICOMDIR / non-image DICOM
        headers.push(h);
        byName.set(rec.name, rec);
      } catch (_) { /* skip unreadable/compressed at grouping time */ }
    }
    if (headers.length) {
      const { series, defaultIndex } = groupSeries(headers);
      series.forEach((s, i) => {
        sources.push({
          id: `dicom-${i}`,
          kind: 'dicom-series',
          label: s.seriesDescription || `Series ${s.seriesNumber ?? i + 1}`,
          classification: s.classification,
          sliceCount: s.sliceCount,
          isColor: s.isColor,
          isMosaic: s.isMosaic,
          mosaicSlices: s.mosaicSlices,
          volumes: s.volumes,
          recs: s.files.map((n) => byName.get(n)).filter(Boolean),
          isDefault: i === defaultIndex,
        });
      });
    }
  }
  for (let i = 0; i < volumeFiles.length; i++) {
    const { rec, kind } = volumeFiles[i];
    sources.push({ id: `vol-${i}`, kind, label: rec.name, recs: [rec] });
  }

  if (!sources.length) { setStatus('No readable DICOM, NIfTI, or MGZ files found.', true); return; }
  if (gen !== loadGen) return;

  S.sources = sources;
  renderSeries(sources);
  const def = sources.find((s) => s.isDefault) || sources[0];
  await selectSource(def.id);
}

// ---- series panel ----
function renderSeries(sources) {
  const panel = $('seriesPanel');
  const list = $('seriesList');
  list.textContent = '';
  if (sources.length <= 1) { panel.classList.add('hidden'); return; }
  panel.classList.remove('hidden');

  for (const src of sources) {
    const item = document.createElement('label');
    item.className = 'series-item';
    item.dataset.id = src.id;

    const radio = document.createElement('input');
    radio.type = 'radio';
    radio.name = 'series';
    radio.value = src.id;
    radio.addEventListener('change', () => selectSource(src.id));
    item.appendChild(radio);

    const meta = document.createElement('div');
    meta.className = 'series-meta';
    const title = document.createElement('div');
    title.className = 'series-title';
    title.textContent = src.label;
    meta.appendChild(title);

    const sub = document.createElement('div');
    const chips = [];
    if (src.classification) chips.push(src.classification.label);
    if (src.kind !== 'dicom-series') chips.push(src.kind);
    if (src.sliceCount) chips.push(`${src.sliceCount} slices`);
    if (src.isMosaic && src.volumes > 1) chips.push(`${src.volumes} volumes`);
    for (const c of chips) {
      const chip = document.createElement('span');
      chip.className = `chip ${/^(t1|color)$/.test(c) ? c : ''}`;
      chip.textContent = c;
      sub.appendChild(chip);
      sub.appendChild(document.createTextNode(' '));
    }
    meta.appendChild(sub);
    item.appendChild(meta);
    list.appendChild(item);
  }
}

function markSelected(id) {
  for (const item of document.querySelectorAll('.series-item')) {
    const on = item.dataset.id === id;
    item.classList.toggle('selected', on);
    const radio = item.querySelector('input');
    if (radio) radio.checked = on;
  }
}

// ---- load a source into a Volume ----
async function selectSource(id) {
  const src = S.sources.find((s) => s.id === id);
  if (!src) return;
  S.selectedId = id;
  S.selectedSource = src;
  markSelected(id);
  syncMosaicControls(src);
  const gen = ++loadGen;
  setStatus('Loading volume...');
  stopPlay();

  try {
    let volume;
    if (src.kind === 'dicom-series') {
      const files = [];
      for (const rec of src.recs) files.push({ name: rec.name, buffer: await rec.file.arrayBuffer() });
      volume = readDicomSeries(files, { mosaicReduce: $('mosaicReduce').value });
    } else if (src.kind === 'nifti') {
      volume = await readNifti(await src.recs[0].file.arrayBuffer(), src.label);
    } else if (src.kind === 'mgz') {
      volume = await readMgz(await src.recs[0].file.arrayBuffer(), src.label);
    }
    if (gen !== loadGen) return;
    S.volume = volume;
    S.volumeBase = baseName(src.label);
    onVolumeLoaded(gen);
    setStatus('');
  } catch (e) {
    if (gen === loadGen) setStatus(`Could not load: ${e.message}`, true);
  }
}

// The 4D control only makes sense for a mosaic series with more than one volume.
function syncMosaicControls(src) {
  const row = $('mosaicRow');
  const on = !!(src && src.isMosaic && src.volumes > 1);
  row.classList.toggle('hidden', !on);
  if (on) {
    $('mosaicNote').textContent =
      `Siemens mosaic: ${src.volumes} volumes of ${src.mosaicSlices} slices. `
      + 'Only the collapsed volume is held in memory.';
  }
}

function onVolumeLoaded(gen = loadGen) {
  const vol = S.volume;
  S.dataNorm = vol.channels === 1 ? normalizeParams(vol) : null;
  S.colorNorm = null;
  S.rotate = 0;
  $('rotateBtn').textContent = 'Rotate 90°';
  resetStretch();

  const sel = $('orientation');
  if (!sel.options.length) {
    for (const o of ORIENTATIONS) {
      const opt = document.createElement('option');
      opt.value = o;
      opt.textContent = o.replace('_', ' ');
      sel.appendChild(opt);
    }
    sel.value = 'sagittal';
  }

  const isColor = vol.channels === 3;
  $('colorNormRow').classList.toggle('hidden', !isColor);
  setWindowControlsVisible(!isColor);
  if (!isColor) { computeHistogram(vol); drawHistogram(); }

  $('optionsPanel').classList.remove('hidden');
  $('resultPanel').classList.add('hidden');

  loadIntoViewer(vol, gen);
  probeAndSetFormats();
  refreshRange();
}

// ---- NiiVue viewer ----
// `gen` is the load token of the volume this call is for. NiiVue setup and volume
// loading are async, so without it a slow earlier load could finish last and
// leave the viewer, and the note under it, describing the wrong volume.
async function loadIntoViewer(vol, gen = loadGen) {
  const note = $('nvNote');
  const notePrefix = vol.meta && vol.meta.note ? `${vol.meta.note}. ` : '';
  // The histogram and window controls are hidden for color volumes, so do not
  // point at them there. Set this now rather than after the await, so the note
  // always describes the volume that is actually loaded.
  const ready = vol.channels === 1
    ? `${notePrefix}Set the window with the histogram below.`
    : `${notePrefix}Color (RGB) volume. The intensity window does not apply; use "Normalize color channels" in Video options.`;
  note.textContent = ready;
  try {
    if (!S.nv) {
      S.nv = new Niivue({ backColor: [0, 0, 0, 1], show3Dcrosshair: true, isColorbar: false });
      await S.nv.attachToCanvas($('nvCanvas'));
      window.addEventListener('resize', () => { try { S.nv.resizeListener(); } catch (_) { /* ignore */ } });
    }
    if (gen !== loadGen) return;
    const buf = volumeToNifti(vol);
    if (S.nvUrl) { URL.revokeObjectURL(S.nvUrl); S.nvUrl = null; }
    const blob = new Blob([buf], { type: 'application/octet-stream' });
    const url = URL.createObjectURL(blob);
    S.nvUrl = url;
    await S.nv.loadVolumes([{ url, name: 'preview.nii' }]);
    if (gen !== loadGen) { URL.revokeObjectURL(url); if (S.nvUrl === url) S.nvUrl = null; return; }
    try { S.nv.setSliceType(S.nv.sliceTypeMultiplanar); } catch (_) { /* ignore */ }
    try { S.nv.resizeListener(); } catch (_) { /* ignore */ }
    syncNvWindow();
    setTimeout(() => { if (S.nvUrl === url) { URL.revokeObjectURL(url); S.nvUrl = null; } }, 4000);
  } catch (e) {
    if (gen === loadGen) {
      note.textContent = `${notePrefix}3D viewer unavailable in this browser (no WebGL). Windowing and preview still work.`;
    }
  }
}

function syncNvWindow() {
  try {
    const v = S.nv && S.nv.volumes && S.nv.volumes[0];
    if (v && S.volume && S.volume.channels === 1) {
      v.cal_min = S.win.lo;
      v.cal_max = S.win.hi;
      S.nv.updateGLVolume();
    }
  } catch (_) { /* ignore */ }
}

// ---- histogram windowing ----
function setWindowControlsVisible(show) {
  for (const el of [document.querySelector('.win-head'), $('hist'), document.querySelector('.win-readout')]) {
    if (el) el.classList.toggle('hidden', !show);
  }
}

function computeHistogram(vol) {
  if (vol.channels !== 1) { S.hist = null; return; }
  S.hist = histogramBins(vol, { min: S.dataNorm.min, max: S.dataNorm.max });
  S.win = { min: S.hist.min, max: S.hist.max, lo: S.hist.min, hi: S.hist.max };
}

const HIST_PAD = 6;
function histXOf(v) {
  const c = $('hist');
  const plotW = c.width - 2 * HIST_PAD;
  return HIST_PAD + (v - S.hist.min) / (S.hist.max - S.hist.min) * plotW;
}
function histValueAt(x) {
  const c = $('hist');
  const plotW = c.width - 2 * HIST_PAD;
  let v = S.hist.min + (x - HIST_PAD) / plotW * (S.hist.max - S.hist.min);
  if (v < S.hist.min) v = S.hist.min;
  if (v > S.hist.max) v = S.hist.max;
  return v;
}

function drawHistogram() {
  const c = $('hist');
  if (!c || !S.hist) return;
  const cssW = Math.max(120, Math.round(c.clientWidth || 360));
  c.width = cssW;
  c.height = 120;
  const ctx = c.getContext('2d');
  const W = c.width, H = c.height, plotH = H - 6;
  ctx.clearRect(0, 0, W, H);

  const { bins, nb, peak } = S.hist;
  const bw = (W - 2 * HIST_PAD) / nb;
  ctx.fillStyle = 'rgba(90,162,255,.35)';
  for (let i = 0; i < nb; i++) {
    // Bins above the percentile peak (the background spike) clip to full height.
    const h = Math.min(1, bins[i] / peak) * (plotH - 4);
    ctx.fillRect(HIST_PAD + i * bw, plotH - h, Math.max(1, bw - 0.5), h);
  }

  const xl = histXOf(S.win.lo);
  const xh = histXOf(S.win.hi);
  ctx.fillStyle = 'rgba(124,92,255,.12)';
  ctx.fillRect(xl, 2, xh - xl, plotH - 2);
  ctx.strokeStyle = '#5aa2ff';
  ctx.lineWidth = 2;
  ctx.fillStyle = '#5aa2ff';
  for (const x of [xl, xh]) {
    ctx.beginPath(); ctx.moveTo(x, 2); ctx.lineTo(x, plotH); ctx.stroke();
    ctx.fillRect(x - 3, plotH / 2 - 9, 6, 18);
  }

  $('winLoOut').textContent = `min ${round4(S.win.lo)}`;
  $('winHiOut').textContent = `${round4(S.win.hi)} max`;
}

let histDrag = null;
function histPointerDown(e) {
  if (!S.hist) return;
  const x = e.offsetX;
  histDrag = Math.abs(x - histXOf(S.win.lo)) <= Math.abs(x - histXOf(S.win.hi)) ? 'lo' : 'hi';
  try { $('hist').setPointerCapture(e.pointerId); } catch (_) { /* ignore */ }
  histApply(e);
}
function histApply(e) {
  if (!histDrag) return;
  const v = histValueAt(e.offsetX);
  const eps = (S.win.max - S.win.min) / 1000 || 1e-6;
  if (histDrag === 'lo') S.win.lo = Math.min(v, S.win.hi - eps);
  else S.win.hi = Math.max(v, S.win.lo + eps);
  applyWindow();
}
function applyWindow() {
  drawHistogram();
  drawScrub();
  syncNvWindow();
}
function resetWindow() {
  if (!S.hist) return;
  S.win.lo = S.win.min;
  S.win.hi = S.win.max;
  applyWindow();
}

// ---- encoder availability ----
async function probeAndSetFormats() {
  try {
    const enc = await probeEncoders(256, 256, 20);
    const fmt = $('format');
    const mp4Opt = fmt.querySelector('option[value=mp4]');
    const webmOpt = fmt.querySelector('option[value=webm]');
    if (mp4Opt) mp4Opt.disabled = !enc.mp4;
    if (webmOpt) webmOpt.disabled = !enc.webm && !enc.mediaRecorder;
    if (!enc.mp4 && (enc.webm || enc.mediaRecorder)) fmt.value = 'webm';
    if (mp4Opt) mp4Opt.textContent = enc.mp4 ? `MP4 (${enc.mp4})` : 'MP4 (not supported here)';
    if (webmOpt) webmOpt.textContent = enc.webm ? `WebM (${enc.webm})` : (enc.mediaRecorder ? 'WebM (MediaRecorder)' : 'WebM (not supported here)');
  } catch (_) { /* keep defaults */ }
}

// ---- options, frame extraction, preview ----
function currentOptions() {
  return {
    orientation: $('orientation').value || 'sagittal',
    fps: Math.min(120, Math.max(1, parseFloat($('fps').value) || 20)),
    start: parseIntOrNull($('startSlice').value),
    end: parseIntOrNull($('endSlice').value),
    step: Math.max(1, parseInt($('sliceStep').value, 10) || 1),
    annotate: $('annotate').checked,
    format: $('format').value,
    colorNormalize: $('colorNormalize').checked,
    upscale: Math.max(1, parseFloat($('upscale').value) || 1),
    interpolation: $('interpolation').value || 'bilinear',
  };
}

function currentNorm(vol, colorNormalize) {
  if (vol.channels === 1) {
    const { lo, hi } = S.win;
    if (Number.isFinite(lo) && Number.isFinite(hi) && hi > lo) {
      const scale = 255 / (hi - lo);
      return { min: lo, max: hi, scale, shift: -lo * scale };
    }
    return S.dataNorm;
  }
  if (colorNormalize) {
    if (!S.colorNorm) S.colorNorm = colorNormalizeParams(vol);
    return S.colorNorm;
  }
  return null;
}

// Extract one frame with the current normalization, rotation, stretch, and
// upscale applied. The stretch (aspect correction) and the upscale are folded
// into a single resample so the frame is only interpolated once.
function getFrame(vol, orientation, k, norm, colorNormalize, opts = currentOptions()) {
  const geo = orientationGeometry(vol.dims, orientation);
  const frame0 = extractFrame(vol, orientation, k, norm, { colorNormalize });
  let { frame, fW, fH } = rotateFrame(frame0, geo.fW, geo.fH, vol.channels, S.rotate);
  const targetW = fW * S.scaleX * opts.upscale;
  const targetH = fH * S.scaleY * opts.upscale;
  if (Math.round(targetW) !== fW || Math.round(targetH) !== fH) {
    const r = resizeFrame(frame, fW, fH, vol.channels, targetW, targetH, opts.interpolation);
    frame = r.frame; fW = r.fW; fH = r.fH;
  }
  return { frame, fW, fH, channels: vol.channels, sliceIndex: k };
}

// Report the encoded frame size for the current settings.
function updateOutputSize() {
  const el = $('outputSize');
  if (!S.volume) { el.textContent = ''; return; }
  const opts = currentOptions();
  const geo = orientationGeometry(S.volume.dims, opts.orientation);
  let w = geo.fW;
  let h = geo.fH;
  if (S.rotate % 2 === 1) { const t = w; w = h; h = t; }
  const outW = Math.max(1, Math.round(w * S.scaleX * opts.upscale));
  const outH = Math.max(1, Math.round(h * S.scaleY * opts.upscale));
  const resampled = outW !== w || outH !== h;
  el.textContent = resampled
    ? `Output frames: ${outW}x${outH} (from ${w}x${h}, ${opts.interpolation}).`
    : `Output frames: ${outW}x${outH}.`;
}

function resetStretch() {
  S.scaleX = 1;
  S.scaleY = 1;
  $('scaleX').value = '1';
  $('scaleY').value = '1';
  $('scaleXOut').textContent = '1.00x';
  $('scaleYOut').textContent = '1.00x';
}
function onStretch() {
  S.scaleX = parseFloat($('scaleX').value) || 1;
  S.scaleY = parseFloat($('scaleY').value) || 1;
  $('scaleXOut').textContent = `${S.scaleX.toFixed(2)}x`;
  $('scaleYOut').textContent = `${S.scaleY.toFixed(2)}x`;
  drawScrub();
  updateOutputSize();
}

function refreshRange() {
  if (!S.volume) return;
  const opts = currentOptions();
  const geo = orientationGeometry(S.volume.dims, opts.orientation);
  try {
    const idxs = resolveSliceIndices(geo.nFrames, opts);
    S.preview.sliceIndices = idxs;
    S.preview.total = geo.nFrames;
    S.preview.idx = Math.min(Math.max(0, S.preview.idx), idxs.length - 1);
    const slider = $('scrubSlider');
    slider.max = String(idxs.length - 1);
    slider.value = String(S.preview.idx);
    $('generate').disabled = false;
    setStatus('');
    drawScrub();
    syncReconButtons();
    updateOutputSize();
  } catch (e) {
    $('generate').disabled = true;
    setStatus(e.message, true);
  }
}

function drawScrub() {
  const vol = S.volume;
  if (!vol || !S.preview.sliceIndices.length) return;
  const opts = currentOptions();
  const geo = orientationGeometry(vol.dims, opts.orientation);
  const k = S.preview.sliceIndices[S.preview.idx];
  const norm = currentNorm(vol, opts.colorNormalize);
  const f = getFrame(vol, opts.orientation, k, norm, opts.colorNormalize, opts);
  const canvas = $('scrubCanvas');
  canvas.width = f.fW;
  canvas.height = f.fH;
  const ctx = canvas.getContext('2d');
  drawFrame(ctx, f.frame, f.fW, f.fH, vol.channels);
  if (opts.annotate) drawAnnotation(ctx, sliceLabel(k, geo.nFrames), f.fH);
  // Set the display size in JS to preserve the aspect ratio (CSS width:100% with a
  // max-height would stretch non-square frames).
  const wrap = canvas.parentElement;
  const maxW = (wrap && wrap.clientWidth) ? wrap.clientWidth - 12 : 680;
  const maxH = Math.max(120, Math.round(window.innerHeight * 0.62));
  const scale = Math.min(maxW / f.fW, maxH / f.fH);
  canvas.style.width = `${Math.max(1, Math.round(f.fW * scale))}px`;
  canvas.style.height = `${Math.max(1, Math.round(f.fH * scale))}px`;
  $('scrubLabel').textContent = `frame ${S.preview.idx + 1}/${S.preview.sliceIndices.length} (slice ${k + 1}/${geo.nFrames})`;
}

function stopPlay() {
  if (S.playTimer) { clearInterval(S.playTimer); S.playTimer = null; $('playBtn').textContent = 'Play'; }
}
function togglePlay() {
  if (S.playTimer) { stopPlay(); return; }
  if (!S.preview.sliceIndices.length) return;
  const fps = currentOptions().fps;
  $('playBtn').textContent = 'Pause';
  S.playTimer = setInterval(() => {
    S.preview.idx = (S.preview.idx + 1) % S.preview.sliceIndices.length;
    $('scrubSlider').value = String(S.preview.idx);
    drawScrub();
  }, 1000 / fps);
}

// ---- reconstruction, rotation, modals ----
function baseOf(orientation) { return orientation.replace('_flipped', ''); }
function setOrientation(value) { $('orientation').value = value; refreshRange(); }
function syncReconButtons() {
  const cur = $('orientation').value || 'sagittal';
  const base = baseOf(cur);
  for (const btn of document.querySelectorAll('.btn.ori')) {
    btn.classList.toggle('active', btn.dataset.ori === base);
  }
  $('flipOri').checked = cur.endsWith('_flipped');
}
function cycleRotate() {
  S.rotate = (S.rotate + 1) % 4;
  $('rotateBtn').textContent = S.rotate ? `Rotate 90° (${S.rotate * 90}°)` : 'Rotate 90°';
  drawScrub();
  updateOutputSize();
}
function openPreview() {
  if (!S.volume) return;
  syncReconButtons();
  $('previewModal').classList.remove('hidden');
  drawScrub();
}
function closePreview() { stopPlay(); $('previewModal').classList.add('hidden'); }

// ---- generate ----
async function generate() {
  if (S.running || !S.volume) return;
  stopPlay();
  const vol = S.volume;
  const opts = currentOptions();
  const geo = orientationGeometry(vol.dims, opts.orientation);

  let sliceIndices;
  try { sliceIndices = resolveSliceIndices(geo.nFrames, opts); }
  catch (e) { setStatus(e.message, true); return; }

  const norm = currentNorm(vol, opts.colorNormalize);
  const total = geo.nFrames;
  const frameProvider = (i) => getFrame(vol, opts.orientation, sliceIndices[i], norm, opts.colorNormalize, opts);

  S.running = true;
  S.stopFlag = false;
  $('generate').disabled = true;
  $('stop').classList.remove('hidden');
  setStatus('Encoding...');
  setProgress(0.001);

  try {
    const first = frameProvider(0);
    const res = await encodeVideo({
      nFrames: sliceIndices.length,
      fps: opts.fps,
      container: opts.format,
      frameProvider,
      annotate: opts.annotate,
      total,
      onProgress: setProgress,
      shouldStop: () => S.stopFlag,
    });
    showResult(res, opts, first, sliceIndices.length);
    setStatus('Done.');
  } catch (e) {
    if (e.stopped) setStatus('Stopped.');
    else setStatus(`Encode failed: ${e.message}`, true);
  } finally {
    S.running = false;
    $('generate').disabled = false;
    $('stop').classList.add('hidden');
    setProgress(0);
  }
}

function showResult(res, opts, firstFrame, nFrames) {
  if (S.resultUrl) { const old = S.resultUrl; setTimeout(() => URL.revokeObjectURL(old), 4000); }
  const url = URL.createObjectURL(res.blob);
  S.resultUrl = url;
  $('resultVideo').src = url;
  const link = $('downloadLink');
  link.href = url;
  link.download = `${S.volumeBase}_${opts.orientation}.${res.ext}`;
  const kb = Math.round(res.blob.size / 1024);
  $('resultInfo').textContent = `${res.codecName}, ${res.container.toUpperCase()}, ${nFrames} frames, ${firstFrame.fW}x${firstFrame.fH}, ${kb} KB.`;
  $('resultPanel').classList.remove('hidden');
}

// ---- guided tour ----
const TOUR = [
  { sel: '#dropZone', title: '1. Add your images', body:
    'Drag a <b>DICOM folder</b>, a full <b>DICOMDIR</b> export, an entire <b>BIDS</b> subject-session directory, or a single <b>.nii / .nii.gz / .mgz</b> file. Nothing is uploaded; everything is read in this tab.' },
  { sel: '#seriesPanel', title: '2. Pick a series', body:
    'A whole directory is grouped by SeriesInstanceUID and the most likely <b>structural scan</b> is selected first. Click any series to switch.', mayHide: true },
  { sel: '#viewerCard', title: '3. Window the volume', body:
    'The viewer shows the loaded volume. Drag the two handles on the <b>histogram</b> to set the intensity window; it maps to 0-255 in the output. <b>Reset windowing</b> returns to the full range.' },
  { sel: '#optionsPanel', title: '4. Set options', body:
    'Choose the <b>orientation</b>, <b>frames per second</b>, <b>slice range</b>, output <b>format</b>, and whether to overlay slice numbers. '
    + '<b>Upscale</b> enlarges the frames before encoding, which helps low-resolution scans such as EPI and B1 maps; pick the <b>interpolation</b> to suit '
    + '(nearest keeps hard voxel edges, Lanczos is sharpest). For a Siemens mosaic run (fMRI or diffusion) a <b>4D series</b> control appears, choosing whether '
    + 'the video uses the first volume, the mean, or a maximum intensity projection.' },
  { sel: '#previewBtn', title: '5. Preview and reconstruct', body:
    'Open <b>Preview</b> to see the actual frames, choose the reconstruction (<b>axial, sagittal, coronal</b>, flip), and <b>Rotate</b> the frames upright.' },
  { sel: '#generate', title: '6. Generate and download', body:
    'Encode the <b>MP4 or WebM</b> in the page and download it.' },
  { sel: '.badge', title: 'Privacy', body:
    'Your images and all processing stay in this browser tab and are never uploaded. Neurodesk hosting uses Google Analytics for page views only, sends no custom events, and makes no analytics request when Do Not Track or Global Privacy Control is enabled.' },
];
let tourStep = 0;
let tourSpotEl = null;
function tourClearSpot() { if (tourSpotEl) { tourSpotEl.classList.remove('tour-spot'); tourSpotEl = null; } }
function tourPositionPop(el) {
  const pop = $('tourPop');
  pop.style.visibility = 'hidden';
  pop.style.display = 'block';
  const pw = pop.offsetWidth;
  const ph = pop.offsetHeight;
  const m = 14;
  let top, left;
  if (el) {
    const r = el.getBoundingClientRect();
    top = r.bottom + m; left = r.left;
    if (top + ph > innerHeight - 8) top = r.top - ph - m;
    top = Math.max(8, Math.min(top, innerHeight - ph - 8));
    left = Math.max(8, Math.min(left, innerWidth - pw - 8));
  } else {
    top = Math.max(8, (innerHeight - ph) / 2);
    left = (innerWidth - pw) / 2;
  }
  pop.style.top = `${top}px`;
  pop.style.left = `${left}px`;
  pop.style.visibility = 'visible';
}
function showTourStep(i) {
  tourClearSpot();
  tourStep = Math.max(0, Math.min(TOUR.length - 1, i));
  const s = TOUR[tourStep];
  const el = document.querySelector(s.sel);
  const visible = !!(el && el.offsetParent !== null && el.getClientRects().length);
  $('tourStepNo').textContent = `Step ${tourStep + 1} of ${TOUR.length}`;
  $('tourTitle').textContent = s.title;
  $('tourBody').innerHTML = s.body + (!visible && s.mayHide ? '<br><span class="note">(this appears once you load a directory with more than one series)</span>' : '');
  $('tourBack').style.visibility = tourStep === 0 ? 'hidden' : 'visible';
  $('tourNext').textContent = tourStep === TOUR.length - 1 ? 'Done' : 'Next';
  if (visible) { el.classList.add('tour-spot'); tourSpotEl = el; el.scrollIntoView({ block: 'center' }); }
  tourPositionPop(visible ? el : null);
  $('tourNext').focus();
}
function startTour() { $('tour').classList.remove('hidden'); showTourStep(0); }
function endTour() { tourClearSpot(); $('tour').classList.add('hidden'); }

// ---- wire up ----
function init() {
  const dz = $('dropZone');
  dz.addEventListener('dragover', (e) => { e.preventDefault(); dz.classList.add('drag'); });
  dz.addEventListener('dragleave', () => dz.classList.remove('drag'));
  dz.addEventListener('drop', async (e) => {
    e.preventDefault();
    dz.classList.remove('drag');
    handleFiles(await collectFromDrop(e.dataTransfer));
  });
  $('pickDir').addEventListener('change', (e) => handleFiles(collectFromPicker(e.target.files)));
  $('pickFiles').addEventListener('change', (e) => handleFiles(collectFromPicker(e.target.files)));

  for (const id of ['orientation', 'startSlice', 'endSlice', 'sliceStep']) {
    $(id).addEventListener('change', refreshRange);
    $(id).addEventListener('input', refreshRange);
  }
  $('annotate').addEventListener('change', drawScrub);
  $('colorNormalize').addEventListener('change', () => { S.colorNorm = null; drawScrub(); });

  for (const id of ['upscale', 'interpolation']) {
    $(id).addEventListener('change', () => { drawScrub(); updateOutputSize(); });
  }
  // Changing the 4D reduction changes the volume itself, so re-read the series.
  $('mosaicReduce').addEventListener('change', () => {
    if (S.selectedId) selectSource(S.selectedId);
  });

  // Histogram windowing.
  $('hist').addEventListener('pointerdown', histPointerDown);
  $('hist').addEventListener('pointermove', histApply);
  $('hist').addEventListener('pointerup', () => { histDrag = null; });
  $('hist').addEventListener('pointercancel', () => { histDrag = null; });
  $('resetWindow').addEventListener('click', resetWindow);

  $('scrubSlider').addEventListener('input', (e) => { S.preview.idx = parseInt(e.target.value, 10) || 0; drawScrub(); });
  $('playBtn').addEventListener('click', togglePlay);
  $('generate').addEventListener('click', generate);
  $('stop').addEventListener('click', () => { S.stopFlag = true; });

  $('previewBtn').addEventListener('click', openPreview);
  $('previewClose').addEventListener('click', closePreview);
  $('rotateBtn').addEventListener('click', cycleRotate);
  $('scaleX').addEventListener('input', onStretch);
  $('scaleY').addEventListener('input', onStretch);
  $('resetScale').addEventListener('click', () => { $('scaleX').value = '1'; $('scaleY').value = '1'; onStretch(); });
  for (const btn of document.querySelectorAll('.btn.ori')) {
    btn.addEventListener('click', () => {
      const flip = $('flipOri').checked;
      setOrientation(flip ? `${btn.dataset.ori}_flipped` : btn.dataset.ori);
    });
  }
  $('flipOri').addEventListener('change', () => {
    const base = baseOf($('orientation').value || 'sagittal');
    setOrientation($('flipOri').checked ? `${base}_flipped` : base);
  });
  $('previewModal').addEventListener('click', (e) => { if (e.target === $('previewModal')) closePreview(); });

  // Tour.
  $('tutorialBtn').addEventListener('click', startTour);
  $('tourNext').addEventListener('click', () => { tourStep === TOUR.length - 1 ? endTour() : showTourStep(tourStep + 1); });
  $('tourBack').addEventListener('click', () => showTourStep(tourStep - 1));
  $('tourSkip').addEventListener('click', endTour);
  window.addEventListener('resize', () => {
    if (!$('tour').classList.contains('hidden')) tourPositionPop(tourSpotEl);
    if (S.volume && S.volume.channels === 1) drawHistogram();
    drawScrub();
  });
  document.addEventListener('keydown', (e) => {
    if (!$('tour').classList.contains('hidden')) {
      if (e.key === 'Escape') endTour();
      else if (e.key === 'ArrowRight') { tourStep === TOUR.length - 1 ? endTour() : showTourStep(tourStep + 1); }
      else if (e.key === 'ArrowLeft') showTourStep(tourStep - 1);
      return;
    }
    if (e.key === 'Escape') closePreview();
  });
}

init();
