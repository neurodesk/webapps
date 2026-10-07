import examples from '../examples.json'
import { createExampleSelector } from '@neurodesk/webapp-components/ui'
import '@neurodesk/webapp-components/styles/imaging-workspace.css'
import { mountImagingWorkspace } from '@neurodesk/webapp-components/core/mount-imaging-workspace'
import { bindFileDrop, createInfoDialog, createConsole, createViewerToolbar } from '@neurodesk/webapp-components/ui'
import { runDcm2niix, readImageFiles } from '@neurodesk/runtime-support/dcm2niix-client'
import NiiVueGPU, { SLICE_TYPE } from '@niivue/niivue'
import mindsnapColormap from './mindsnap-colormap.json'
import { registerAppAutomation, registerViewer, createNiivueAdapter } from '@neurodesk/webapp-components/automation'
import { buildMesh, meshFiles, segmentBrain } from '@neurodesk/brain2print'
import { createNiimathMesher, mindgrab } from '@neurodesk/brain2print/browser'
import { writeMz3 } from '@neurodesk/webapp-components/file-io/mesh'
import { APP } from './config.js'

const $ = (id) => document.getElementById(id)
const directVolume = /\.(nii|nii\.gz|mgh|mgz|nrrd|mha|mhd|nhdr|head|v)$/i
const SEG_COLORMAP = {
  R: [0, 245, 205, 120, 196, 220, 230, 0, 122, 236, 12, 204, 42, 119, 220, 103, 255, 165],
  G: [0, 245, 62, 18, 58, 248, 148, 118, 186, 13, 48, 182, 204, 159, 216, 255, 165, 42],
  B: [0, 245, 78, 134, 250, 164, 34, 14, 220, 176, 255, 142, 164, 176, 20, 255, 0, 42],
  labels: ['Unknown', 'Cerebral-White-Matter', 'Cerebral-Cortex', 'Lateral-Ventricle', 'Inferior-Lateral-Ventricle', 'Cerebellum-White-Matter', 'Cerebellum-Cortex', 'Thalamus', 'Caudate', 'Putamen', 'Pallidum', '3rd-Ventricle', '4th-Ventricle', 'Brain-Stem', 'Hippocampus', 'Amygdala', 'Accumbens-area', 'VentralDC'],
  I: [...Array(18).keys()],
  A: [0, ...Array(17).fill(255)],
}
// mindsnap's 104 Desikan-Killiany labels, from github.com/niivue/browserqc.
const MINDSNAP_COLORMAP = { ...mindsnapColormap, I: [...Array(104).keys()], A: [0, ...Array(103).fill(255)] }

let viewerReady = false
let source = null
let segmentation = null
let series = []
let busy = false
let extension = null

mountImagingWorkspace({
  controls: '#controls',
  viewer: '#viewer',
  status: '#status',
  title: 'Brain2Print',
  subtitle: 'Create printable brain meshes in your browser',
  mark: 'B',
  controlsContract: { about: '#aboutBtn', privacy: '#privacyBtn' },
})
const log = createConsole({ id: 'technicalLog' })
$('viewer').append(log)
const info = createInfoDialog()
$('aboutBtn').onclick = () => info.open('About Brain2Print', $('aboutContent'))
$('privacyBtn').onclick = () => info.open('Privacy', $('privacyContent'))
const nv = new NiiVueGPU({ isDragDropEnabled: false, backgroundColor: [0, 0, 0, 1] })
const niimath = createNiimathMesher()
const toolbar = createViewerToolbar({
  window: false,
  overlay: false,
  colormap: false,
  download: false,
  screenshot: false,
  views: [['slices', 'Slices', SLICE_TYPE.MULTIPLANAR], ['render', '3D', SLICE_TYPE.RENDER]].map(([id, label, type], index) => ({
    id,
    label,
    active: index === 0,
    onClick: () => {
      if (!viewerReady) return
      nv.sliceType = type
      nv.drawScene()
      toolbar.setActive(id)
    },
  })),
})
$('viewer').prepend(toolbar)

function status(message, error = false) {
  $('statusText').textContent = message
  $('statusText').classList.toggle('error', error)
  log.log(message, error ? 'error' : 'info')
}

function buttons() {
  exampleControl.setDisabled(busy || !viewerReady)
  for (const id of ['imageInput', 'folderInput', 'seriesSelect', 'modelSelect']) $(id).disabled = busy || !viewerReady
  $('segmentButton').disabled = busy || !source
  $('meshButton').disabled = busy || !segmentation
  $('downloadButton').disabled = busy || !nv.meshes.length
  // No stage reports a fraction, so the bar is indeterminate while working.
  if (busy) $('progress').removeAttribute('value')
  else $('progress').value = 0
}

// The rc.11 controller has no single-volume removal (removeVolume is internal to its model); reloading the base image alone drops the overlays.
async function dropOverlays() {
  if (nv.volumes.length > 1) await nv.loadVolumes([nv.volumes[0]])
}

async function clearMeshes() {
  while (nv.meshes.length) await nv.removeMesh(0)
}

async function loadImage(file, signal) {
  if (busy) return
  busy = true
  buttons()
  try {
    status(`Loading ${file.name}…`)
    source = null
    segmentation = null
    $('outputSection').open = false
    await clearMeshes()
    await nv.loadVolumes([{ url: file, name: file.name }])
    signal?.throwIfAborted()
    source = file
    segmentation = null
    $('emptyState').hidden = true
    status(`${file.name} loaded`)
    return true
  } catch (error) {
    status(error instanceof Error ? error.message : String(error), true)
  } finally {
    busy = false
    buttons()
  }
}

async function chooseFiles(files) {
  if (!viewerReady) return
  if (busy) return status('Wait for the current step to finish before loading another image.', true)
  exampleControl.cancel()
  busy = true
  buttons()
  try {
    status('Reading image files…')
    const converted = await readImageFiles(files, { directVolume })
    if (!converted.length) throw new Error('Choose a NIfTI image or a complete DICOM series.')
    series = converted
    $('seriesSelect').replaceChildren(...series.map((file, index) => new Option(file.name, String(index))))
    $('seriesSelect').classList.toggle('hidden', series.length < 2)
  } catch (error) {
    return status(error instanceof Error ? error.message : String(error), true)
  } finally {
    busy = false
    buttons()
  }
  await loadImage(series[0])
}

// MindGrab and the command line read NIfTI as stored; other formats go through NiiVue's NIfTI writer.
async function segmentationInput(file) {
  if (/\.nii(\.gz)?$/i.test(file.name)) return new Uint8Array(await file.arrayBuffer())
  const input = await nv.saveVolume({ volumeByIndex: 0, filename: '' })
  if (!(input instanceof Uint8Array)) throw new Error('Could not read the input image.')
  return input
}

async function segment({ signal, progress = () => {}, backend = 'auto' } = {}) {
  if (!source || busy) throw new Error('Load an image and wait for the current step to finish.')
  signal?.throwIfAborted()
  const image = source
  busy = true
  buttons()
  try {
    segmentation = null
    $('outputSection').open = false
    await clearMeshes()
    await dropOverlays()
    status(`Segmenting with ${$('modelSelect').selectedOptions[0].text}…`)
    const input = await segmentationInput(image)
    const choice = $('modelSelect').value
    progress({ message: 'Segmenting brain tissues' })
    const result = await segmentBrain(mindgrab, input, choice, {
      worker: true,
      // The worker resolves `auto` (backend.js in @neurodesk/brain2print): hardware WebGPU, hardware WebGL2, then threaded CPU; automation may name `cpu`.
      backend,
      assetPath: `${import.meta.env.BASE_URL}brainchop/${mindgrab.version}/`,
      signal,
    })
    signal?.throwIfAborted()
    if (source !== image) throw new Error('The image changed during segmentation; run it again.')
    await dropOverlays()
    const overlay = new File([result.bytes], result.name)
    if (choice === 'pve') {
      // calMin 0.5 shows exactly what the mesh encloses.
      await nv.addVolume({ url: overlay, name: result.name, opacity: 0.5, colormap: 'warm', calMin: 0.5, calMax: 1 })
    } else {
      await nv.addVolume({ url: overlay, name: result.name, opacity: 0.5 })
      await nv.setColormapLabel(nv.volumes.length - 1, choice === 'mindsnap' ? MINDSNAP_COLORMAP : SEG_COLORMAP)
    }
    signal?.throwIfAborted()
    // What the mesh step surfaces at 0.5: the brain fraction, or the binary mask of the labels.
    segmentation = result.surface
    status(`Segmentation complete on ${result.provenance.backend} (${Math.round(result.provenance.elapsedMs)} ms). Create the mesh when ready.`)
    return { file: overlay, type: result.type, provenance: result.provenance }
  } catch (error) {
    status(error instanceof Error ? error.message : String(error), true)
    throw error
  } finally {
    busy = false
    buttons()
  }
}

async function mesh({ signal, progress = () => {} } = {}) {
  if (!segmentation || busy) throw new Error('Segment an image and wait for the current step to finish.')
  signal?.throwIfAborted()
  const labels = segmentation
  busy = true
  buttons()
  try {
    // Read before awaiting so edits made during niimath startup do not leak into this run.
    const settings = {
      largestOnly: $('largestOnly').checked,
      fillBubbles: $('fillBubbles').checked,
      simplify: Number($('simplify').value),
      smooth: Number($('smooth').value),
    }
    status('Creating mesh with niimath…')
    progress({ message: 'Creating brain mesh' })
    const result = await buildMesh((bytes, options) => niimath.mesh(bytes, options, signal), labels, settings)
    signal?.throwIfAborted()
    if (segmentation !== labels) throw new Error('The segmentation changed during meshing; run it again.')
    await clearMeshes()
    await nv.loadMeshes([{ url: new File([writeMz3(result.positions, result.indices)], 'brain.mz3'), name: 'brain.mz3' }])
    signal?.throwIfAborted()
    $('outputSection').open = true
    const { triangles, windingCorrected } = result.measurements
    status(`Mesh complete: ${triangles} triangles, ${result.closed ? 'closed manifold' : 'non-manifold'}, ${windingCorrected ? 'winding corrected' : 'winding preserved'}. Choose STL or OBJ to download.`)
    const artifacts = meshFiles(result).map(({ role, name, bytes }) => ({ role, file: new File([bytes], name) }))
    return { artifacts, measurements: result.measurements, provenance: result.provenance }
  } catch (error) {
    status(error instanceof Error ? error.message : String(error), true)
    throw error
  } finally {
    busy = false
    buttons()
  }
}


$('imageInput').addEventListener('change', () => {
  const files = Array.from($('imageInput').files)
  $('imageInput').value = ''
  if (files.length) void chooseFiles(files)
})
$('folderInput').addEventListener('change', () => {
  const files = Array.from($('folderInput').files)
  $('folderInput').value = ''
  if (files.length) void chooseFiles(files)
})
$('seriesSelect').addEventListener('change', () => void loadImage(series[Number($('seriesSelect').value)]))
$('simplify').addEventListener('input', () => { $('simplifyValue').textContent = `${$('simplify').value}%` })
$('modelSelect').addEventListener('change', () => {
  // A segmentation belongs to the model that made it; mesh only what the picker shows.
  segmentation = null
  buttons()
})
$('smooth').addEventListener('input', () => { $('smoothValue').textContent = $('smooth').value })
$('segmentButton').addEventListener('click', () => void segment().catch(() => {}))
$('meshButton').addEventListener('click', () => void mesh().catch(() => {}))
$('downloadButton').addEventListener('click', () => void nv.saveMesh(0, `brain2print.${$('format').value}`))
bindFileDrop($('dropZone'), (files) => files.then(chooseFiles).catch((error) => status(error instanceof Error ? error.message : String(error), true)))

const exampleControl = createExampleSelector({
  examples,
  onLoad: async (_example, { fetchFiles, assertCurrent, signal }) => {
    if (!viewerReady) throw new Error('The WebGPU viewer is not ready.');
    const files = await fetchFiles();
    assertCurrent();
    if (!await loadImage(files[0], signal)) throw new Error('The example image could not be loaded.');
    assertCurrent();
  },
  onStatus: status,
});
$('controls').querySelector('.nd-section-content').prepend(exampleControl);

async function init() {
  if (!navigator.gpu) return status('Brain2Print requires a recent WebGPU-capable desktop browser.', true)
  try {
    await nv.attachTo('gl1')
  } catch {
    return status('This browser or GPU cannot initialize WebGPU.', true)
  }
  viewerReady = true
  buttons()
  nv.isLegendVisible = false
  extension = nv.createExtensionContext()
  extension.on('locationChange', (event) => { $('location').textContent = event.detail.string })
  status('Ready · choose an example or upload a brain MRI.')
}

window.addEventListener('pagehide', () => {
  exampleControl.destroy()
  niimath.dispose('page closed')
  extension?.dispose()
  nv.destroy()
}, { once: true })
buttons()
const initialization = init()

export default Object.freeze({ APP, chooseFiles, segment, mesh })


registerAppAutomation({
  app: 'brain2print',
  convertDicom: runDcm2niix,
  operations: {
    'create-mesh': async ({ inputs, parameters, signal, progress }) => {
      await initialization
      signal.throwIfAborted()
      if (!viewerReady) throw new Error('The WebGPU viewer is unavailable.')
      if (busy) throw new Error('Wait for the current step to finish.')
      exampleControl.cancel()
      if (!await loadImage(inputs.image[0], signal)) throw new Error('The image could not be loaded.')
      $('modelSelect').value = parameters.model
      $('simplify').value = parameters.simplify
      $('simplifyValue').textContent = `${parameters.simplify}%`
      $('smooth').value = parameters.smooth
      $('smoothValue').textContent = String(parameters.smooth)
      $('largestOnly').checked = parameters.largestOnly
      $('fillBubbles').checked = parameters.fillBubbles
      const segmented = await segment({ signal, progress, backend: parameters.backend })
      const meshed = await mesh({ signal, progress })
      return { artifacts: [{ role: 'segmentation', file: segmented.file, type: segmented.type }, ...meshed.artifacts], measurements: meshed.measurements, provenance: { segmentation: segmented.provenance, meshing: meshed.provenance } }
    },
  },
})
registerViewer('image', createNiivueAdapter(nv, {
  tabs: {
    list: () => [{ id: 'slices', label: 'Slices', active: nv.sliceType === SLICE_TYPE.MULTIPLANAR }, { id: 'render', label: '3D', active: nv.sliceType === SLICE_TYPE.RENDER }],
    select: (id) => {
      nv.sliceType = id === 'render' ? SLICE_TYPE.RENDER : SLICE_TYPE.MULTIPLANAR
      nv.drawScene()
      toolbar.setActive(id)
    },
  },
  regions: { list: () => !segmentation || $('modelSelect').value === 'pve' ? [] : ($('modelSelect').value === 'mindsnap' ? MINDSNAP_COLORMAP : SEG_COLORMAP).labels.map((name, id) => ({ id: String(id), name })) },
}))
