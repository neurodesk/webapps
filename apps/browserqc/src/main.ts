import NiiVueGPU, {
  DRAG_MODE,
  MULTIPLANAR_TYPE,
  SHOW_RENDER,
  SLICE_TYPE,
} from '@niivue/niivue'
import { mountImagingWorkspace } from '@neurodesk/webapp-components/core/mount-imaging-workspace'
import { bindFileDrop, createInfoDialog, createConsole, createExampleSelector, createViewerToolbar, ProgressManager } from '@neurodesk/webapp-components/ui'
import '@neurodesk/webapp-components/styles/imaging-workspace.css'
import { registerAppAutomation, registerViewer, createNiivueAdapter, runAbortable, summarizeLabels, type OperationContext } from '@neurodesk/webapp-components/automation'
import { readNifti } from '@neurodesk/webapp-components/file-io'
import { runSegmentation, type SegmentationBackend } from './segmentation'
import { readImageFiles, runDcm2niix, traverseDataTransferItems } from '@neurodesk/runtime-support/dcm2niix-client'
import { Niimath, type QcTissues } from '@niivue/niimath'
import { MODELS as BRAINCHOP } from '@brainchop/mindgrab'
import { MODELS, parseModel, type Model } from './models'
import { version as mindgrabVersion } from '@brainchop/mindgrab/package.json'
import { bindSidecar, readQcReport, renderQc } from './qc'
import type { QcMetrics, QcReport } from './qc'
import { resetRating, readRating } from './rate'
import { describeSeries } from './series'
import examples from '../examples.json'

const ASSET_BASE_URL = 'https://huggingface.co/datasets/neurodeskorg/webapps/resolve/12eb1069c34097b7c0881b22e1f7e4ed953aa5cc/browserqc/'
const TEMPLATE_URL = `${ASSET_BASE_URL}avg152T1.nii.gz`
const TISSUE_TINTS = [
  ['gm', [255, 64, 64]],
  ['wm', [255, 255, 255]],
  ['csf', [64, 128, 255]],
] as const
let tissueColormaps: Record<string, string> = {}

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
  const el = document.querySelector<T>(`#${id}`)
  if (!el) throw new Error(`Element #${id} not found`)
  return el
}

// --- DOM handles ---
const locationEl = $('location')
const progressManager = new ProgressManager({ progressBarId: 'loadingCircle', statusTextId: 'statusMsg' })
let manualRun: AbortController | null = null
const modelPick = $<HTMLSelectElement>('modelPick')
for (const [id, model] of Object.entries(MODELS)) {
  const option = document.createElement('option')
  option.value = id
  option.textContent = model.label
  modelPick.append(option)
}
modelPick.value = 'mindmap-pve'
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
const technicalLog = createConsole({ id: 'technicalLog', outputId: 'consoleOutput', copyId: 'copyLogBtn', clearId: 'clearLogBtn' })
$('canvas-container').appendChild(technicalLog)

// --- NiiVue setup ---
// The NiiVue constructor is GPU-free; attachTo() acquires the WebGPU device and
// throws on a browser without it. So construct here but defer attachTo to init(),
// AFTER the navigator.gpu guard, or a no-WebGPU browser gets an unhandled
// top-level rejection instead of the friendly "needs WebGPU" message.
const nv = new NiiVueGPU({ isDragDropEnabled: false, backgroundColor: [0, 0, 0, 1], volumeIsNearestInterpolation: true })
type ExtCtx = ReturnType<typeof nv.createExtensionContext>
let ctx: ExtCtx | null = null

async function attachNiiVue(): Promise<void> {
  await nv.attachTo('gl1')
  registerViewer('main', createNiivueAdapter(nv, { regions: { list: () => labelSummary?.labels ?? [] } }))
  nv.multiplanarType = MULTIPLANAR_TYPE.GRID
  nv.sliceType = SLICE_TYPE.MULTIPLANAR
  nv.showRender = SHOW_RENDER.ALWAYS
  nv.crosshairGap = 5
  nv.isLegendVisible = false
  tissueColormaps = Object.fromEntries(TISSUE_TINTS.map(([name, [r, g, b]]) => [name,
    nv.addColormap(`tissue-${name}`, { R: [r >> 1, r], G: [g >> 1, g], B: [b >> 1, b], A: [0, 48], I: [0, 255] }),
  ]))
  ctx = nv.createExtensionContext()
  ctx.on('locationChange', (e) => {
    locationEl.textContent = e.detail.string
  })
}

// --- App state ---
let isCleanedUp = false
let initializationFailure: Error | null = null
let labelSummary: ReturnType<typeof summarizeLabels> | null = null
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

// --- Status helpers ---
function setStatus(msg: string): void {
  statusMsg.textContent = msg
  // The footer cell ellipsizes; expose the full text (esp. long failures) on hover.
  statusMsg.title = msg
  statusMsg.classList.toggle('hidden', msg === '')
  if (msg) technicalLog.log(msg)
}
function spin(on: boolean): void {
  if (on) progressManager.setIndeterminate(statusMsg.textContent ?? 'Working…')
  else progressManager.setProgress(0)
}

const viewPick = document.createElement('select')
viewPick.id = 'viewPick'
viewPick.setAttribute('aria-label', 'Image display')
for (const [value, label] of [['tissues', 'Tissues'], ['background', 'Background noise']]) {
  const option = document.createElement('option')
  option.value = value
  option.textContent = label
  viewPick.append(option)
}
const dragPick = document.createElement('select')
dragPick.id = 'dragPick'
dragPick.setAttribute('aria-label', 'Right drag action')
for (const [value, label] of [['contrast', 'Right drag contrast'], ['pan', 'Right drag pan']]) {
  const option = document.createElement('option')
  option.value = value
  option.textContent = label
  dragPick.append(option)
}
const toolbar = createViewerToolbar({
  views: false, window: false, overlay: false, colormap: false, download: false, screenshot: false,
  actions: [viewPick, dragPick, ovlSlider.closest('.nd-field') ?? ovlSlider],
})
$('canvas-container').prepend(toolbar)
async function showView(): Promise<void> {
  const t1 = nv.volumes[0]
  if (!t1) return
  const background = viewPick.value === 'background'
  ovlSlider.disabled = background
  for (let index = 1; index < nv.volumes.length; index++) {
    await nv.setVolume(index, { opacity: background ? 0 : Number(ovlSlider.value) / 255 })
  }
  let calMin = t1.robustMin
  let calMax = t1.robustMax
  if (background && t1.img) {
    const image = t1.img
    const stride = Math.max(1, Math.ceil(t1.nVox3D / 1e6))
    const values = Float64Array.from({ length: Math.ceil(t1.nVox3D / stride) }, (_, index) => image[index * stride])
      .filter(value => value !== 0 && Number.isFinite(value)).sort()
    if (values.length) {
      const slope = t1.hdr.scl_slope || 1
      calMin = values[0] * slope + t1.hdr.scl_inter
      calMax = values[Math.floor(0.61 * (values.length - 1))] * slope + t1.hdr.scl_inter
    }
  }
  await nv.setVolume(0, { colormap: background ? 'viridis' : 'gray', isColormapInverted: background, calMin, calMax })
}
viewPick.addEventListener('change', () => {
  if (!busy) enqueue(showView)
}, ac)
dragPick.addEventListener('change', () => {
  nv.secondaryDragMode = dragPick.value === 'pan' ? DRAG_MODE.pan : DRAG_MODE.contrast
}, ac)
$('cancelButton').addEventListener('click', () => manualRun?.abort(), ac)

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
  if (!niimathReady) niimathReady = niimath.init().then(() => {})
  await withTimeout(niimathReady, WORKER_TIMEOUT_MS, 'niimath init')
}

// If a niimath run fails, its worker + init promise may be in a bad state; tear both
function resetNiimathWorker(): void {
  niimath.dispose('niimath worker reset')
  niimathReady = null
}

async function fetchFile(url: string, name: string, signal?: AbortSignal): Promise<File> {
  const res = await fetch(url, { signal })
  if (!res.ok) throw new Error(`fetch ${name} failed: ${res.status}`)
  return new File([await res.blob()], name)
}



async function computeQc(t1: Uint8Array, tissues: QcTissues, model: Model, signal: AbortSignal): Promise<QcReport> {
  await runAbortable(signal, ensureNiimath, resetNiimathWorker)
  const air = await fetchFile(TEMPLATE_URL, 'avg152T1.nii.gz', signal)
  const output = await runAbortable(signal, () => withTimeout(
    niimath.image(new Uint8Array(t1).buffer).qc(tissues, air), WORKER_TIMEOUT_MS, 'niimath QC'), resetNiimathWorker)
  const report = await readQcReport(new Blob([JSON.stringify(output)]))
  signal.throwIfAborted()
  if (bidsMeta) report.bids_meta = bidsMeta
  report.provenance.segmentation = `brainchop ${model} (${MODELS[model].label})`
  lastReport = report
  saveBtn.disabled = false
  const metrics: QcMetrics = {}
  for (const [key, value] of Object.entries(report)) if (typeof value === 'number') metrics[key] = value
  renderQc(qcBody, metrics)
  return report
}

// Load `file` as the displayed volume, segment it, and QC the result.
let sourceFile: File | null = null
let viewerReady = false
async function loadSource(file: File, signal?: AbortSignal): Promise<void> {
  signal?.throwIfAborted()
  sourceFile = null
  $<HTMLButtonElement>('rateSave').disabled = true
  labelSummary = null
  lastReport = null
  saveBtn.disabled = true
  $<HTMLButtonElement>('runButton').disabled = true
  $('fileInfo').hidden = true
  renderQc(qcBody, null)
  $<HTMLDetailsElement>('resultsSection').open = false
  await nv.loadVolumes([{ url: file, name: file.name }])
  signal?.throwIfAborted()
  sourceFile = file
  resetRating()
  await showView()
  lastReport = null
  saveBtn.disabled = true
  renderQc(qcBody, null)
  $<HTMLDetailsElement>('resultsSection').open = false
  $('fileInfo').hidden = false
  $('fileInfo').textContent = file.name
  $<HTMLButtonElement>('runButton').disabled = false
  setStatus('Image loaded. Run quality control when ready.')
}

async function runSegment(file: File, options: { backend?: SegmentationBackend; model?: Model; signal?: AbortSignal; strictQc?: boolean; progress?: OperationContext['progress'] } = {}) {
  const signal = options.signal ?? listeners.signal
  const current = () => {
    signal.throwIfAborted()
    if (isCleanedUp) throw new Error('The BrowserQC workspace has closed.')
  }
  const reportProgress = (message: string) => {
    current()
    setStatus(message)
    options.progress?.({ message })
  }
  const model = options.model ?? parseModel(modelPick.value)
  current()
  spin(true)
  modelPick.disabled = true
  viewPick.disabled = true
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
    reportProgress(`Loading ${file.name}…`)
    await nv.loadVolumes([{ url: file, name: file.name }])
    current()
    reportProgress(`Brain mask and ${MODELS[model].label}… first run downloads the models`)
    const t1 = await nv.saveVolume({ volumeByIndex: 0, filename: '' })
    if (!(t1 instanceof Uint8Array)) throw new Error('could not serialize the input volume')
    // MindGrab's auto mode falls back to WebGL when WebGPU has no adapter; on a software GL
    // stack that never finishes, so adapter-less browsers use the CPU bundle instead.
    const adapter = navigator.gpu ? await navigator.gpu.requestAdapter().catch(() => null) : null
    const backend = options.backend ?? (adapter ? 'auto' : 'cpu')
    if (!adapter) reportProgress('Segmenting on the CPU (no WebGPU adapter)… first run downloads the model')
    const result = await runSegmentation(t1, backend, model, signal)
    current()
    const artifacts: { role: string; file: File }[] = [
      { role: 'mask', file: new File([result.mask], 'brain-mask.nii', { type: 'application/x-nifti' }) },
    ]
    let tissues: QcTissues
    let measurements: ReturnType<typeof summarizeLabels> | undefined
    const opacity = Number(ovlSlider.value) / 255
    if (result.kind === 'labels') {
      if (model === 'mindmap-pve') throw new Error('PVE model returned labels.')
      const palette = BRAINCHOP[model].colormap
      const colormap = { ...palette, I: palette.labels.map((_, index) => index), A: palette.labels.map((_, index) => index === 0 ? 0 : 255) }
      const bytes = new Uint8Array(result.image)
      measurements = summarizeLabels(await readNifti(bytes), colormap)
      artifacts.push({ role: 'labels', file: new File([bytes], 'labels.nii', { type: 'application/x-nifti' }) })
      await nv.addVolume({ url: artifacts[1].file, name: 'segmentation.nii', opacity })
      current()
      await nv.setColormapLabel(1, colormap)
      tissues = { seg: result.image, csf: MODELS[model].csf, wm: MODELS[model].wm, mask: result.mask }
    } else {
      const names = ['csf', 'gm', 'wm'] satisfies (keyof typeof result.tissues)[]
      for (const name of names) {
        const image = new File([result.tissues[name]], `${name}.nii`, { type: 'application/x-nifti' })
        artifacts.push({ role: name, file: image })
        await nv.addVolume({ url: image, name: `${name}.nii`, colormap: tissueColormaps[name], colormapType: 1, calMin: 0.03, calMax: 1, opacity })
        current()
      }
      tissues = { pve: [result.tissues.csf, result.tissues.gm, result.tissues.wm], mask: result.mask }
    }
    labelSummary = measurements ?? null
    busy = false
    await showView()

    // QC on the result. Non-fatal: a QC failure must not discard the segmentation
    // display — reset the worker, surface it in the status bar, leave the panel empty.
    try {
      reportProgress('Computing image-quality metrics (niimath)…')
      const qc = await computeQc(t1, tissues, model, signal)
      $<HTMLDetailsElement>('resultsSection').open = true
      current()
      reportProgress(`Segmentation + QC complete (${Math.round(performance.now() - t0)} ms)`)
      return { artifacts, qc, measurements, segmentation: { model, version: mindgrabVersion, backend: result.backend, elapsedMs: result.elapsedMs } }
    } catch (err) {
      if (signal.aborted) throw err
      console.warn('QC failed', err)
      resetNiimathWorker()
      renderQc(qcBody, null)
      $<HTMLDetailsElement>('resultsSection').open = true
      reportProgress(`Segmented — QC unavailable: ${err instanceof Error ? err.message : String(err)}`)
      if (options.strictQc) throw err
    }
  } finally {
    busy = false
    modelPick.disabled = false
    viewPick.disabled = false
    spin(false)
    exampleControl.setDisabled(!viewerReady)
    $<HTMLButtonElement>('runButton').disabled = !sourceFile
  }
}

// --- DICOM / file drag-drop ---
let dcmConverted: Awaited<ReturnType<typeof describeSeries>> = []
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
    const outputs = await readImageFiles(files, { directVolume: DIRECT_VOLUME_RE, niftiOnly: false, signal })
    const niftiFiles = outputs.filter(file => DIRECT_VOLUME_RE.test(file.name))
    const ms = Math.round(performance.now() - t0)
    if (niftiFiles.length === 0) {
      setStatus('No NIfTI output produced. Are these DICOM images?')
      return
    }
    dcmConverted = await describeSeries(niftiFiles, [...files, ...outputs].filter(file => /\.json$/i.test(file.name)), bidsMeta)
    if (dcmConverted.length > 1) {
      sourceFile = null
      bidsMeta = null
      lastReport = null
      saveBtn.disabled = true
      $<HTMLButtonElement>('runButton').disabled = true
      $<HTMLButtonElement>('rateSave').disabled = true
      renderQc(qcBody, null)
      dicomPick.replaceChildren()
      const prompt = document.createElement('option')
      prompt.value = ''
      prompt.textContent = 'Choose a series…'
      prompt.disabled = true
      prompt.selected = true
      dicomPick.append(prompt)
      dcmConverted.forEach((series, i) => {
        const opt = document.createElement('option')
        opt.value = String(i)
        opt.text = series.label
        dicomPick.appendChild(opt)
      })
      dicomPick.value = ''
      dicomPick.classList.remove('hidden')
      setStatus(`dcm2niix: ${niftiFiles.length} NIfTI in ${ms} ms — pick one.`)
      return
    }
    bidsMeta = dcmConverted[0].meta
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
    initializationFailure = new Error(noWebGpu)
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
    initializationFailure = new Error(noWebGpu, { cause: err })
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

const exampleControl = createExampleSelector({
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
$('exampleControl').append(exampleControl)
exampleControl.setDisabled(true)
$('runButton').addEventListener('click', () => {
  const file = sourceFile
  if (file) enqueue(async () => {
    const controller = new AbortController()
    manualRun = controller
    progressManager.begin('Starting quality control…')
    try {
      await runSegment(file, { signal: controller.signal })
      progressManager.end(statusMsg.textContent ?? 'Quality control complete')
    } catch (error) {
      progressManager.end(controller.signal.aborted ? 'Quality control cancelled.' : 'Quality control failed.', { success: false })
      if (!controller.signal.aborted) throw error
    } finally { manualRun = null }
  })
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
    const series = dcmConverted[Number(dicomPick.value)]
    if (series) enqueue(async () => {
      bidsMeta = series.meta
      await loadSource(series.file)
    })
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
    if (!busy) void showView()
  },
  ac,
)

$('rateSave').addEventListener('click', () => {
  if (!sourceFile) return
  const url = URL.createObjectURL(new Blob([JSON.stringify(readRating(sourceFile.name), null, 2)], { type: 'application/json' }))
  const link = document.createElement('a')
  link.href = url
  link.download = `${sourceFile.name.replace(/\.nii(\.gz)?$/i, '')}_rating.json`
  link.click()
  setTimeout(() => URL.revokeObjectURL(url), 0)
}, ac)

// --- Cleanup (HMR / tab close) ---
async function cleanup(): Promise<void> {
  exampleControl.destroy()
  if (isCleanedUp) return
  isCleanedUp = true
  listeners.abort()
  manualRun?.abort()
  progressManager.reset()
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

registerAppAutomation({
  app: 'browserqc',
  convertDicom: runDcm2niix,
  operations: {
    async 'quality-control'({ inputs, inputDetails, parameters, signal, progress }) {
      const files = inputs.image
      if (!Array.isArray(files) || files.length !== 1) throw new Error('BrowserQC requires one selected image.')
      const model = parseModel(parameters.model ?? 'mindmap-pve')
      const backend = parameters.backend
      if (backend !== 'auto' && backend !== 'cpu') throw new Error('Choose the auto or CPU segmentation backend.')
      const sidecars = inputs.sidecar
      if (!Array.isArray(sidecars)) throw new Error('The sidecar must be an uploaded JSON file.')
      const sidecar = sidecars[0] ?? inputDetails.image.sidecars.find(file => file.name.toLowerCase().endsWith('.json'))
      const metadata: unknown = sidecar ? JSON.parse(await sidecar.text()) : null
      if (sidecar && (!metadata || typeof metadata !== 'object' || Array.isArray(metadata))) throw new Error('The BIDS sidecar must be a JSON object.')
      const job = pending.then(async () => {
        signal.throwIfAborted()
        if (initializationFailure) throw initializationFailure
        if (!viewerReady) throw new Error('The BrowserQC viewer is unavailable.')
        exampleControl.cancel()
        bidsMeta = metadata
        stagedSidecar = null
        await loadSource(files[0], signal)
        const result = await runSegment(files[0], { backend, model, signal, progress, strictQc: true })
        signal.throwIfAborted()
        if (!result) throw new Error('BrowserQC completed without quality metrics.')
        return {
          artifacts: [
            ...result.artifacts,
            { role: 'qc', file: new File([JSON.stringify(result.qc, null, 2)], 'qc.json', { type: 'application/json' }) },
          ],
          provenance: { segmentation: result.segmentation, qc: result.qc.provenance, airTemplate: TEMPLATE_URL },
          measurements: result.measurements,
        }
      })
      pending = job.catch(() => {})
      return job
    },
  },
})

enqueue(async () => {
  try { await init() }
  catch (error) {
    initializationFailure = error instanceof Error ? error : new Error(String(error))
    throw error
  }
})
