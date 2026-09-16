/**
 * BrowserQC — browser-only MRI quality control. No data leaves the machine.
 *
 * Drop a NIfTI (or a DICOM folder → dcm2niix) and it runs automatically: run the
 * MindGrab "Subcortical + GWM" parcellation on the native grid as a colour overlay,
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
import { bindFileDrop, createInfoDialog, renderConsole, renderExampleSelector } from '@neurodesk/webapp-components/ui'
import '@neurodesk/webapp-components/styles/imaging-workspace.css'
import { readImageFiles, traverseDataTransferItems } from '@neurodesk/runtime-support/dcm2niix-client'
import { Niimath } from '@niivue/niimath'
import { CSF_LABELS, WM_LABELS, bindSidecar, readQcReport, renderQc } from './qc'
import type { QcMetrics, QcReport } from './qc'
import examples from '../examples.json'

const ASSET_BASE_URL = 'https://huggingface.co/datasets/neurodeskorg/webapps/resolve/12eb1069c34097b7c0881b22e1f7e4ed953aa5cc/browserqc/'
const TEMPLATE_URL = `${ASSET_BASE_URL}avg152T1.nii.gz`

mountImagingWorkspace({
  controls: '#qcPanel',
  viewer: '#canvas-container',
  status: '#status',
  title: 'BrowserQC',
  subtitle: 'Automated MRI quality control in your browser',
  mark: 'Q',
  controlsContract: { about: '#aboutBtn', privacy: '#privacyBtn' },
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
const aboutDialog = createInfoDialog({ id: 'aboutDialog' })
const privacyBtn = $<HTMLButtonElement>('privacyBtn')
const privacyDialog = createInfoDialog({ id: 'privacyDialog' })
const saveBtn = $<HTMLButtonElement>('saveBtn')
const dicomPick = $<HTMLSelectElement>('dicomPick')
const niftiInput = $<HTMLInputElement>('niftiInput')
const dicomInput = $<HTMLInputElement>('dicomInput')
const ovlSlider = $<HTMLInputElement>('ovlSlider')
const qcBody = $('qcBody')
const technicalLog = renderConsole({ outputId: 'consoleOutput', copyId: 'copyLogBtn', clearId: 'clearLogBtn' })
$('canvas-container').appendChild(technicalLog.root)

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
let lastReport: QcReport | null = null
let lastName = 'image'
let bidsMeta: unknown = null
let stagedSidecar: unknown = null

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

// The runtime-support niimath wrapper exposes no public worker accessor. The
// raw --qc path still needs that worker for compatibility, so keep the private
// lookup in one place and assert it after init().
function niimathWorker(): Worker | null {
  return (niimath as unknown as { worker?: Worker | null }).worker ?? null
}
// --- Status helpers ---
function setStatus(msg: string): void {
  statusMsg.textContent = msg
  // The footer cell ellipsizes; expose the full text (esp. long failures) on hover.
  statusMsg.title = msg
  statusMsg.classList.toggle('hidden', msg === '')
  if (msg) technicalLog.log(msg)
}
function spin(on: boolean): void {
  if (on) loadingCircle.removeAttribute('value')
  else loadingCircle.setAttribute('value', '0')
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
        throw new Error('niimath worker handle missing after init (wrapper changed?)')
    })
  await withTimeout(niimathReady, WORKER_TIMEOUT_MS, 'niimath init')
}

// If a niimath run fails, its worker + init promise may be in a bad state; tear both
function resetNiimathWorker(): void {
  niimath.dispose('niimath worker reset')
  niimathReady = null
}

async function fetchFile(url: string, name: string): Promise<File> {
  const res = await fetch(url)
  if (!res.ok) throw new Error(`fetch ${name} failed: ${res.status}`)
  return new File([await res.blob()], name)
}



// MindGrab returns native-grid labels, so no conform/reslice implementation or model
// files are shipped with this demo.
const SEG_COLORMAP: ColorMap = {
  R: [0, 245, 205, 120, 196, 220, 230, 0, 122, 236, 12, 204, 42, 119, 220, 103, 255, 165],
  G: [0, 245, 62, 18, 58, 248, 148, 118, 186, 13, 48, 182, 204, 159, 216, 255, 165, 42],
  B: [0, 245, 78, 134, 250, 164, 34, 14, 220, 176, 255, 142, 164, 176, 20, 255, 0, 42],
  labels: ['Unknown', 'Cerebral-White-Matter', 'Cerebral-Cortex', 'Lateral-Ventricle', 'Inferior-Lateral-Ventricle', 'Cerebellum-White-Matter', 'Cerebellum-Cortex', 'Thalamus', 'Caudate', 'Putamen', 'Pallidum', '3rd-Ventricle', '4th-Ventricle', 'Brain-Stem', 'Hippocampus', 'Amygdala', 'Accumbens-area', 'VentralDC'],
  I: [...Array(18).keys()],
  A: [0, ...Array(17).fill(255)],
}

// Post a raw `--qc` job straight to the niimath worker. The wrapper's chain run()
// only models image→ops→image; --qc takes its own argv and writes a TSV, so we drive
// the worker directly (it stages `blob`+`extraFiles` into MEMFS, runs `cmd`, reads
// `outName` back). The app's single-flight queue guarantees no niimath run overlaps
// this one-shot handler swap.
async function runNiimathQc(t1: File, seg: File): Promise<QcReport> {
  const worker = niimathWorker()
  if (!worker) throw new Error('niimath worker unavailable')
  const template = await fetchFile(TEMPLATE_URL, 'avg152T1.nii.gz')
  if (worker !== niimathWorker()) throw new Error('QC cancelled')
  return new Promise((resolve, reject) => {
    worker.onmessage = (e: MessageEvent) => {
      const d = e.data
      if (d?.type === 'error') {
        reject(new Error(d.message))
        return
      }
      if (d && 'blob' in d) {
        if (!(d.blob instanceof Blob)) {
          reject(new Error('QC worker returned an invalid report file.'))
          return
        }
        void readQcReport(d.blob).then(resolve, reject)
      }
    }
    worker.postMessage({
      blob: t1, // staged in MEMFS under t1.name
      extraFiles: [{ name: seg.name, data: seg }, { name: template.name, data: template }],
      cmd: [
        '--qc', t1.name, '--seg', seg.name,
        '--csf', CSF_LABELS.join(','), '--wm', WM_LABELS.join(','),
        '--air', template.name, '--json', 'qc.json',
      ],
      outName: 'qc.json',
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
  const report = await withTimeout(
    // Both inputs are uncompressed .nii (saveVolume with an empty filename does not
    // gzip; writeNifti emits raw) — no gunzip cost, and `--qc` writes a TSV so output
    // gz never applies. Name matches content so niimath doesn't attempt a gunzip.
    runNiimathQc(new File([t1], 'qc_t1.nii'), new File([segBytes], 'qc_seg.nii')),
    WORKER_TIMEOUT_MS,
    'niimath --qc --air',
  )
  if (bidsMeta) report.bids_meta = bidsMeta
  report.provenance.segmentation = 'mindgrab 16chan18cls (Subcortical + GWM)'
  lastReport = report
  saveBtn.disabled = false
  renderQc(qcBody, report as QcMetrics)
}

// Load `file` as the displayed volume, segment it, and QC the result.
let sourceFile: File | null = null
let viewerReady = false
async function loadSource(file: File, signal?: AbortSignal): Promise<void> {
  signal?.throwIfAborted()
  sourceFile = null
  lastReport = null
  saveBtn.disabled = true
  $<HTMLButtonElement>('runButton').disabled = true
  $('fileInfo').hidden = true
  renderQc(qcBody, null)
  $<HTMLDetailsElement>('resultsSection').open = false
  await nv.loadVolumes([{ url: file, name: file.name }])
  signal?.throwIfAborted()
  sourceFile = file
  lastReport = null
  saveBtn.disabled = true
  renderQc(qcBody, null)
  $<HTMLDetailsElement>('resultsSection').open = false
  $('fileInfo').hidden = false
  $('fileInfo').textContent = file.name
  $<HTMLButtonElement>('runButton').disabled = false
  setStatus('Image loaded. Run quality control when ready.')
}

async function runSegment(file: File): Promise<void> {
  if (isCleanedUp) return // a job queued before cleanup() (HMR) must not touch a dead nv
  spin(true)
  exampleControl.setDisabled(true)
  $<HTMLButtonElement>('runButton').disabled = true
  busy = true
  lastReport = null
  lastName = file.name
  saveBtn.disabled = true
  $<HTMLDetailsElement>('resultsSection').open = false
  renderQc(qcBody, null) // clear any prior QC while we recompute
  const t0 = performance.now()
  try {
    setStatus(`Loading ${file.name}…`)
    await nv.loadVolumes([{ url: file, name: file.name } as ImageFromUrlOptions])
    if (isCleanedUp) return
    setStatus('Segmenting (Subcortical + GWM)… first run downloads the model')
    const { segment } = await import('@brainchop/mindgrab')
    const t1 = await nv.saveVolume({ volumeByIndex: 0, filename: '' })
    if (!(t1 instanceof Uint8Array)) throw new Error('could not serialize the input volume')
    const result = await withTimeout(segment(t1, {
      model: '16chan18cls', worker: true, backend: 'auto',
      assetPath: `${import.meta.env.BASE_URL}brainchop/`,
    }), WORKER_TIMEOUT_MS, 'segmentation')
    const bytes = new Uint8Array(result.image)
    if (isCleanedUp) return // teardown may have run during the reslice/nifti imports
    await nv.addVolume({
      url: new File([bytes], 'segmentation.nii'),
      name: 'segmentation.nii',
      opacity: Number(ovlSlider.value) / 255,
    } as ImageFromUrlOptions)
    if (isCleanedUp) return

    await nv.setColormapLabel(nv.volumes.length - 1, SEG_COLORMAP)
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
      $<HTMLDetailsElement>('resultsSection').open = true
      if (isCleanedUp) return
      setStatus(`Segmentation + QC complete (${Math.round(performance.now() - t0)} ms)`)
    } catch (err) {
      console.warn('QC failed', err)
      resetNiimathWorker()
      renderQc(qcBody, null)
      $<HTMLDetailsElement>('resultsSection').open = true
      setStatus(`Segmented — QC unavailable: ${err instanceof Error ? err.message : String(err)}`)
    }
  } finally {
    busy = false
    spin(false)
    exampleControl.setDisabled(!viewerReady)
    $<HTMLButtonElement>('runButton').disabled = !sourceFile
  }
}

// --- DICOM / file drag-drop ---
let dcmConverted: File[] = []
const DIRECT_VOLUME_RE = /\.(nii|nii\.gz|mgh|mgz|nrrd|mha|mhd|nhdr|head|v)$/i

async function handleDrop(filesPromise: Promise<File[]>, signal?: AbortSignal): Promise<void> {
  if (isCleanedUp) return
  spin(true)
  try {
    setStatus('Reading dropped files…')
    const files = await filesPromise
    signal?.throwIfAborted()
    if (files.length === 0) {
      setStatus('Drop contained no readable files.')
      return
    }
    const sidecar = files.find((file) => file.name.toLowerCase().endsWith('.json'))
    let dropMeta: unknown = null
    if (sidecar) {
      try { dropMeta = JSON.parse(await sidecar.text()) } catch { setStatus(`Ignoring invalid JSON sidecar: ${sidecar.name}`) }
    }
    signal?.throwIfAborted()
    ;({ bind: bidsMeta, staged: stagedSidecar } = bindSidecar(dropMeta, stagedSidecar, files))
    if (files.every((file) => file.name.toLowerCase().endsWith('.json'))) {
      setStatus(sidecar && dropMeta ? `Sidecar staged: ${sidecar.name}. Choose its image next.` : 'No valid JSON sidecar found.')
      return
    }
    dcmConverted = []
    dicomPick.classList.add('hidden')
    // Fast-path a single obvious volume file straight to segmentation.
    if (files.length === 1 && DIRECT_VOLUME_RE.test(files[0].name)) {
      await loadSource(files[0], signal)
      return
    }
    setStatus(`Converting ${files.length} file(s) with dcm2niix…`)
    const t0 = performance.now()
    const niftiFiles = await readImageFiles(files, { directVolume: DIRECT_VOLUME_RE, signal })
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
    await loadSource(niftiFiles[0], signal)
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
    document.querySelector('.nd-viewer-canvas-wrapper > [role="alert"]')?.remove()
    $('emptyState').hidden = false
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
    document.querySelector('.nd-viewer-canvas-wrapper > [role="alert"]')?.remove()
    $('emptyState').hidden = false
    setStatus(noWebGpu)
    return
  }
  viewerReady = true
  exampleControl.setDisabled(false)
  setStatus('Choose an example or open a brain scan.')
}

const exampleControl = renderExampleSelector({
  examples,
  onStatus: setStatus,
  onLoad: async (_example, { fetchFiles, signal, assertCurrent }) => {
    const files = await fetchFiles()
    assertCurrent()
    const job = pending.then(async () => {
      assertCurrent()
      await handleDrop(Promise.resolve(files), signal)
    })
    pending = job.catch(() => {})
    await job
  },
})
$('exampleControl').append(exampleControl.root)
exampleControl.setDisabled(true)
$('runButton').addEventListener('click', () => {
  const file = sourceFile
  if (file) enqueue(() => runSegment(file))
}, ac)

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
    if (file) enqueue(() => loadSource(file))
  },
  ac,
)
aboutBtn.addEventListener('click', () => aboutDialog.open('BrowserQC', $('aboutContent')), ac)
privacyBtn.addEventListener('click', () => privacyDialog.open('Privacy', $('privacyContent')), ac)
saveBtn.addEventListener('click', () => {
  if (!lastReport) return
  const url = URL.createObjectURL(new Blob([`${JSON.stringify(lastReport, null, 2)}\n`], { type: 'application/json' }))
  const link = document.createElement('a')
  link.href = url
  link.download = `${lastName.replace(/\.(nii|nii\.gz|mgz|mgh)$/i, '')}_qc.json`
  link.click()
  setTimeout(() => URL.revokeObjectURL(url), 0)
}, ac)
niftiInput.addEventListener('change', () => {
  const files = Array.from(niftiInput.files ?? [])
  if (files.length > 0) enqueue(() => handleDrop(Promise.resolve(files)))
  niftiInput.value = ''
}, ac)
dicomInput.addEventListener('change', () => {
  const files = Array.from(dicomInput.files ?? [])
  if (files.length > 0) enqueue(() => handleDrop(Promise.resolve(files)))
  dicomInput.value = ''
}, ac)
bindFileDrop($('inputDropZone'), (files) => enqueue(() => handleDrop(files)))
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
  exampleControl.destroy()
  if (isCleanedUp) return
  isCleanedUp = true
  listeners.abort()
  // Terminate the niimath worker FIRST (don't await `pending`): a WASM run is one
  // uninterruptible call, so awaiting the queue would stall teardown. The terminated
  // run never resolves; any run that already resolved hits `if (isCleanedUp) return`
  // before touching nv/ctx.
  resetNiimathWorker()
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
