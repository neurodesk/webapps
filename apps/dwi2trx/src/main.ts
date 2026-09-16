import examples from '../examples.json'
import { renderExampleSelector } from '@neurodesk/webapp-components/ui'
/**
 * dwi2trx — browser-only diffusion MRI pipeline (WASM + WebGPU; no data leaves
 * the machine). The compact workflow reveals tensor maps and streamlines as
 * their inputs become available; dropping a new DWI relocks later sections.
 * Inspired by brain2print, but its own project.
 */

import '@neurodesk/webapp-components/styles/imaging-workspace.css'
import { mountImagingWorkspace } from '@neurodesk/webapp-components/core/mount-imaging-workspace'
import { createInfoDialog, renderConsole, renderViewerToolbar } from '@neurodesk/webapp-components/ui'
import NiiVueGPU, { SHOW_RENDER, SLICE_TYPE } from '@niivue/niivue'
import { cropB0Volume, fitTensor } from './dwi2trx/dtifit'
import {
  countB0,
  describeShells,
  findPolarityBalanceWarnings,
  GE_DAT_MAX_DIRECTIONS,
  type GenScheme,
  measureScheme,
  methodLabel,
  type ShellSpec,
  schemeBaseName,
  schemeToDvs,
  schemeToGeDat,
  schemeToPhilipsTxt,
  suggestNextShell,
} from './dwi2trx/genvectors'
import {
  cancelSchemeGeneration,
  generateSchemeInWorker,
} from './dwi2trx/genvectors-worker-client'
import { collectFiles, readNiftiHeader, type ResolvedInput, resolveInput } from './dwi2trx/input'
import { formatBytes, InputTooLargeError } from './dwi2trx/input-limits'
import {
  type InputSource,
  type Step,
  state,
  type TensorMaps,
  type DwiInput,
} from './dwi2trx/state'
import { baseName, flipBvecX } from './dwi2trx/validate'
import { downloadBlob, extractAffine } from '@neurodesk/webapp-components/file-io'
import {
  buildGradientScheme,
  buildSchemeFromSamples,
  type GradientScheme,
  withAntipodalNodes,
} from './dwi2trx/vectors'

mountImagingWorkspace({
  controls: '#controls',
  viewer: '#canvas-container',
  status: '#status',
  title: 'dwi2trx',
  subtitle: 'Diffusion tensor fitting and GPU streamline tractography',
  mark: 'D',
  controlsContract: { about: '#aboutBtn', privacy: '#privacyBtn' },
})

const $ = <T extends HTMLElement>(id: string): T => {
  const el = document.getElementById(id)
  if (!el) throw new Error(`missing #${id}`)
  return el as T
}

const dialogs = [
  ['aboutDlg', 'About dwi2trx'],
  ['privacyDlg', 'Privacy'],
  ['largeInputDlg', 'Dataset too large for the browser'],
  ['vecDlg', 'Gradient sampling scheme'],
  ['genVecDlg', 'Generate diffusion vectors'],
]
for (const [id, title] of dialogs) {
  const dialog = createInfoDialog({ id })
  dialog.title.textContent = title
  dialog.setContent($(id + 'Content'))
  if (id === 'vecDlg' || id === 'genVecDlg') dialog.root.classList.add('nd-dialog-wide')
}
const consoleView = renderConsole({ outputId: 'consoleOutput' })
$('canvas-container').append(consoleView.root)
const toolbar = renderViewerToolbar({
  views: [], window: false, overlay: false, colormap: false, download: false, screenshot: false,
  actions: [$('sliceType')],
})
$('canvas-container').prepend(toolbar.root)
$('viewSection').querySelector('label[for="sliceType"]')?.remove()

const maskFitBtn = $<HTMLButtonElement>('maskFitBtn')
const showVecBtn = $<HTMLButtonElement>('showVecBtn')
const vecDlg = $<HTMLDialogElement>('vecDlg')
const vecCanvas = $<HTMLCanvasElement>('vecCanvas')
const vecScale = $<HTMLInputElement>('vecScale')
const vecShowAntipodal = $<HTMLInputElement>('vecShowAntipodal')
const vecInfo = $<HTMLParagraphElement>('vecInfo')
const genVecBtn = $<HTMLButtonElement>('genVecBtn')
const genVecDlg = $<HTMLDialogElement>('genVecDlg')
const genVecCanvas = $<HTMLCanvasElement>('genVecCanvas')
const genVecScale = $<HTMLInputElement>('genVecScale')
const genVecShowAntipodal = $<HTMLInputElement>('genVecShowAntipodal')
const genVecInfo = $<HTMLParagraphElement>('genVecInfo')
const genVecSaveBtn = $<HTMLButtonElement>('genVecSaveBtn')
const genVecSaveDatBtn = $<HTMLButtonElement>('genVecSaveDatBtn')
const genVecSavePhilipsBtn = $<HTMLButtonElement>('genVecSavePhilipsBtn')
const genVecShells = $<HTMLDivElement>('genVecShells')
const genVecAddShell = $<HTMLButtonElement>('genVecAddShell')
const genVecDelShell = $<HTMLButtonElement>('genVecDelShell')
const genVecSimultaneous = $<HTMLInputElement>('genVecSimultaneous')
const genVecAlpha = $<HTMLInputElement>('genVecAlpha')
const genVecAlphaVal = $<HTMLSpanElement>('genVecAlphaVal')
const genVecB0 = $<HTMLInputElement>('genVecB0')
const filePicker = $<HTMLInputElement>('filePicker')
const trackBtn = $<HTMLButtonElement>('trackBtn')
const saveBtn = $<HTMLButtonElement>('saveBtn')
const saveMapsBtn = $<HTMLButtonElement>('saveMapsBtn')
const fiberColor = $<HTMLSelectElement>('fiberColor')
const displayMode = $<HTMLSelectElement>('displayMode')
const sliceTypeSel = $<HTMLSelectElement>('sliceType')
const seedFaIn = $<HTMLInputElement>('seedFa')
const stopFaIn = $<HTMLInputElement>('stopFa')
const stepSizeIn = $<HTMLInputElement>('stepSize')
const maxAngleIn = $<HTMLInputElement>('maxAngle')
const seedDensityIn = $<HTMLInputElement>('seedDensity')
const aboutBtn = $<HTMLButtonElement>('aboutBtn')
const aboutDlg = $<HTMLDialogElement>('aboutDlg')
const privacyBtn = $<HTMLButtonElement>('privacyBtn')
const privacyDlg = $<HTMLDialogElement>('privacyDlg')
const largeInputDlg = $<HTMLDialogElement>('largeInputDlg')
const largeInputSummary = $<HTMLParagraphElement>('largeInputSummary')
const faSlider = $<HTMLInputElement>('faSlider')
const statusEl = $<HTMLSpanElement>('statusText')
const technicalLog = consoleView.console
const locationEl = $<HTMLDivElement>('location')
const dropOverlay = $<HTMLDivElement>('dropOverlay')
const tensorSection = $<HTMLDetailsElement>('tensorSection')
const trackingSection = $<HTMLDetailsElement>('trackingSection')

// UI fallback for a blank "b0 every" field; matches index.html.
const DEFAULT_B0_EVERY = 12

// Which volumes the canvas currently shows, so a workflow transition only
// reloads when the view actually needs to change.
let shownView: 'input' | 'maps' | 'tracts' | null = null

// Monotonic load token: each drop/sample load claims a sequence number; a load
// (or the fit it feeds) only mutates the viewer/state if it's still the latest,
// so a slow async result can't clobber a newer input. `loadSeq` is input
// identity (bumped per new DWI). Canvas swaps are serialized separately via
// `viewChain` (see syncView) so overlapping loadVolumes can't fight.
let loadSeq = 0
let inputAbortController: AbortController | null = null

let exampleControl: ReturnType<typeof renderExampleSelector> | undefined

function setStatus(msg: string, error = false): void {
  statusEl.textContent = msg
  statusEl.classList.toggle('error', error)
  technicalLog.log(msg, error ? 'error' : 'info')
}

/** Show/hide the spinning busy indicator beside the status text during slow
 *  work (mindgrab, the dtifit fit, DICOM conversion). */
function busy(on: boolean): void {
  exampleControl?.setDisabled(on)
  const progress = $<HTMLProgressElement>('progress')
  if (on) progress.removeAttribute('value')
  else progress.value = 0
}

/** Keep the Save-GE state and tooltip together. GE documents 6–300 rows, while
 * over-range schemes remain available in the other formats. */
function setSaveDatState(scheme: GenScheme | null): void {
  const tooMany = !!scheme && scheme.dirs.length > GE_DAT_MAX_DIRECTIONS
  genVecSaveDatBtn.disabled = !scheme || tooMany
  genVecSaveDatBtn.title = tooMany
    ? `GE tensor DAT supports at most ${GE_DAT_MAX_DIRECTIONS} volumes — use Siemens or Philips instead`
    : 'Download the vector set as a GE tensor .dat file'
}

function showLargeInputDialog(error: InputTooLargeError): void {
  largeInputSummary.textContent = `The selected files total ${formatBytes(error.actualBytes)}. This browser tool accepts at most ${formatBytes(error.limitBytes)} per dataset.`
  if (!largeInputDlg.open) largeInputDlg.showModal()
}

/** Read a numeric input, falling back to `def` (incl. for an empty/blank field —
 *  `valueAsNumber` is NaN there, unlike `Number('')` which is 0) and clamping. */
function num(
  el: HTMLInputElement,
  def: number,
  min: number,
  max: number,
): number {
  const v = el.valueAsNumber
  return Number.isFinite(v) ? Math.min(max, Math.max(min, v)) : def
}

/** Keep later workflow sections unavailable until their scientific inputs exist. */
function render(): void {
  maskFitBtn.disabled = !state.input
  showVecBtn.disabled = !state.input
  saveMapsBtn.disabled = !state.maps
  saveBtn.disabled = !state.tracts
  for (const [section, enabled] of [[tensorSection, !!state.maps], [trackingSection, !!state.maps]] as const) {
    section.classList.toggle('nd-step-disabled', !enabled)
    const content = section.querySelector<HTMLElement>(':scope > .nd-section-content')
    if (content) content.inert = !enabled
  }
  if (state.step === 2 && state.maps) tensorSection.open = true
  if (state.step === 3 && state.tracts) trackingSection.open = true
}

/** Switch the active scientific result (caller triggers the matching view via syncView). */
function gotoTab(step: Step): void {
  $('emptyState').hidden = Boolean(state.input)
  state.step = step
  render()
}

maskFitBtn.addEventListener('click', () => {
  void runFit()
})
trackBtn.addEventListener('click', () => {
  void runTrack()
})
fiberColor.addEventListener('change', () => {
  void applyFiberColor() // self-guards on a loaded tract
})
displayMode.addEventListener('change', () => {
  void applyDisplayMode() // self-guards on the FA+V1 maps being loaded
})
sliceTypeSel.addEventListener('change', () => {
  nv.sliceType = Number(sliceTypeSel.value)
  nv.drawScene()
})
aboutBtn.addEventListener('click', () => aboutDlg.showModal())
privacyBtn.addEventListener('click', () => privacyDlg.showModal())
showVecBtn.addEventListener('click', () => {
  void showVectors()
})
vecScale.addEventListener('input', () => updateVecScale(Number(vecScale.value)))
vecShowAntipodal.addEventListener('change', () => {
  if (loadedVecScheme) void refreshLoadedPreview(loadedVecScheme)
})
genVecBtn.addEventListener('click', () => {
  void openGenVectors()
})
genVecAddShell.addEventListener('click', () => {
  genShells.push(suggestNextShell(genShells)) // √b rule: +1000 b, √-scaled count
  renderShellRows()
  scheduleGenerate()
})
genVecDelShell.addEventListener('click', () => {
  if (genShells.length <= 1) return // keep at least a single shell
  genShells.pop()
  renderShellRows()
  scheduleGenerate()
})
genVecSimultaneous.addEventListener('change', () => {
  // Caruyer's incremental web tool has no alpha control.
  genVecAlpha.disabled = !genVecSimultaneous.checked
  scheduleGenerate()
})
genVecAlpha.addEventListener('input', () => {
  genVecAlphaVal.textContent = Number(genVecAlpha.value).toFixed(2)
  scheduleGenerate()
})
genVecB0.addEventListener('input', () => {
  scheduleGenerate()
})
genVecScale.addEventListener('input', () =>
  updateGenScale(Number(genVecScale.value)),
)
genVecShowAntipodal.addEventListener('change', () => {
  if (!genScheme) return
  // This is a render-only option: do not invalidate or regenerate the DVS.
  void refreshGeneratedPreview(genScheme)
})
// Invalidate both a pending debounce and any async preview work when dismissed.
genVecDlg.addEventListener('close', () => {
  clearTimeout(genTimer)
  cancelSchemeGeneration()
  genRevision++
  genPending = false
  genScheme = null
  genVecSaveBtn.disabled = true
  genVecSavePhilipsBtn.disabled = true
  setSaveDatState(null)
})
genVecSaveBtn.addEventListener('click', () => {
  if (!genScheme) return
  const name = `DiffusionVectors_${schemeBaseName(genScheme.shells)}.dvs`
  download(new Blob([schemeToDvs(genScheme)], { type: 'text/plain' }), name)
})
genVecSaveDatBtn.addEventListener('click', () => {
  if (!genScheme) return
  const name = `tensor_${schemeBaseName(genScheme.shells)}.dat`
  download(new Blob([schemeToGeDat(genScheme)], { type: 'text/plain' }), name)
})
genVecSavePhilipsBtn.addEventListener('click', () => {
  if (!genScheme) return
  download(
    new Blob([schemeToPhilipsTxt(genScheme)], { type: 'text/plain' }),
    'dti_vectors_input.txt',
  )
})
const download = downloadBlob

/** Determinant of the 3×3 block of a voxel→world affine. */
function det3(m: ArrayLike<number>[]): number {
  return (
    m[0][0] * (m[1][1] * m[2][2] - m[1][2] * m[2][1]) -
    m[0][1] * (m[1][0] * m[2][2] - m[1][2] * m[2][0]) +
    m[0][2] * (m[1][0] * m[2][1] - m[1][1] * m[2][0])
  )
}
// dcm2niix names carry folder, protocol and acquisition time: keep them out of outputs.
function outputBase(input: DwiInput): string {
  return input.source === 'dicom' ? 'dwi' : baseName(input.nifti.name) || 'dwi'
}

saveBtn.addEventListener('click', () => {
  if (state.tracts) download(state.tracts, state.tracts.name)
})
saveMapsBtn.addEventListener('click', () => {
  if (!state.maps || !state.input) return
  const base = outputBase(state.input)
  download(state.maps.fa, `${base}_FA.nii.gz`)
  download(state.maps.v1, `${base}_V1.nii.gz`)
})
faSlider.addEventListener('input', () => {
  if (shownView === 'maps') setFaFloor() // ignore while the raw DWI is shown
})

// --- Gradient connectome preview (shared by both vector modals) ---
// A lightweight NiiVue instance in a modal that renders a bvec/bval scheme as a
// ball connectome (one node per distinct sample), rotatable and independent of
// the main viewer — it never touches the spatial image on the primary canvas.
// Two modals reuse this: "Show vectors" (the loaded DWI's scheme) and "Generate
// Vectors" (a freshly optimized scheme). Each keeps its own viewer, created
// lazily and reused.

/** Build a render-only NiiVue viewer on `canvas` (rotatable, no slice views,
 *  no orientation cube — anatomical labels are meaningless in gradient space). */
async function makeRenderViewer(canvas: HTMLCanvasElement): Promise<NiiVueGPU> {
  const v = new NiiVueGPU({
    isDragDropEnabled: false,
    // Mid-dark gray gives ACTC nodes and the origin crosshair clear contrast.
    backgroundColor: [0.2, 0.2, 0.2, 1],
    // Vector coordinates are normalized to a maximum radius of 1. NiiVue's
    // anatomical defaults (width 1, gap 10) would engulf the graph origin.
    crosshairWidth: 0.01,
    crosshairGap: 0.05,
  })
  try {
    await v.attachToCanvas(canvas)
    v.sliceType = SLICE_TYPE.RENDER
    v.isOrientCubeVisible = false
    return v
  } catch (error) {
    v.destroy()
    throw error
  }
}

// Each modal owns ONE viewer, created lazily. We cache the init *promise* (not the
// resolved instance) and assign it synchronously, so two rapid opens can never
// both pass a `!viewer` check and double-attach two NiiVue controls to one canvas.
let vecViewerPromise: Promise<NiiVueGPU> | null = null
let genViewerPromise: Promise<NiiVueGPU> | null = null

function getVecViewer(): Promise<NiiVueGPU> {
  if (!vecViewerPromise) {
    const pending = makeRenderViewer(vecCanvas)
    vecViewerPromise = pending
    void pending.catch(() => {
      if (vecViewerPromise === pending) vecViewerPromise = null
    })
  }
  return vecViewerPromise
}

function getGenViewer(): Promise<NiiVueGPU> {
  if (!genViewerPromise) {
    const pending = makeRenderViewer(genVecCanvas)
    genViewerPromise = pending
    void pending.catch(() => {
      if (genViewerPromise === pending) genViewerPromise = null
    })
  }
  return genViewerPromise
}

// Mesh replacement and node re-extrusion both mutate the viewer's GPU scene.
// Keep those operations in one short queue per viewer so slider input cannot
// overlap a preview load. A rejected operation does not poison later retries.
const viewerMutationTail = new WeakMap<NiiVueGPU, Promise<void>>()
async function mutateViewer(
  v: NiiVueGPU,
  mutation: () => Promise<void>,
): Promise<void> {
  const previous = viewerMutationTail.get(v) ?? Promise.resolve()
  const current = previous.catch(() => {}).then(mutation)
  viewerMutationTail.set(v, current)
  try {
    await current
  } finally {
    if (viewerMutationTail.get(v) === current) viewerMutationTail.delete(v)
  }
}

/** Load a gradient scheme into a viewer as a connectome, crosshair at the origin
 *  (the b=0 centre). `nodeScale` seeds the node radii; the live slider tweaks it. */
async function loadSchemePreview(
  v: NiiVueGPU,
  scheme: GradientScheme,
  nodeScale: number,
): Promise<void> {
  await mutateViewer(v, async () => {
    // Serialize to a `.jcon` File so NiiVue's connectome reader ingests it.
    const jcon = new File(
      [
        JSON.stringify({
          ...scheme.options,
          nodeScale,
          nodes: scheme.data.nodes,
          edges: scheme.data.edges,
        }),
      ],
      'vectors.jcon',
    )
    // loadMeshes() clears existing meshes itself, so no explicit removeAllMeshes.
    await v.loadMeshes([
      { url: jcon, name: 'vectors.jcon', isLegendVisible: false },
    ])
    // Park the crosshair on the world origin so it reads as a reference marker.
    v.setCrosshairPos([0, 0, 0])
    v.drawScene()
  })
}

/** A per-frame-coalesced, non-overlapping node-scale updater for one viewer: many
 *  slider `input` events during a drag collapse to one `setConnectomeOptions`
 *  (re-extrude) per animation frame, and a new value never starts before the
 *  previous apply resolves. */
function makeNodeScaleUpdater(
  getViewer: () => Promise<NiiVueGPU> | null,
): (value: number) => void {
  let pending: number | null = null
  let running = false
  const pump = async (): Promise<void> => {
    if (running || pending === null) return
    running = true
    const value = pending
    pending = null
    try {
      const p = getViewer()
      const v = p ? await p : null
      if (v?.meshes.length) {
        await mutateViewer(v, () =>
          v.setConnectomeOptions(0, { nodeScale: value }),
        )
      }
    } catch {
      // Viewer initialization/load reports through its owning modal. A failed
      // slider update must not become an unhandled rejection.
    } finally {
      running = false
      if (pending !== null) requestAnimationFrame(() => void pump())
    }
  }
  return (value: number) => {
    pending = value
    if (!running) requestAnimationFrame(() => void pump())
  }
}
const updateVecScale = makeNodeScaleUpdater(() => vecViewerPromise)
const updateGenScale = makeNodeScaleUpdater(() => genViewerPromise)

let loadedVecScheme: GradientScheme | null = null

function buildLoadedPreview(scheme: GradientScheme): GradientScheme {
  return vecShowAntipodal.checked ? withAntipodalNodes(scheme) : scheme
}

function showLoadedSchemeSummary(scheme: GradientScheme): void {
  const shellTxt = scheme.shells.map(([b, n]) => `b=${b}×${n}`).join(', ')
  const coverageLink = document.createElement('a')
  coverageLink.href =
    'https://fsl.fmrib.ox.ac.uk/fsl/docs/diffusion/eddy/index.html'
  coverageLink.target = '_blank'
  coverageLink.rel = 'noopener'
  coverageLink.textContent = scheme.coverage
  vecInfo.replaceChildren(
    document.createTextNode(
      `${scheme.directions} directions · ${scheme.nodes} unique · ${shellTxt} `,
    ),
    coverageLink,
  )
}

async function refreshLoadedPreview(scheme: GradientScheme): Promise<void> {
  try {
    const viewer = await getVecViewer()
    if (!vecDlg.open || loadedVecScheme !== scheme) return
    await loadSchemePreview(
      viewer,
      buildLoadedPreview(scheme),
      Number(vecScale.value),
    )
  } catch (err) {
    if (vecDlg.open && loadedVecScheme === scheme) {
      vecInfo.classList.add('error')
      vecInfo.textContent = `Could not update preview: ${(err as Error).message}`
    }
  }
}

async function showVectors(): Promise<void> {
  const input = state.input
  if (!input || vecDlg.open) return // ignore a double-click while already open
  const seq = loadSeq // the input identity this preview belongs to
  // Open the modal SYNCHRONOUSLY, before any await: the `.open` guard above then
  // reliably rejects a rapid second click (which would otherwise race the reads
  // below and double-open). The canvas also gets its layout size up front.
  vecInfo.textContent = 'Reading gradients…'
  vecDlg.showModal()
  try {
    const [bvalText, bvecText] = await Promise.all([
      input.bval.text(),
      input.bvec.text(),
    ])
    if (seq !== loadSeq || !vecDlg.open) {
      if (vecDlg.open) vecDlg.close() // a newer DWI replaced the input mid-read
      return
    }
    const scheme = buildGradientScheme(bvalText, bvecText)
    loadedVecScheme = scheme
    vecInfo.classList.remove('error')
    showLoadedSchemeSummary(scheme)
    const viewer = await getVecViewer()
    if (seq !== loadSeq || !vecDlg.open) return
    await loadSchemePreview(
      viewer,
      buildLoadedPreview(scheme),
      Number(vecScale.value),
    )
  } catch (err) {
    loadedVecScheme = null
    vecDlg.close()
    setStatus(`Could not show vectors: ${(err as Error).message}`, true)
  }
}

// --- Diffusion vector-set generator ---
// Optimize uniform multi-shell directions (antipodal electrostatic repulsion),
// preview them in the shared connectome viewer, and save scanner vector files. A
// standalone tool — needs no loaded DWI.
let genScheme: GenScheme | null = null
// The editable shell list (directions × b-value). Rendered as rows in the modal.
// Defaults follow the √b rule (24@1000 → 33@2000); the middle shell density
// keeps SNR roughly constant across shells.
const genShells: ShellSpec[] = [
  { count: 24, bval: 1000 },
  { count: 33, bval: 2000 },
]

/** Redraw the shell-editor rows from `genShells`. */
function renderShellRows(): void {
  genVecShells.replaceChildren()
  genShells.forEach((sh, i) => {
    const row = document.createElement('div')
    row.className = 'nd-row'

    const count = document.createElement('input')
    count.type = 'number'
    count.min = '6'
    count.max = '500'
    count.step = '1'
    count.value = String(sh.count)
    count.title = 'Directions in this shell'
    count.addEventListener('input', () => {
      genShells[i].count = Math.max(6, Math.round(count.valueAsNumber || 6))
      scheduleGenerate()
    })

    const times = document.createElement('span')
    times.textContent = '×'

    const bval = document.createElement('input')
    bval.type = 'number'
    bval.min = '1'
    bval.max = '30000'
    bval.step = '100'
    bval.value = String(sh.bval)
    bval.title = 'b-value (s/mm²) for this shell'
    bval.addEventListener('input', () => {
      genShells[i].bval = Math.max(0, Math.round(bval.valueAsNumber || 0))
      scheduleGenerate()
    })

    row.append(count, times, bval)
    genVecShells.append(row)
  })
  // The paired "− Remove shell" button removes the last shell; never below one.
  genVecDelShell.disabled = genShells.length <= 1
}

// Auto-regenerate is debounced (rapid typing/slider drags collapse into one
// run) and coalesced (`genBusy`/`genPending`): a change arriving mid-run queues
// exactly one more pass with the latest settings, so overlapping GPU mesh loads
// never race on the shared viewer.
let genTimer: ReturnType<typeof setTimeout> | undefined
let genBusy = false
let genPending = false
let genRevision = 0

/** Debounced trigger for auto-regeneration after an input changes. Invalidates
 *  the current scheme + Save synchronously, so a click during the debounce can't
 *  download a DVS that disagrees with the edited form. */
function scheduleGenerate(): void {
  genRevision++
  cancelSchemeGeneration()
  genScheme = null
  genVecSaveBtn.disabled = true // re-enabled only when the new run completes
  genVecSavePhilipsBtn.disabled = true
  setSaveDatState(null)
  clearTimeout(genTimer)
  genTimer = setTimeout(() => void runGenerate(), 250)
}

/** Put the plotted scheme's description in the footer, with the active method
 * linked to its source/rationale. */
function showGeneratedSchemeSummary(scheme: GenScheme): void {
  const balancedLink = document.createElement('a')
  balancedLink.href =
    'https://fsl.fmrib.ox.ac.uk/fsl/docs/diffusion/eddy/index.html'
  balancedLink.target = '_blank'
  balancedLink.rel = 'noopener'
  balancedLink.textContent = 'Balanced sphere'
  const link = document.createElement('a')
  link.href =
    scheme.method === 'incremental'
      ? 'http://www.emmanuelcaruyer.com/q-space-sampling.php'
      : 'https://brainder.org/2025/05/05/15656/'
  link.target = '_blank'
  link.rel = 'noopener'
  link.textContent = methodLabel(scheme.method)
  genVecInfo.replaceChildren(
    document.createTextNode(`${scheme.dirs.length} volumes · `),
    balancedLink,
    document.createTextNode(' · '),
    link,
    document.createTextNode(
      ` · ${describeShells(scheme.shells)}, ${countB0(scheme)} b0`,
    ),
  )
}

/** Build the generator's render-only geometry. The optional antipodal mirror is
 * preview-only (`withAntipodalNodes`); mirrored nodes are absent from
 * `scheme.dirs`, so they can never reach the DVS. */
function buildGeneratedPreview(scheme: GenScheme): GradientScheme {
  const preview = buildSchemeFromSamples(scheme.dirs)
  return genVecShowAntipodal.checked ? withAntipodalNodes(preview) : preview
}

/** Refresh only the generator mesh after a visualization-option change. */
async function refreshGeneratedPreview(scheme: GenScheme): Promise<void> {
  try {
    const viewer = await getGenViewer()
    if (!genVecDlg.open || genScheme !== scheme) return
    await loadSchemePreview(
      viewer,
      buildGeneratedPreview(scheme),
      Number(genVecScale.value),
    )
  } catch (err) {
    if (genVecDlg.open && genScheme === scheme) {
      genVecInfo.classList.add('error')
      genVecInfo.textContent = `Could not update preview: ${(err as Error).message}`
    }
  }
}

/** Optimize the current settings and refresh the preview; coalesces re-entrant
 *  requests so the final run always reflects the latest inputs. */
async function runGenerate(): Promise<void> {
  if (genBusy) {
    genPending = true // fold this request into the run in flight
    return
  }
  genBusy = true
  try {
    do {
      genPending = false
      const revision = genRevision
      genVecInfo.classList.remove('error')
      genVecInfo.textContent = 'Generating…'
      if (!genVecDlg.open || revision !== genRevision) continue
      try {
        const scheme = await generateSchemeInWorker(genShells, {
          method: genVecSimultaneous.checked ? 'simultaneous' : 'incremental',
          alpha: Number(genVecAlpha.value),
          // Blank fields use the UI default; an explicit 0 means leading b0 only.
          b0Every: Math.round(num(genVecB0, DEFAULT_B0_EVERY, 0, 100)),
        })
        if (!genVecDlg.open || revision !== genRevision) continue
        // Build the preview straight from the structured scheme — scheme.dirs are
        // already unit directions + bval (no bval/bvec text round-trip).
        const preview = buildGeneratedPreview(scheme)
        const genViewer = await getGenViewer()
        if (!genVecDlg.open || revision !== genRevision) continue
        await loadSchemePreview(genViewer, preview, Number(genVecScale.value))
        if (!genVecDlg.open || revision !== genRevision) continue
        genScheme = scheme
        showGeneratedSchemeSummary(scheme)
        const metrics = measureScheme(scheme)
        console.info('Generated diffusion scheme QC', {
          method: methodLabel(scheme.method),
          volumes: scheme.dirs.length,
          b0: countB0(scheme),
          optimization: scheme.optimization,
          ...metrics,
        })
        const balanceWarnings = findPolarityBalanceWarnings(metrics)
        if (balanceWarnings.length > 0) {
          console.warn(
            'Generated diffusion scheme has unusually high per-shell polarity imbalance',
            balanceWarnings,
          )
        }
        genVecSaveBtn.disabled = false
        genVecSavePhilipsBtn.disabled = false
        setSaveDatState(scheme)
      } catch (err) {
        if (!genVecDlg.open || revision !== genRevision) continue
        genScheme = null
        genVecSaveBtn.disabled = true
        genVecSavePhilipsBtn.disabled = true
        setSaveDatState(null)
        genVecInfo.classList.add('error')
        genVecInfo.textContent = (err as Error).message
      }
    } while (genPending && genVecDlg.open)
  } finally {
    genBusy = false
  }
}

async function openGenVectors(): Promise<void> {
  if (genVecDlg.open) return // ignore a double-click while already open
  clearTimeout(genTimer) // cancel any debounce armed before the last close
  genVecDlg.showModal() // open first so the canvas has a layout size
  renderShellRows()
  await runGenerate() // generate immediately with the current settings
}

// --- Drag & drop ---
// Prevent the browser's default "navigate to dropped file" on the WHOLE window —
// a drop anywhere outside the canvas would otherwise blow away the app.
window.addEventListener('dragover', (e) => e.preventDefault())
window.addEventListener('drop', (e) => e.preventDefault())

const main = $<HTMLElement>('canvas-container')
main.addEventListener('dragover', () => dropOverlay.hidden = false)
main.addEventListener('dragleave', (e) => {
  // Only hide when the cursor actually leaves the container, not on child crossings.
  if (!main.contains(e.relatedTarget as Node))
    dropOverlay.hidden = true
})
main.addEventListener('drop', (e) => {
  void handleDrop(e as DragEvent)
})

function handleDrop(e: DragEvent): void {
  dropOverlay.hidden = true
  const dt = e.dataTransfer
  if (!dt) return
  // collectFiles must read dt.items synchronously (they expire after the event),
  // so call it now and let loadInputFiles await the result.
  void loadInputFiles(collectFiles(dt))
}

// File-picker fallback: drag-drop is finicky on touch / some Linux file
// managers / Safari folder-drop, so a plain <input type=file multiple> routes
// the same way (select a NIfTI+bval+bvec triple, or the DICOM files).
filePicker.addEventListener('change', () => {
  if (filePicker.files?.length) {
    void loadInputFiles(Promise.resolve(Array.from(filePicker.files)))
  }
  filePicker.value = '' // let the user re-pick the same files
})

/**
 * Claim identity for a load. Keep abort-before-increment centralized here so a
 * superseded dcm2niix worker cannot outlive the sequence that owns it.
 */
function beginLoad(): { seq: number; controller: AbortController } {
  inputAbortController?.abort(
    new DOMException('Superseded by a newer input.', 'AbortError'),
  )
  const controller = new AbortController()
  inputAbortController = controller
  return { seq: ++loadSeq, controller }
}

async function loadInputFiles(filesPromise: Promise<File[]>): Promise<void> {
  exampleControl?.cancel()
  const { seq, controller } = beginLoad()
  // A new load invalidates later workflow results.
  $('emptyState').hidden = false
  state.input = undefined
  state.maps = undefined
  state.tracts = undefined
  gotoTab(1)
  busy(true)
  setStatus('Loading…')
  try {
    const resolved = await resolveInput(await filesPromise, controller.signal)
    await loadInput(
      resolved,
      resolved.source,
      seq,
      resolved.source === 'dicom' ? 'DICOM → DWI' : 'DWI',
    )
  } catch (err) {
    if (seq === loadSeq) {
      if (err instanceof InputTooLargeError) showLargeInputDialog(err)
      setStatus((err as Error).message, true)
    }
  } finally {
    if (inputAbortController === controller) inputAbortController = null
    if (seq === loadSeq) busy(false)
  }
}

// --- NiiVue (WebGPU) ---
// Init inside try/catch: a browser without WebGPU throws here, and we want a
// clear message instead of a blank page with a stale "Loading…" status.
let nv: NiiVueGPU
// The drop/picker handlers are live before this finishes, and a user load during
// startup is now a SUPPORTED path (it suppresses the bundled sample), so the
// display path must wait for the attach + slice-type/render config below rather
// than racing it. `doSyncView` awaits this; the constructor itself is sync, so
// `nv` is assigned (no TDZ) even while the attach is pending.
let nvReady: Promise<void> = Promise.resolve()
try {
  nv = new NiiVueGPU({
    isDragDropEnabled: false, // we handle drops to preserve the workflow state
    backgroundColor: [0, 0, 0, 1],
    isSnapToVoxelCenters: true, // crisp V1 direction lines (per vox.modulate)
  })
  nvReady = (async () => {
    await nv.attachTo('gl1')
    nv.sliceType = SLICE_TYPE.MULTIPLANAR
    nv.showRender = SHOW_RENDER.AUTO
    // Live voxel readout in the footer (location + per-volume intensity).
    nv.addEventListener('locationChange', (loc) => {
      locationEl.textContent = (loc as { string?: string })?.string ?? ''
    })
  })()
  await nvReady
} catch (err) {
  setStatus(
    `WebGPU unavailable — dwi2trx needs a recent desktop Chrome or Edge. (${(err as Error).message})`,
    true,
  )
  throw err
}

/** Run mindgrab on the b0 → a binary brain mask on the DWI's own grid. `seq` is
 *  the input identity this mask belongs to; we bail if a newer input arrives so
 *  a superseded mask doesn't waste GPU work. Throws if mindgrab can't run here
 *  (no shader-f16, buffers too small); the caller then fits unmasked. */
async function makeBrainMask(
  input: NonNullable<typeof state.input>,
  seq: number,
): Promise<File | undefined> {
  setStatus('Brain extraction (mindgrab)…')
  const b0 = await cropB0Volume(input)
  if (seq !== loadSeq) return
  const { segment } = await import('@brainchop/mindgrab')
  // `worker: true` keeps the page responsive and is the only real cancellation.
  // `backend: 'webgpu'` because only that module is staged (see AGENTS.md);
  // `auto` could otherwise reach for a WebGL2 file this app doesn't ship.
  const { mask } = await segment(await b0.arrayBuffer(), {
    model: 'mindgrab',
    mask: true,
    worker: true,
    backend: 'webgpu',
    assetPath: `${import.meta.env.BASE_URL}brainchop/`,
  })
  if (seq !== loadSeq || !mask) return
  return new File([mask], 'mask.nii.gz')
}

// The input is already fully validated by resolveInput (volume count cross-
// checked against bval/bvec before we get here), so this just displays it.
async function loadInput(
  r: ResolvedInput,
  source: InputSource,
  seq: number,
  label: string,
): Promise<void> {
  if (seq !== loadSeq) return // superseded by a newer load
  $('emptyState').hidden = true
  state.input = { ...r, source }
  state.maps = undefined // new input invalidates any prior tensor fit
  state.tracts = undefined
  shownView = null // force the input view to (re)load through the chain
  gotoTab(1) // enables fitting and invalidates later results
  await syncView() // serialized canvas swap (not a bare nv.loadVolumes)
  if (seq !== loadSeq) return
  setStatus(
    `${label}: ${r.directions} volumes / directions. Press “Fit tensor”.`,
  )
}

// --- Stage 2: tensor fit + display ---

let fitting = false

async function runFit(): Promise<void> {
  const input = state.input
  if (!input || fitting) return // local guard: ignore a queued duplicate click
  const seq = loadSeq // the input identity this fit belongs to
  fitting = true
  maskFitBtn.disabled = true
  busy(true)
  setStatus('Fitting the diffusion tensor (niimath dtifit)…')
  try {
    // Brain-mask with mindgrab. Non-fatal: a GPU too small for the model throws
    // a BrainchopError, so fall back to an unmasked fit rather than failing the
    // whole tensor fit. A superseded input must not write the status line.
    const mask = await makeBrainMask(input, seq).catch((err: unknown) => {
      if (seq === loadSeq) {
        const why = (err as Error)?.message ?? String(err)
        setStatus(`Brain mask failed (${why}) — fitting without a mask.`)
      }
      return undefined
    })
    if (seq !== loadSeq) return
    const maps = await fitTensor(input, mask)
    if (seq !== loadSeq) return // a newer input superseded this fit — discard
    state.maps = maps
    state.tracts = undefined // a new fit invalidates the old TRX
    shownView = null // force showMaps to (re)load
    gotoTab(2) // reveal tensor maps
    await syncView()
    if (seq !== loadSeq) return // re-check: a new input may have arrived during the swap
    setStatus(
      `Tensor fit complete${mask ? ' (brain-masked)' : ''} — V1 modulated by FA.`,
    )
  } catch (err) {
    if (seq === loadSeq) {
      const msg = (err as Error)?.message ?? String(err)
      // A WebAssembly out-of-bounds / null-function / OOM here means the volume
      // exceeded the in-browser memory ceiling mid-fit (a sub-2 GB .nii.gz can
      // still decompress past it). Give the real cause, not the cryptic WASM string.
      const outOfMemory =
        /out of bounds|null function|out of memory|allocation failed|table index/i.test(
          msg,
        )
      setStatus(
        outOfMemory
          ? 'This dataset is too large for in-browser tensor fitting — a WebAssembly memory limit was reached. Try a cropped or lower-resolution acquisition, or a native pipeline.'
          : `Tensor fit failed: ${msg}`,
        true,
      )
    }
  } finally {
    fitting = false
    maskFitBtn.disabled = !state.input
    if (seq === loadSeq) busy(false) // don't clear a newer load/fit's spinner
  }
}

// --- Stage 3: WebGPU streamline tracking (Boot/OPDT) ---

let tracking = false

/** Track streamlines on the GPU from the fitted FA/DWI, write a TRX, show it
 *  over the FA in a clipped 3D render, then reveal its save action. Browser-only:
 *  needs WebGPU with `subgroups` (getTrackingDevice throws a clear reason if
 *  not). Seeds from FA ≥ 0.25, stops below FA 0.1. */
async function runTrack(): Promise<void> {
  const input = state.input
  const maps = state.maps
  if (!input || !maps || tracking) return
  const seq = loadSeq
  tracking = true
  trackBtn.disabled = true
  busy(true)
  setStatus('Generating streamlines (WebGPU)…')
  let device: GPUDevice | null = null
  try {
    const {
      getTrackingDevice,
      trackStreamlines,
      DEFAULT_PARAMS,
      isOomError,
      assembleTrackingInputs,
      seedsFromMask,
      loadSphere,
      writeTrx,
    } = await import('@dipy/gpu-streamlines')
    device = await getTrackingDevice() // throws a specific reason if unsupported
    const [sphere, bvalText, rawBvecText, header] = await Promise.all([
      loadSphere(),
      input.bval.text(),
      input.bvec.text(),
      readNiftiHeader(input.nifti),
    ])
    // FSL bvecs are radiological: dtifit negates x when the image is stored
    // neurologically (det > 0). The tracker works in voxel space, so give it
    // the same directions or its fibres mirror across x.
    const bvecText =
      det3(extractAffine(header)) > 0 ? flipBvecX(rawBvecText) : rawBvecText
    const {
      inputs: tInputs,
      voxelToRasmm,
      dims3,
    } = await assembleTrackingInputs(
      input.nifti,
      maps.fa,
      bvalText,
      bvecText,
      sphere,
      Math.min(
        device.limits.maxStorageBufferBindingSize,
        device.limits.maxBufferSize,
      ),
    )
    if (seq !== loadSeq) return
    // Tracking knobs from the UI (clamped to the input ranges).
    const MAX_SEEDS = 100000
    const seedFa = num(seedFaIn, 0.25, 0, 1)
    const density = Math.round(num(seedDensityIn, 1, 1, 4)) // whole seeds per axis
    const seeds = seedsFromMask(
      tInputs.metricMap,
      tInputs.dims,
      seedFa,
      density,
      MAX_SEEDS,
    )
    const nSeeds = seeds.length / 3
    if (nSeeds === 0) {
      setStatus(
        `No seed voxels with FA ≥ ${seedFa}. Lower the Seed FA threshold.`,
        true,
      )
      return
    }
    // The seed list is built in voxel order, so hitting the cap biases toward
    // one side of the brain — tell the user rather than silently truncating.
    const capped = nSeeds >= MAX_SEEDS
    const stepSize = num(stepSizeIn, 0.5, 0.1, 2)
    const params = {
      ...DEFAULT_PARAMS,
      tcThreshold: num(stopFaIn, 0.1, 0, 1),
      stepSize,
      maxAngle: (num(maxAngleIn, 60, 10, 90) * Math.PI) / 180,
      // Drop sub-streamline stubs: keep only tracts ≳ 5 voxels long (a 1-2 point
      // fragment is noise that bloats the TRX and clutters the render).
      minPts: Math.max(2, Math.ceil(5 / stepSize)),
    }
    const { lines, truncated, processedSeeds } = await trackStreamlines(
      device,
      tInputs,
      seeds,
      params,
      (done, total) => {
        if (seq === loadSeq)
          setStatus(
            `Tracking… ${done.toLocaleString()} / ${total.toLocaleString()} seeds`,
          )
      },
      () => seq !== loadSeq, // stop promptly if a new DWI was dropped mid-track
    )
    if (seq !== loadSeq) return
    if (lines.length === 0) {
      setStatus(
        'No streamlines survived — lower the Seed/Stop FA thresholds or the step size.',
        true,
      )
      return
    }
    const trxName = `${outputBase(input)}.trx`
    const totalPts = lines.reduce((s, l) => s + l.length / 3, 0)
    const meanLen = (totalPts / lines.length).toFixed(1)
    const count = lines.length.toLocaleString()
    state.tracts = new File([writeTrx(lines, voxelToRasmm, dims3)], trxName)
    // Free the voxel-space lines now that the TRX is serialized — the 3D preview
    // below allocates a large cylinder mesh, and there is no need to hold both.
    lines.length = 0
    const note = truncated
      ? ' PARTIAL (out of memory) — raise the Seed/Stop FA thresholds or lower Density for the full set.'
      : capped
        ? ' Seeds capped at 100,000 — lower Density for full coverage.'
        : ''
    const seedNote = truncated
      ? `${processedSeeds.toLocaleString()} of ${nSeeds.toLocaleString()} seeds`
      : `${nSeeds.toLocaleString()} seeds`
    const summary =
      `${count} streamlines from ${seedNote} ` +
      `(mean ${meanLen} pts) — saved as TRX.${note}`
    gotoTab(3)
    shownView = null // force the tract render to load
    // The TRX is already built and saveable. The 3D preview is separate: NiiVue
    // turns every streamline into a cylinder mesh (millions of vertices), which
    // can exhaust memory on a big tractogram even though the tracking itself
    // succeeded. Catch that so a render OOM doesn't masquerade as a tracking
    // failure and the user can still download their TRX.
    try {
      await syncView()
      if (seq !== loadSeq) return
      setStatus(summary)
    } catch (renderErr) {
      if (seq !== loadSeq) return
      console.warn('[dwi2trx] tract render failed:', renderErr)
      render() // keep “Save TRX” enabled (state.tracts is set)
      // Distinguish an out-of-memory preview (the expected failure on a huge
      // tractogram) from any other render error, so a real bug isn't mislabeled
      // as OOM. Either way the TRX is already built and downloadable.
      const msg = (renderErr as Error)?.message ?? String(renderErr)
      const oom = isOomError(renderErr)
      setStatus(
        oom
          ? `${summary} The 3D preview ran out of memory — click “Save TRX” to download it, or raise the Seed/Stop FA thresholds to render fewer streamlines.`
          : `${summary} The 3D preview failed (${msg}) — your TRX is saved; click “Save TRX” to download it.`,
        true,
      )
    }
  } catch (err) {
    if (seq === loadSeq)
      setStatus(
        `Streamline tracking failed: ${(err as Error).message} ` +
          '(hint: raise the Seed and Stop FA thresholds, or lower Density/step size, to use less memory).',
        true,
      )
  } finally {
    device?.destroy() // free the WebGPU device on every path (incl. errors)
    tracking = false
    trackBtn.disabled = false
    if (seq === loadSeq) busy(false) // don't clear a newer load/fit's spinner
  }
}

// Canvas swaps run one-at-a-time through this chain so two overlapping
// nv.loadVolumes() calls (rapid Back/Next, or a fit completing mid-nav) can't
// leave shownView disagreeing with what's actually on the canvas.
let viewChain: Promise<void> = Promise.resolve()

/** Load the volumes the current step should show, serialized + skipping redundant reloads. */
function syncView(): Promise<void> {
  viewChain = viewChain.then(doSyncView, doSyncView)
  return viewChain
}

async function doSyncView(): Promise<void> {
  // A drop can land while WebGPU is still initializing (the handlers are live
  // first). Wait for the attach + sliceType/showRender config before touching the
  // canvas, or that load renders against an unattached viewer with default
  // settings. Resolved after startup, so this is free on every later swap.
  await nvReady
  // A new input bumps loadSeq; a swap that finishes after that must NOT record
  // its (now-stale) view, or the string dedup would skip the new input's load.
  const seq = loadSeq
  if (state.step >= 3 && state.tracts) {
    if (shownView === 'tracts') return
    await showTracts(state.tracts)
    if (seq !== loadSeq) return
    shownView = 'tracts'
  } else if (state.step >= 2 && state.maps) {
    if (shownView === 'maps') return
    await clearTractScene()
    await showMaps(state.maps)
    if (seq !== loadSeq) return
    shownView = 'maps'
  } else if (state.input) {
    if (shownView === 'input') return
    await clearTractScene()
    await nv.loadVolumes([
      { url: state.input.nifti, name: state.input.nifti.name },
    ])
    if (seq !== loadSeq) return
    shownView = 'input'
  }
}

/** Tear down the 3D tract render (meshes, clip planes, render view) when
 *  returning to the 2D slice views. */
async function clearTractScene(): Promise<void> {
  if (nv.meshes.length) await nv.removeAllMeshes()
  nv.setClipPlanes([]) // slice type stays under the global View dropdown
}

/**
 * Tab 3: the tracked streamlines (TRX) over the FA volume, in a clipped 3D
 * render with direction-encoded colour — modelled on niivue's tract.groups
 * demo (clip planes + volume illumination so the FA slices show through).
 */
async function showTracts(trx: File): Promise<void> {
  if (state.maps) {
    await nv.loadVolumes([
      { url: state.maps.fa, name: 'FA.nii.gz', opacity: 1 },
    ])
  }
  nv.volumeIsV1SliceShader = false // plain FA backdrop, not the V1 colour shader
  await nv.loadMeshes([
    { url: trx, name: 'streamlines.trx', rgba255: TRACT_RGBA },
  ])
  if (nv.meshes.length) await applyFiberColor()
  nv.setClipPlanes([
    [0.1, 180, 20],
    [0.1, 0, -20],
  ])
  nv.volumeIllumination = 0.5 // slice type is the global View dropdown's choice
}

const TRACT_RGBA: [number, number, number, number] = [0, 142, 200, 255]

/** Apply the "Fiber color" dropdown to the loaded tract: local/global direction
 *  colouring, or a fixed colour. */
async function applyFiberColor(): Promise<void> {
  if (!nv.meshes.length) return // no tract loaded yet
  const mode = fiberColor.value
  await nv.setTractOptions(
    0,
    mode === 'fixed'
      ? { colorBy: 'fixed', fixedColor: TRACT_RGBA }
      : { colorBy: mode },
  )
}

/**
 * Display the principal eigenvector V1 as directionally-encoded colour,
 * modulated by FA — niivue's vox.modulate "V1 modulated by FA (isV1SliceShader)"
 * mode. Volume ORDER matters: FA must be volume 0, V1 (the 3-frame vector) must
 * be volume 1, both opacity 1. `volumeIsV1SliceShader` is what renders V1 as
 * colour rather than a grayscale 4D scalar.
 */
async function showMaps(maps: TensorMaps): Promise<void> {
  await nv.loadVolumes([
    { url: maps.fa, name: 'FA.nii.gz', opacity: 1 },
    { url: maps.v1, name: 'V1.nii.gz', opacity: 1 },
  ])
  nv.volumeIsNearestInterpolation = true // crisp V1 direction lines
  await applyDisplayMode() // honour the "Display" dropdown
  setFaFloor() // apply the initial slider value (volumes are the maps here)
}

/**
 * Apply the "Display" dropdown (FA / V1 / V1×FA / isV1SliceShader variants),
 * ported from niivue's vox.modulate demo. Operates on the loaded FA (volume 0)
 * + V1 (volume 1); self-guards so it's a no-op outside the maps view.
 */
async function applyDisplayMode(): Promise<void> {
  if (nv.volumes.length < 2) return // only meaningful for the FA+V1 maps
  const idx = Number(displayMode.value)
  const fa = nv.volumes[0]
  const v1 = nv.volumes[1]
  fa.opacity = idx === 0 || idx > 2 ? 1 : 0
  v1.opacity = idx === 0 ? 0 : 1
  const modulate = idx === 2 || idx === 4
  await nv.setModulationImage(v1.id ?? '', modulate ? (fa.id ?? '') : '')
  nv.volumeIsV1SliceShader = idx > 2
  nv.updateGLVolume()
}

/** Slider [0..100] → FA floor [0..1] on volume 0 (FA): hides low-anisotropy voxels. */
function setFaFloor(): void {
  const fa = nv.volumes[0]
  if (!fa) return
  fa.calMin = Number(faSlider.value) / 100
  fa.calMax = 1
  nv.updateGLVolume()
}

exampleControl = renderExampleSelector({
  examples,
  onLoad: async (_example, { fetchFiles, assertCurrent, signal }) => {
    const files = await fetchFiles()
    assertCurrent()
    const { seq, controller } = beginLoad()
    signal.addEventListener('abort', () => controller.abort(), { once: true })
    busy(true)
    try {
      const resolved = await resolveInput(files, controller.signal)
      assertCurrent()
      await loadInput(resolved, 'sample', seq, 'Example DWI')
      assertCurrent()
    } finally {
      if (inputAbortController === controller) inputAbortController = null
      if (seq === loadSeq) busy(false)
    }
  },
  onStatus: setStatus,
})
$('inputSection').querySelector('.nd-section-content')?.prepend(exampleControl.root)
window.addEventListener('pagehide', () => exampleControl?.destroy())
render()
