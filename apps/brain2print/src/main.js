import examples from '../examples.json'
import { createExampleSelector } from '@neurodesk/webapp-components/ui'
import '@neurodesk/webapp-components/styles/imaging-workspace.css'
import { mountImagingWorkspace } from '@neurodesk/webapp-components/core/mount-imaging-workspace'
import { bindFileDrop, createInfoDialog, createConsole, createViewerToolbar } from '@neurodesk/webapp-components/ui'
import { readImageFiles } from '@neurodesk/runtime-support/dcm2niix-client'
import NiiVueGPU, { SLICE_TYPE } from '@niivue/niivue'
import { Niimath } from '@niivue/niimath'
import { APP } from './config.js'
import { flipWinding, inspectMesh } from './mesh.js'

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

let viewerReady = false
let source = null
let segmentation = null
let series = []
let busy = false
let niimathReady = null
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
const niimath = new Niimath()
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
  for (const id of ['imageInput', 'folderInput', 'seriesSelect']) $(id).disabled = busy || !viewerReady
  $('segmentButton').disabled = busy || !source
  $('meshButton').disabled = busy || !segmentation
  $('downloadButton').disabled = busy || !nv.meshes.length
  // No stage reports a fraction, so the bar is indeterminate while working.
  if (busy) $('progress').removeAttribute('value')
  else $('progress').value = 0
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

async function segment() {
  if (!source || busy) return
  const image = source
  busy = true
  buttons()
  try {
    segmentation = null
    $('outputSection').open = false
    await clearMeshes()
    while (nv.volumes.length > 1) await nv.removeVolume(1)
    status('Segmenting with MindGrab…')
    const input = await nv.saveVolume({ volumeByIndex: 0, filename: '' })
    if (!(input instanceof Uint8Array)) throw new Error('Could not read the input image.')
    const { segment: runSegment } = await import('@brainchop/mindgrab')
    const result = await runSegment(input, {
      model: '16chan18cls',
      worker: true,
      backend: 'auto',
      assetPath: `${import.meta.env.BASE_URL}brainchop/`,
    })
    if (source !== image) throw new Error('The image changed during segmentation; run it again.')
    const labels = new Uint8Array(result.image)
    while (nv.volumes.length > 1) await nv.removeVolume(1)
    await nv.addVolume({ url: new File([labels], 'segmentation.nii'), name: 'segmentation.nii', opacity: 0.5 })
    await nv.setColormapLabel(nv.volumes.length - 1, SEG_COLORMAP)
    segmentation = labels
    status(`Segmentation complete on ${result.backend} (${Math.round(result.elapsedMs)} ms). Create the mesh when ready.`)
  } catch (error) {
    status(error instanceof Error ? error.message : String(error), true)
  } finally {
    busy = false
    buttons()
  }
}

async function mesh() {
  if (!segmentation || busy) return
  const labels = segmentation
  busy = true
  buttons()
  try {
    status('Creating mesh with niimath…')
    if (!niimathReady) niimathReady = niimath.init()
    await niimathReady
    const output = await niimath
      .image(new File([labels], 'segmentation.nii'))
      .mesh({
        i: 0.5,
        l: $('largestOnly').checked ? 1 : 0,
        b: $('fillBubbles').checked ? 1 : 0,
        r: Number($('simplify').value) / 100,
      })
      .run('brain.mz3')
    if (segmentation !== labels) throw new Error('The segmentation changed during meshing; run it again.')
    await clearMeshes()
    await nv.loadMeshes([{ url: new File([await output.arrayBuffer()], 'brain.mz3'), name: 'brain.mz3' }])
    const current = nv.meshes.at(-1)
    const report = inspectMesh(current)
    const closed = report.manifold && report.consistent
    // Only a closed, consistently wound mesh has a meaningful inside, so only then
    // is a negative volume evidence of inward normals worth correcting for printing.
    const shouldFlip = closed && report.signedVolume < 0
    if (shouldFlip) {
      flipWinding(current.indices)
      await nv.updateGLVolume()
    }
    $('outputSection').open = true
    status(`Mesh complete: ${current.indices.length / 3} triangles, ${closed ? 'closed manifold' : 'non-manifold'}, ${shouldFlip ? 'winding corrected' : 'winding preserved'}. Choose STL or OBJ to download.`)
  } catch (error) {
    niimath.dispose('mesh failed')
    niimathReady = null
    status(error instanceof Error ? error.message : String(error), true)
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
$('segmentButton').addEventListener('click', () => void segment())
$('meshButton').addEventListener('click', () => void mesh())
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
void init()

export default Object.freeze({ APP, chooseFiles, segment, mesh })
