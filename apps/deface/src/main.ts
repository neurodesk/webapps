/**
 * deface — remove facial features from a brain MRI for anonymization, entirely
 * in the browser. No data leaves the machine.
 *
 * Pipeline: load a NIfTI (or DICOM folder via dcm2niix) → run niimath
 * `-deface` (AFNI-style affine registration of a bundled MNI template + face
 * mask, all BSD) → show + save the result. The default uses niimath's fast
 * registration engine (`-cost` implicit fast, Hellinger fallback); a slower,
 * exhaustive Hellinger variant is offered as `-cost hel`. All niimath I/O is
 * uncompressed (`-gz 0`) for speed — NiiVue re-gzips on Save.
 */

import NiiVueGPU, {
  type ImageFromUrlOptions,
  MULTIPLANAR_TYPE,
  SHOW_RENDER,
  SLICE_TYPE,
} from '@niivue/niivue'
import { mountImagingWorkspace } from '@neurodesk/webapp-components/core/mount-imaging-workspace'
import '@neurodesk/webapp-components/styles/base.css'
import { runDcm2niix, traverseDataTransferItems } from './dcm2niix/index'
import { Niimath } from './niimath'
import type { MindgrabInferer } from './mindgrab/index'

const ASSET_BASE_URL =
  'https://huggingface.co/datasets/sbollmann/neurodesk-webapps-assets/resolve/49b12b87f4e5def9672cf582b93ecd4a54273608/deface/'
const T1_URL = `${ASSET_BASE_URL}t1_crop.nii.gz`
const MNI_URL = `${ASSET_BASE_URL}avg152T1.nii.gz`
const MASK_URL = `${ASSET_BASE_URL}avg152T1mask.nii.gz`

mountImagingWorkspace({
  controls: 'body > header',
  viewer: '#canvas-container',
  status: 'body > footer',
  title: 'Deface',
  subtitle: 'Privacy-preserving MRI defacing in your browser',
  mark: 'D',
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
const methodSelect = $<HTMLSelectElement>('methodSelect')
const applyBtn = $<HTMLButtonElement>('applyBtn')
const saveBtn = $<HTMLButtonElement>('saveBtn')
const aboutBtn = $<HTMLButtonElement>('aboutBtn')
const aboutDialog = $<HTMLDialogElement>('aboutDialog')
const dicomPick = $<HTMLSelectElement>('dicomPick')
const webgpuDialog = $<HTMLDialogElement>('webgpuDialog')

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
// The original loaded/dropped source image, fed to niimath. Apply always defaces
// THIS (not the previous defaced output), so repeated Apply clicks or switching
// methods re-run on the pristine source rather than degrading an already-cropped,
// already-defaced image.
let sourceFile: File | null = null
// Bundled MNI template + face mask, fetched once and reused for every run.
let refFiles: { mni: File; mask: File } | null = null
// True once the CURRENTLY displayed volume is a defaced result. Save is gated on
// this so a user can't download the un-defaced source under the name defaced.nii.gz
// (a privacy footgun for an anonymization tool). Reset when a new source loads.
let hasDefaced = false

const niimath = new Niimath()
let niimathReady: Promise<void> | null = null
niimath.setOutputDataType('input') // preserve source datatype on save (smaller output)


// --- mindgrab (deep-learning brain extraction) ---
// Lazily loaded on first mindgrab Apply so the ~2500-line generated model + the
// conform worker stay out of the initial bundle. mindgrab needs WebGPU with
// shader-f16 even though the app itself can render on WebGL2; getBrainGPUDevice()
// returns null when that's unavailable, which gates the webgpuDialog.
let maskCtx: ExtCtx | null = null
let maskDevice: GPUDevice | null | undefined // undefined: untried; null: unavailable
let maskInferer: MindgrabInferer | null = null
let conformRegistered = false

async function getMaskInferer(): Promise<MindgrabInferer | null> {
  const { getBrainGPUDevice, loadMindgrab } = await import('./mindgrab/index')
  if (maskDevice === undefined) maskDevice = await getBrainGPUDevice()
  if (!maskDevice) return null
  if (!maskCtx) maskCtx = nv.createExtensionContext()
  if (!conformRegistered) {
    const { conform } = await import('./mindgrab/transforms')
    maskCtx.registerVolumeTransform(conform)
    conformRegistered = true
  }
  if (!maskInferer) {
    maskInferer = await loadMindgrab(
      maskDevice,
      `${ASSET_BASE_URL}models/net_mindgrab.safetensors`,
    )
  }
  return maskInferer
}

// Tear down mindgrab's GPU device + model buffers so the next Apply re-acquires a
// fresh one. Called on any mindgrab failure: a lost device or a model left in a bad
// state would otherwise make every retry fail until a page reload.
async function resetMaskGpu(): Promise<void> {
  try {
    await maskInferer?.dispose()
  } catch {
    // already gone / device lost
  }
  try {
    maskDevice?.destroy()
  } catch {
    // already gone
  }
  maskInferer = null
  maskDevice = undefined // re-request from getBrainGPUDevice() next time
}

// Run mindgrab on `src` (the MODEL input) → a brain mask in conformed (256³) space.
// Loads `src` onto the canvas (showing it during the slow inference) to get a parsed
// NVImage for the conform transform. `src` is the pristine source (conformed here by
// prepareInput) or, for robustfov, an already-conformed 256³ crop. The caller reslices
// the returned mask back onto the matching NATIVE-resolution image to keep input res.
async function makeBrainMask(inferer: MindgrabInferer, src: File): Promise<File> {
  setStatus('Brain extraction (mindgrab)…')
  // Fail closed: clear hasDefaced BEFORE displaying the un-defaced source, so even if
  // loadVolumes rejects mid-swap the source can never be saved as defaced.nii.gz
  // (privacy). It's re-enabled only when the final defaced result loads (asSource=false).
  hasDefaced = false
  updateButtons()
  await nv.loadVolumes([{ url: src, name: src.name } as ImageFromUrlOptions])
  if (isCleanedUp) throw new Error('cleaned up during mindgrab')
  const srcImg = nv.volumes[0]
  const { prepareInput, buildMaskNifti } = await import('./mindgrab/index')
  const { conformed, img32 } = await prepareInput(maskCtx!, srcImg)
  const [labels] = await inferer(img32)
  return new File([buildMaskNifti(conformed, labels)], 'maskconf.nii')
}

const listeners = new AbortController()
const ac = { signal: listeners.signal }

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

// --- Button gating ---
function updateButtons(): void {
  const busy = isBusy()
  applyBtn.disabled = busy || !sourceFile || !refFiles
  methodSelect.disabled = busy
  saveBtn.disabled = busy || !hasDefaced
  aboutBtn.disabled = false
}

// --- Serial task queue (load / drop / deface must not overlap) ---
let pending: Promise<unknown> = Promise.resolve()
let inFlightCount = 0
function isBusy(): boolean {
  return inFlightCount > 0
}
function enqueue(fn: () => Promise<unknown>): void {
  if (isCleanedUp) return
  inFlightCount++
  updateButtons()
  pending = pending
    .then(fn)
    .catch((err: unknown) => {
      const msg = err instanceof Error ? err.message : String(err)
      setStatus(`Failed: ${msg}`)
      console.error('deface task failed', err)
    })
    .finally(() => {
      inFlightCount--
      updateButtons()
    })
}

async function ensureNiimath(): Promise<void> {
  if (!niimathReady) niimathReady = niimath.init().then(() => undefined)
  await niimathReady
}

// After a failed/aborted niimath run (incl. OOM, which the WASM allocators bail on
// via longjmp), the worker's WASM heap and Emscripten MEMFS may be in an undefined
// state. Tear the worker down and clear niimathReady so the next run spins up a
// fresh one rather than reusing leaked/stale state. (Uses the same field access as
// cleanup(); the vendored wrapper exposes no public terminate.)
function resetNiimathWorker(): void {
  try {
    ;(niimath as unknown as { worker?: Worker }).worker?.terminate()
    ;(niimath as unknown as { worker: Worker | null }).worker = null
  } catch {
    // worker may already be gone
  }
  niimathReady = null
}

async function fetchFile(url: string, name: string): Promise<File> {
  const res = await fetch(url)
  if (!res.ok) throw new Error(`fetch ${name} failed: ${res.status}`)
  return new File([await res.blob()], name)
}

// --- Load ---
// asSource=true for user-supplied images (default/drop/dcm2niix pick) — these
// become the pristine input that Apply defaces. The defaced result is displayed
// with asSource=false so it never replaces the source.
async function loadFromFile(file: File, asSource = true): Promise<void> {
  // Fail closed: a source (asSource=true) is un-defaced, so clear Save eligibility
  // BEFORE the awaitable display — a load rejection after a prior deface must not
  // leave Save enabled over the un-defaced image (same pattern as makeBrainMask).
  if (asSource) {
    hasDefaced = false
    updateButtons()
  }
  try {
    await nv.loadVolumes([{ url: file, name: file.name } as ImageFromUrlOptions])
  } catch (err) {
    // A failed source load can leave the canvas blank/partial. Drop sourceFile so Apply
    // can't target a stale source that no longer matches the display (display/sourceFile
    // divergence). Rethrow so enqueue() still reports the failure.
    if (asSource) {
      sourceFile = null
      updateButtons()
    }
    throw err
  }
  if (isCleanedUp) return
  if (asSource) sourceFile = file
  // A freshly loaded source is NOT yet defaced; a deface result (asSource=false) is.
  hasDefaced = !asSource
  updateButtons()
}

// --- Deface ---
async function runDeface(): Promise<void> {
  if (!sourceFile || !refFiles) return
  const method = methodSelect.value // allineate | allineate_robustfov | allineate_hel | mindgrab[_robust][8]

  // mindgrab needs WebGPU + shader-f16; if unavailable, explain rather than fail.
  if (method.startsWith('mindgrab')) {
    // Two independent knobs encoded in the method name:
    // - `8` suffix: keep an 8 mm shell of tissue around the brain (brainchop-cli's
    //   `-close 1 8 0` grow) instead of a tight skull-strip; the face, far from the
    //   brain, is still removed.
    // - `robust`: run the WHOLE pipeline on a `-robustfov`-cropped copy. robustfov
    //   changes the image extent (drops inferior slices); feeding the pristine source
    //   to conform but reslicing/masking against the cropped one would mix coordinate
    //   spaces and corrupt the mask — so crop first and use that single image throughout.
    const borderMm = method.endsWith('8') ? 8 : 0
    const useRobustfov = method.includes('robust')
    spin(true)
    // First-use model fetch + WebGPU pipeline compile is the heaviest setup; show
    // busy feedback before it (the UI is already disabled by enqueue()).
    setStatus('Loading mindgrab model…')
    const t0 = performance.now()
    try {
      // Acquire INSIDE the try so a loadMindgrab failure (model fetch, pipeline
      // compile, device-loss during load) hits resetMaskGpu() in the catch. The
      // unavailable-device case returns null (not a throw) → dialog, no reset.
      const inferer = await getMaskInferer()
      if (!inferer) {
        webgpuDialog.showModal()
        setStatus('mindgrab needs WebGPU (shader-f16) — try an allineate method.')
        return
      }
      await ensureNiimath()
      if (isCleanedUp) return
      // mindgrab segments in conformed 256³ 1 mm space, but — like the allineate deface —
      // the output should be at the INPUT resolution (e.g. 0.75 mm), cropped if robustfov
      // is used. So split the two roles (mirrors brainchop's `-i` inverse):
      //   srcNative → the reslice/mul target: native resolution (robustfov-cropped if set)
      //   srcModel  → the model input: must be conformed 256³ 1 mm
      // For robustfov both derive from one `-robustfov` crop so they share a world frame;
      // the conformed-space mask then reslices back onto srcNative exactly at native res
      // (verified). robustfov drops inferior slices, so its crop is no longer 256³ — feeding
      // it straight to the model would route prepareInput through the niivue conform worker
      // (which mishandled the cropped geometry); `-conform` restores the exact 256³ canonical
      // the model expects, which prepareInput's isConformed fast-path then uses directly.
      // gz(0): niimath reads/writes uncompressed .nii (no per-run gzip/gunzip) — faster
      // round trips. The blobs stay in-memory (NiiVue re-gzips only the final Save).
      const srcNative = useRobustfov
        ? new File(
            [await niimath.image(sourceFile).gz(0).robustfov().run('robustfov.nii')],
            'robustfov.nii',
          )
        : sourceFile
      if (isCleanedUp) return
      const srcModel = useRobustfov
        ? new File(
            [await niimath.image(srcNative).gz(0).conform().run('robustfov_conf.nii')],
            'robustfov_conf.nii',
          )
        : sourceFile
      if (isCleanedUp) return
      const maskConf = await makeBrainMask(inferer, srcModel)
      if (isCleanedUp) return
      // Reslice the conformed brain mask onto srcNative's grid (nearest-neighbour → back
      // to native resolution), then multiply srcNative by it so only brain voxels survive
      // — face and skull are zeroed. For an N mm border, grow the mask with `-close 1 N 0`
      // (binarize at 1, dilate N mm, erode 0) instead of a plain `-bin`. Two serial niimath
      // runs: the mask is primary for the reslice; srcNative is primary for the multiply so
      // the output keeps its datatype (-odt input).
      const resliced = niimath.image(maskConf).gz(0).resliceNN(srcNative)
      const grown = borderMm > 0 ? resliced.close(1, borderMm, 0) : resliced.bin()
      const maskNat = new File([await grown.run('masknat.nii')], 'masknat.nii')
      if (isCleanedUp) return
      const blob = await niimath.image(srcNative).gz(0).mulImage(maskNat).run('defaced.nii')
      if (isCleanedUp) return
      await loadFromFile(new File([blob], 'defaced.nii'), false)
      const tag = `${useRobustfov ? 'robustfov + ' : ''}${borderMm > 0 ? `${borderMm} mm border` : 'tight'}`
      setStatus(`Brain-extracted with mindgrab (${tag}) (${Math.round(performance.now() - t0)} ms)`)
    } catch (err) {
      // A failed run can corrupt the niimath heap and/or leave the GPU device in a
      // bad state; reset both so the next Apply starts clean. Rethrow so enqueue()
      // still reports "Failed: …".
      resetNiimathWorker()
      await resetMaskGpu()
      throw err
    } finally {
      spin(false)
      updateButtons()
    }
    return
  }

  // Two orthogonal knobs in the method slug: `_robustfov` crops (neck/inferior) first,
  // `_hel` picks the exhaustive Hellinger engine (`-cost hel`) over the fast default.
  // Anchor `_hel` (not `hel`) so a slug like `allineate_shell` can't misroute.
  const useRobustfov = method.includes('robustfov')
  const useHel = method.includes('_hel')
  const label = `allineate (${useHel ? 'Hellinger' : 'fast'}${useRobustfov ? ', robustfov' : ''})`
  spin(true)
  // Hellinger is single-threaded in WASM (no OpenMP) and runs an exhaustive search, so it
  // is minutes on a full-head scan; set the expectation so a slow run doesn't look hung.
  setStatus(
    `Defacing with ${label}… (${useHel ? 'Hellinger, single-threaded — up to a few minutes' : 'fast ~5 s'})`,
  )
  const t0 = performance.now()
  try {
    await ensureNiimath()
    if (isCleanedUp) return
    // Register the bundled MNI template to the subject and zero the face voxels.
    // Always run on the pristine sourceFile so repeated Apply doesn't re-deface an
    // already-cropped/defaced output. gz(0): uncompressed .nii I/O for speed (NiiVue
    // re-gzips only on Save). `-cost hel` picks the exhaustive engine; omitting -cost
    // uses the fast default (with Hellinger fallback on degenerate inputs).
    const base = niimath.image(sourceFile).gz(0)
    const chain = useRobustfov ? base.robustfov() : base
    const opts = useHel ? ['-cost', 'hel'] : []
    const defaced = chain.deface(refFiles.mni, refFiles.mask, opts)
    const blob = await defaced.run('defaced.nii')
    if (isCleanedUp) return
    const out = new File([blob], 'defaced.nii')
    await loadFromFile(out, false) // display result; keep sourceFile pristine
    const ms = Math.round(performance.now() - t0)
    setStatus(`Defaced with ${label} (${ms} ms)`)
  } catch (err) {
    // A failed/OOM run can leave the worker's WASM heap + MEMFS corrupt; recreate
    // it before the next Apply so a retry starts clean. Rethrow so enqueue() still
    // reports "Failed: …".
    resetNiimathWorker()
    throw err
  } finally {
    spin(false)
    updateButtons()
  }
}

// --- Save ---
async function runSave(): Promise<void> {
  // Runtime guard, not just the disabled button: never serialize the un-defaced
  // source (privacy), and don't race an in-flight run. Surface failures via status
  // rather than dropping the promise at the listener (() => void runSave()).
  if (!hasDefaced || isBusy() || nv.volumes.length === 0) return
  try {
    await nv.saveVolume({ filename: 'defaced.nii.gz', volumeByIndex: 0 })
  } catch (err) {
    setStatus(`Save failed: ${err instanceof Error ? err.message : String(err)}`)
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
    // Fast-path a single obvious volume file straight to NiiVue.
    if (files.length === 1 && DIRECT_VOLUME_RE.test(files[0].name)) {
      dcmConverted = []
      dicomPick.classList.add('hidden')
      setStatus(`Loading ${files[0].name}…`)
      await loadFromFile(files[0])
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
    } else {
      dcmConverted = []
      dicomPick.classList.add('hidden')
      setStatus(`dcm2niix: 1 NIfTI in ${ms} ms — loading…`)
    }
    await loadFromFile(niftiFiles[0])
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
  // every WebGPU-unavailable path. (mindgrab's stricter shader-f16 requirement is a
  // separate gate via #webgpuDialog.)
  const noWebGpu =
    'This browser/GPU can’t initialize WebGPU — deface needs a recent desktop Chrome, Edge, or Safari.'
  if (!navigator.gpu) {
    setStatus(noWebGpu)
    return
  }
  try {
    await attachNiiVue()
  } catch (err) {
    // Almost always genuine WebGPU unavailability; warn (not error, so the smoke's
    // console.error gate stays meaningful) so a non-WebGPU init bug isn't silently
    // mislabeled. Either way return fail-closed: sourceFile/refFiles stay unset.
    console.warn('deface: WebGPU init failed', err)
    setStatus(noWebGpu)
    return
  }
  setStatus('Loading default image + MNI template…')
  // Fetch the bundled template/mask once; load the default subject.
  const [mni, mask] = await Promise.all([
    fetchFile(MNI_URL, 'MNI152_T1_2mm.nii.gz'),
    fetchFile(MASK_URL, 'mniMask.nii.gz'),
  ])
  refFiles = { mni, mask }
  const t1 = await fetchFile(T1_URL, 't1_crop.nii.gz')
  await loadFromFile(t1)
  setStatus('Ready — choose a method and click Apply.')
}

// --- Wiring ---
document.addEventListener('dragover', (e) => e.preventDefault(), ac)
document.addEventListener(
  'drop',
  (e) => {
    e.preventDefault()
    const items = e.dataTransfer?.items
    if (!items || items.length === 0) return
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
    if (file) enqueue(() => loadFromFile(file))
  },
  ac,
)
applyBtn.addEventListener('click', () => enqueue(runDeface), ac)
saveBtn.addEventListener('click', () => void runSave(), ac)
aboutBtn.addEventListener('click', () => aboutDialog.showModal(), ac)

// --- Cleanup (HMR / tab close) ---
async function cleanup(): Promise<void> {
  if (isCleanedUp) return
  isCleanedUp = true
  listeners.abort()
  // Terminate the niimath worker FIRST (don't await `pending`): an in-flight run is one
  // uninterruptible WASM call — a Hellinger fit would stall teardown for minutes. The
  // terminated run never resolves, so we deliberately drop the await; any run that already
  // resolved hits `if (isCleanedUp) return` before touching nv/ctx.
  try {
    ;(niimath as unknown as { worker?: Worker }).worker?.terminate()
  } catch {
    // worker may already be gone
  }
  // Release mindgrab's GPU model buffers + device (~1.4 GB) and its conform worker
  // + extension context, if it ever loaded. The NiiVue context disposal below does
  // not own the conform worker, so terminate it explicitly. Each step is isolated:
  // this runs during HMR/page teardown, so one failure must not skip the rest.
  try {
    await maskInferer?.dispose()
  } catch {
    // already gone / device lost
  }
  try {
    maskDevice?.destroy()
  } catch {
    // already gone
  }
  if (conformRegistered) {
    try {
      const { disposeConformWorker } = await import('./mindgrab/transforms')
      disposeConformWorker()
    } catch {
      // module/import may be unavailable during teardown
    }
  }
  try {
    maskCtx?.dispose()
  } catch {
    // best-effort
  }
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

updateButtons()
enqueue(init)
