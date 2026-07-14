/**
 * BrowserQC — browser-only MRI quality control. No data leaves the machine.
 *
 * Drop a NIfTI (or a DICOM folder → dcm2niix) and it runs automatically: conform to
 * the model's canonical space, run the brainchop "Subcortical + GWM" parcellation
 * (TensorFlow.js), back-project the labels onto the native scan as a colour overlay,
 * then compute niimath MRIQC-style quality metrics into the side panel. Everything
 * runs in WebAssembly + WebGPU/WebGL2 locally.
 */

import NiiVueGPU, {
  type ColorMap,
  type ImageFromUrlOptions,
  MULTIPLANAR_TYPE,
  SHOW_RENDER,
  SLICE_TYPE,
} from '@niivue/niivue'
import { mountImagingWorkspace } from '@neurodesk/webapp-components/core/mount-imaging-workspace'
import '@neurodesk/webapp-components/styles/base.css'
import { runDcm2niix, traverseDataTransferItems } from './dcm2niix/index'
import { Niimath } from './niimath'
import { CSF_LABELS, WM_LABELS, parseQcTsv, renderQc } from './qc'

const ASSET_BASE_URL =
  'https://huggingface.co/datasets/sbollmann/neurodesk-webapps-assets/resolve/3fac5b45eb5cd38190a49ad3a1dc422b016bc938/browserqc/'
const T1_URL = `${ASSET_BASE_URL}t1_crop.nii.gz`

mountImagingWorkspace({
  controls: '#qcPanel',
  viewer: '#canvas-container',
  status: 'body > footer',
  title: 'BrowserQC',
  subtitle: 'Automated MRI quality control in your browser',
  mark: 'Q',
})

function $<T extends HTMLElement>(id: string): T {
  const el = document.getElementById(id)
  if (!el) throw new Error(`Element #${id} not found`)
  return el as T
}

// --- DOM handles ---
const locationEl = $('location')
const loadingCircle = $('loadingCircle')
const statusMsg = $<HTMLLabelElement>('statusMsg')
const aboutBtn = $<HTMLButtonElement>('aboutBtn')
const aboutDialog = $<HTMLDialogElement>('aboutDialog')
const dicomPick = $<HTMLSelectElement>('dicomPick')
const ovlSlider = $<HTMLInputElement>('ovlSlider')
const qcBody = $('qcBody')

// --- NiiVue setup ---
// The NiiVue constructor is GPU-free; attachTo() acquires the WebGPU device and
// throws on a browser without it. So construct here but defer attachTo to init(),
// AFTER the navigator.gpu guard, or a no-WebGPU browser gets an unhandled
// top-level rejection instead of the friendly "needs WebGPU" message.
const nv = new NiiVueGPU({ isDragDropEnabled: false, backgroundColor: [0, 0, 0, 1] })
type ExtCtx = ReturnType<typeof nv.createExtensionContext>
let ctx: ExtCtx | null = null

async function attachNiiVue(): Promise<void> {
  await nv.attachTo('gl1')
  nv.multiplanarType = MULTIPLANAR_TYPE.GRID
  nv.sliceType = SLICE_TYPE.MULTIPLANAR
  nv.showRender = SHOW_RENDER.ALWAYS
  nv.crosshairGap = 5
  nv.isLegendVisible = false
  ctx = nv.createExtensionContext()
  ctx.on('locationChange', (e) => {
    locationEl.textContent = e.detail.string
  })
}

// --- App state ---
let isCleanedUp = false
// True while runSegment is mid-flight mutating the NiiVue scene (loadVolumes →
// addVolume → setColormapLabel). The opacity slider must not re-enter NiiVue during
// that window, so its handler no-ops while busy — see the #ovlSlider listener.
let busy = false

// niimath is used only for the QC metrics (`--qc`); lazily initialised on first QC.
const niimath = new Niimath()
let niimathReady: Promise<void> | null = null
niimath.setOutputDataType('input')

const listeners = new AbortController()
const ac = { signal: listeners.signal }

// Bound worker-backed steps (conform, niimath init + run). A worker that spawns but
// never posts back (no message, no onerror) never settles its promise, so the
// single-flight `pending` chain never advances and the app wedges (spinner stuck)
// until reload. A timeout rejects instead so the queue moves on. Generous — these
// finish in seconds; this only fires on a genuine stall.
const WORKER_TIMEOUT_MS = 60_000
function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms} ms`)), ms)
    p.then(
      (v) => { clearTimeout(timer); resolve(v) },
      (e) => { clearTimeout(timer); reject(e) },
    )
  })
}

// The vendored niimath wrapper exposes no public accessor for its Web Worker, so we
// reach the private field (verified named `worker`, src/niimath/index.js) for the raw
// --qc post, worker recovery, and teardown. Centralised here so a wrapper rename
// fails in ONE place — ensureNiimath() asserts the handle is real after init(), so a
// bump fails loudly at the seam instead of silently disabling QC + leaking the worker.
function niimathWorker(): Worker | null {
  return (niimath as unknown as { worker?: Worker | null }).worker ?? null
}
function killNiimathWorker(): void {
  try {
    niimathWorker()?.terminate()
    ;(niimath as unknown as { worker: Worker | null }).worker = null
  } catch {
    // worker may already be gone
  }
}

// --- Status helpers ---
function setStatus(msg: string): void {
  statusMsg.textContent = msg
  // The footer cell ellipsizes; expose the full text (esp. long failures) on hover.
  statusMsg.title = msg
  statusMsg.classList.toggle('hidden', msg === '')
}
function spin(on: boolean): void {
  // Toggle visibility (not display) so the spinner's box stays reserved and the
  // status bar height never changes — see .loading-circle in style.css.
  loadingCircle.style.visibility = on ? 'visible' : 'hidden'
}

// --- Serial task queue (load / drop / segment must not overlap) ---
let pending: Promise<unknown> = Promise.resolve()
function enqueue(fn: () => Promise<unknown>): void {
  if (isCleanedUp) return
  pending = pending
    // Re-check at execution time, not just enqueue time: a job queued before
    // cleanup() (HMR/tab-close) must not run on the destroyed NiiVue afterwards.
    .then(() => (isCleanedUp ? undefined : fn()))
    .catch((err: unknown) => {
      const msg = err instanceof Error ? err.message : String(err)
      setStatus(`Failed: ${msg}`)
      console.error('task failed', err)
    })
}

async function ensureNiimath(): Promise<void> {
  if (!niimathReady)
    niimathReady = niimath.init().then(() => {
      if (!(niimathWorker() instanceof Worker))
        throw new Error('niimath worker handle missing after init (vendored wrapper changed?)')
    })
  await withTimeout(niimathReady, WORKER_TIMEOUT_MS, 'niimath init')
}

// If a niimath run fails, its worker + init promise may be in a bad state; tear both
// down so the next QC spins up a fresh worker. (The vendored wrapper exposes no public
// terminate — killNiimathWorker reaches the private field for us.)
function resetNiimathWorker(): void {
  killNiimathWorker()
  niimathReady = null
}

async function fetchFile(url: string, name: string): Promise<File> {
  const res = await fetch(url)
  if (!res.ok) throw new Error(`fetch ${name} failed: ${res.status}`)
  return new File([await res.blob()], name)
}

// --- Segmentation ("Subcortical + GWM", brainchop tfjs) ---
// Runs automatically on every loaded image. Conforms a copy to 256³ 1 mm, runs the
// deep-learning parcellation, back-projects the labels onto the native input grid
// (so the overlay sits on the ORIGINAL scan), colours them, then runs QC. tfjs + the
// model chunk are dynamically import()ed on first use.
let conformRegistered = false

async function ensureConformTransform(): Promise<void> {
  if (conformRegistered) return
  // FastSurfer-style conform (256³ 1 mm) as a NiiVue volume transform — our rc.9
  // NiiVue has no nv.conform(), so we register the ext's worker-backed transform.
  const { conform } = await import('@niivue/nv-ext-image-processing')
  nv.registerVolumeTransform(conform)
  conformRegistered = true
}

// colormap.json ({R,G,B,labels}) → NiiVue ColorMap. rc.9 also needs I (label value
// per entry) and A (alpha) — background label 0 transparent, the rest opaque.
function toColorMap(c: { R: number[]; G: number[]; B: number[]; labels?: string[] }): ColorMap {
  const n = c.R.length
  return {
    R: c.R,
    G: c.G,
    B: c.B,
    I: Array.from({ length: n }, (_, i) => i),
    A: Array.from({ length: n }, (_, i) => (i === 0 ? 0 : 255)),
    labels: c.labels,
  }
}

// Post a raw `--qc` job straight to the niimath worker. The wrapper's chain run()
// only models image→ops→image; --qc takes its own argv and writes a TSV, so we drive
// the worker directly (it stages `blob`+`extraFiles` into MEMFS, runs `cmd`, reads
// `outName` back). The app's single-flight queue guarantees no niimath run overlaps
// this one-shot handler swap.
function runNiimathQc(t1: File, seg: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const worker = niimathWorker()
    if (!worker) {
      reject(new Error('niimath worker unavailable'))
      return
    }
    worker.onmessage = (e: MessageEvent) => {
      const d = e.data
      if (d?.type === 'error') {
        reject(new Error(d.message))
        return
      }
      if (d && 'blob' in d) void (d.blob as Blob).text().then(resolve, reject)
    }
    worker.postMessage({
      blob: t1, // staged in MEMFS under t1.name
      extraFiles: [{ name: seg.name, data: seg }],
      cmd: [
        '--qc', t1.name, '--seg', seg.name,
        '--csf', CSF_LABELS.join(','), '--wm', WM_LABELS.join(','),
        '--out', 'qc.tsv',
      ],
      outName: 'qc.tsv',
    })
  })
}

// MRIQC-style QC on the native input + the native-space segmentation. The T1 is
// serialized straight from NiiVue (volumes[0]) so it shares the exact grid of the
// segmentation we built from that same volume — `--qc` requires identical geometry.
async function computeQc(segBytes: Uint8Array): Promise<void> {
  await ensureNiimath()
  const t1 = await nv.saveVolume({ volumeByIndex: 0, filename: '' })
  if (!(t1 instanceof Uint8Array)) throw new Error('could not serialize the input volume')
  const tsv = await withTimeout(
    // Both inputs are uncompressed .nii (saveVolume with an empty filename does not
    // gzip; writeNifti emits raw) — no gunzip cost, and `--qc` writes a TSV so output
    // gz never applies. Name matches content so niimath doesn't attempt a gunzip.
    runNiimathQc(new File([t1], 'qc_t1.nii'), new File([segBytes], 'qc_seg.nii')),
    WORKER_TIMEOUT_MS,
    'niimath --qc',
  )
  renderQc(qcBody, parseQcTsv(tsv))
}

// Load `file` as the displayed volume, segment it, and QC the result.
async function runSegment(file: File): Promise<void> {
  if (isCleanedUp) return // a job queued before cleanup() (HMR) must not touch a dead nv
  spin(true)
  busy = true
  renderQc(qcBody, null) // clear any prior QC while we recompute
  const t0 = performance.now()
  try {
    await ensureConformTransform()
    setStatus(`Loading ${file.name}…`)
    await nv.loadVolumes([{ url: file, name: file.name } as ImageFromUrlOptions])
    if (isCleanedUp) return
    const nativeVol = nv.volumes[0]

    // Conform to the model's canonical 256³ 1 mm space.
    setStatus('Conforming input (256³ 1 mm)…')
    const conf = await withTimeout(nv.volumeTransform.conform(nativeVol), WORKER_TIMEOUT_MS, 'conform')
    if (isCleanedUp || !conf.img) return

    setStatus('Segmenting (Subcortical + GWM)… first run downloads the model')
    const { segment, segColormapUrl } = await import('./brainchop/segment')
    const rootURL = ASSET_BASE_URL.replace(/\/$/, '')
    const labels = await segment(
      { dims: conf.hdr.dims, datatypeCode: conf.hdr.datatypeCode },
      conf.img,
      rootURL,
      (m) => setStatus(m),
    )
    if (isCleanedUp) return

    // Back-project conformed labels onto the native grid (input resolution).
    setStatus('Back-projecting to native space…')
    const { resliceToNative } = await import('./brainchop/reslice')
    const nativeLabels = resliceToNative(
      { dims: nativeVol.hdr.dims, affine: nativeVol.hdr.affine },
      { dims: conf.hdr.dims, affine: conf.hdr.affine },
      labels,
    )
    const { writeNifti, INTENT_LABEL } = await import('./brainchop/nifti')
    const bytes = writeNifti(
      { dims: nativeVol.hdr.dims, pixDims: nativeVol.hdr.pixDims, affine: nativeVol.hdr.affine },
      nativeLabels,
      INTENT_LABEL,
    )
    if (isCleanedUp) return // teardown may have run during the reslice/nifti imports
    await nv.addVolume({
      url: new File([bytes], 'segmentation.nii'),
      name: 'segmentation.nii',
      opacity: Number(ovlSlider.value) / 255,
    } as ImageFromUrlOptions)
    if (isCleanedUp) return

    const cmapRes = await fetch(segColormapUrl(rootURL))
    if (!cmapRes.ok) throw new Error(`fetch colormap failed: ${cmapRes.status}`)
    const cmap = await cmapRes.json()
    await nv.setColormapLabel(nv.volumes.length - 1, toColorMap(cmap))
    // Scene mutation is done. Apply the latest slider value first — a drag during the
    // locked window updated the control but the handler dropped it, so `addVolume`'s
    // sampled opacity may be stale — then release the lock so subsequent drags land
    // during the (scene-untouching) QC run below. `finally` still clears it if we
    // bailed earlier.
    void nv.setVolume(nv.volumes.length - 1, { opacity: Number(ovlSlider.value) / 255 })
    busy = false

    // QC on the result. Non-fatal: a QC failure must not discard the segmentation
    // display — reset the worker, surface it in the status bar, leave the panel empty.
    try {
      setStatus('Computing image-quality metrics (niimath)…')
      await computeQc(bytes)
      if (isCleanedUp) return
      setStatus(`Segmentation + QC complete (${Math.round(performance.now() - t0)} ms)`)
    } catch (err) {
      console.warn('QC failed', err)
      resetNiimathWorker()
      renderQc(qcBody, null)
      setStatus(`Segmented — QC unavailable: ${err instanceof Error ? err.message : String(err)}`)
    }
  } finally {
    busy = false
    spin(false)
  }
}

// --- DICOM / file drag-drop ---
let dcmConverted: File[] = []
const DIRECT_VOLUME_RE = /\.(nii|nii\.gz|mgh|mgz|nrrd|mha|mhd|nhdr|head|v)$/i

async function handleDrop(filesPromise: Promise<File[]>): Promise<void> {
  if (isCleanedUp) return
  spin(true)
  try {
    setStatus('Reading dropped files…')
    const files = await filesPromise
    if (files.length === 0) {
      setStatus('Drop contained no readable files.')
      return
    }
    // Fast-path a single obvious volume file straight to segmentation.
    if (files.length === 1 && DIRECT_VOLUME_RE.test(files[0].name)) {
      await runSegment(files[0])
      return
    }
    setStatus(`Converting ${files.length} file(s) with dcm2niix…`)
    const t0 = performance.now()
    const niftiFiles = await runDcm2niix(files)
    const ms = Math.round(performance.now() - t0)
    if (niftiFiles.length === 0) {
      setStatus('No NIfTI output produced. Are these DICOM images?')
      return
    }
    if (niftiFiles.length > 1) {
      dcmConverted = niftiFiles
      dicomPick.replaceChildren()
      niftiFiles.forEach((f, i) => {
        const opt = document.createElement('option')
        opt.value = String(i)
        opt.text = f.name
        dicomPick.appendChild(opt)
      })
      dicomPick.value = '0'
      dicomPick.classList.remove('hidden')
      setStatus(`dcm2niix: ${niftiFiles.length} NIfTI in ${ms} ms — pick one.`)
    }
    await runSegment(niftiFiles[0])
  } finally {
    spin(false)
  }
}

// --- Init ---
async function init(): Promise<void> {
  // NiiVue's attachTo() acquires a WebGPU device and throws without one. But
  // navigator.gpu can exist while requestAdapter() returns null, device creation
  // fails, or the GPU is blocklisted — so guard the fast case AND catch attachTo()
  // failures, giving a friendly message instead of an unhandled console.error in
  // every WebGPU-unavailable path.
  const noWebGpu =
    'This browser/GPU can’t initialize WebGPU — BrowserQC needs a recent desktop Chrome, Edge, or Safari.'
  if (!navigator.gpu) {
    setStatus(noWebGpu)
    return
  }
  try {
    await attachNiiVue()
  } catch (err) {
    // Almost always genuine WebGPU unavailability; warn (not error, so the smoke's
    // console.error gate stays meaningful) so a non-WebGPU init bug isn't silently
    // mislabeled.
    console.warn('BrowserQC: WebGPU init failed', err)
    setStatus(noWebGpu)
    return
  }
  // Load + segment the bundled default subject.
  const t1 = await fetchFile(T1_URL, 't1_crop.nii.gz')
  await runSegment(t1)
}

// --- Wiring ---
document.addEventListener('dragover', (e) => e.preventDefault(), ac)
document.addEventListener(
  'drop',
  (e) => {
    e.preventDefault()
    const items = e.dataTransfer?.items
    if (!items || items.length === 0) return
    // Invalidate the previous DICOM selection synchronously. If the queue is busy,
    // leaving it active until handleDrop() starts lets an old selection enqueue after
    // this newer drop and replace the image the user just requested.
    dcmConverted = []
    dicomPick.classList.add('hidden')
    // A DataTransferItemList is only valid during this event; start traversal now.
    const filesPromise = traverseDataTransferItems(items)
    filesPromise.catch(() => {})
    enqueue(() => handleDrop(filesPromise))
  },
  ac,
)
dicomPick.addEventListener(
  'change',
  () => {
    const file = dcmConverted[Number(dicomPick.value)]
    if (file) enqueue(() => runSegment(file))
  },
  ac,
)
aboutBtn.addEventListener('click', () => aboutDialog.showModal(), ac)
// Overlay opacity — drives the segmentation overlay (last volume) when present.
ovlSlider.addEventListener(
  'input',
  () => {
    // Skip while a segmentation is mid-flight — mutating the scene between its
    // loadVolumes/addVolume awaits can hit the wrong volume or throw. The final
    // opacity is applied via addVolume's `opacity` when the overlay lands.
    if (!busy && nv.volumes.length > 1)
      void nv.setVolume(nv.volumes.length - 1, { opacity: Number(ovlSlider.value) / 255 })
  },
  ac,
)

// --- Cleanup (HMR / tab close) ---
async function cleanup(): Promise<void> {
  if (isCleanedUp) return
  isCleanedUp = true
  listeners.abort()
  // Terminate the niimath worker FIRST (don't await `pending`): a WASM run is one
  // uninterruptible call, so awaiting the queue would stall teardown. The terminated
  // run never resolves; any run that already resolved hits `if (isCleanedUp) return`
  // before touching nv/ctx.
  killNiimathWorker()
  try {
    ctx?.dispose() // null if WebGPU was unavailable (attachNiiVue never ran)
  } catch {
    // best-effort — must not skip nv.destroy() below
  }
  nv.destroy()
}
window.addEventListener('pagehide', (e) => {
  if (e.persisted) return
  void cleanup()
}, { once: true, signal: listeners.signal })
if (import.meta.hot) import.meta.hot.dispose(cleanup)

enqueue(init)
