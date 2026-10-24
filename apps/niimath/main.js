import '@neurodesk/webapp-components/styles/imaging-workspace.css'
import { mountImagingWorkspace } from '@neurodesk/webapp-components/core/mount-imaging-workspace'
import { bindFileDrop, createConsole, createExampleSelector, createInfoDialog, createViewerToolbar } from '@neurodesk/webapp-components/ui'
import { readImageFiles, runDcm2niix } from '@neurodesk/runtime-support/dcm2niix-client'
import { registerAppAutomation, runAbortable } from '@neurodesk/webapp-components/automation'
import { Niivue, SLICE_TYPE, SHOW_RENDER, MULTIPLANAR_TYPE } from '@niivue/niivue'
import { Niimath } from "@niivue/niimath"

import examples from './examples.json'

const $ = (id) => document.getElementById(id)

mountImagingWorkspace({
  controls: '#controls',
  viewer: '#viewer',
  status: '#status',
  title: 'NiiMath',
  subtitle: 'Interactive browser-native neuroimaging maths',
  mark: 'N',
  controlsContract: { about: '#aboutBtn', privacy: '#privacyBtn' },
})

// About and Privacy open one shared dialog from the app bar.
const info = createInfoDialog()
$('aboutBtn').onclick = () => info.open('About NiiMath', $('aboutContent'))
$('privacyBtn').onclick = () => info.open('Privacy', $('privacyContent'))

// Technical log below the canvas: collapsed until an error opens it.
const log = createConsole({ id: 'technicalLog' })
$('viewer').append(log)

// create niivue instance but don't setup the scene just yet
const nv = new Niivue({ loadingText: "" });

// Layout tabs above the canvas, as in every other imaging app.
const layouts = {
  multiplanar: SLICE_TYPE.MULTIPLANAR,
  axial: SLICE_TYPE.AXIAL,
  coronal: SLICE_TYPE.CORONAL,
  sagittal: SLICE_TYPE.SAGITTAL,
  render: SLICE_TYPE.RENDER,
}
let currentLayout = 'multiplanar'
const toolbar = createViewerToolbar({
  window: false, overlay: false, colormap: false, download: false, screenshot: false,
  views: [
    { id: 'multiplanar', label: '3-Plane', active: true },
    { id: 'axial', label: 'Axial' },
    { id: 'coronal', label: 'Coronal' },
    { id: 'sagittal', label: 'Sagittal' },
    { id: 'render', label: '3D' },
  ].map((view) => ({ ...view, onClick: () => {
    nv.setSliceType(layouts[view.id])
    currentLayout = view.id
    toolbar.setActive(view.id)
  } })),
})
$('viewer').prepend(toolbar)

// create niimath instance (will be initialized later)
let niimath = new Niimath();
let niimathInitialized;
function ensureNiimath() {
  return niimathInitialized ??= niimath.init();
}
function cancelNiimath() {
  niimath.worker?.terminate();
  niimath = new Niimath();
  niimathInitialized = undefined;
}

// store a reference to an unedited image for
// use when the user wants to change the command from the dropdown
let uneditedImage;
let imageBusy = false;
let imageProcessingReady = false;

// ---------------------------------------------------------------------------
// Status footer: one line of text, elapsed time and the shared progress bar.
// niimath runs in a worker that cannot be interrupted, so the cancel × stays hidden.
function status(message, error = false) {
  $('statusText').textContent = message
  $('statusText').classList.toggle('error', error)
  log.log(message, error ? 'error' : 'info')
}

function formatElapsed(ms) {
  const seconds = Math.floor(ms / 1000)
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`
}

let workStart = 0
let elapsedTimer = null
function beginWork(message) {
  workStart = performance.now()
  $('elapsed').textContent = '0:00'
  clearInterval(elapsedTimer)
  elapsedTimer = setInterval(() => { $('elapsed').textContent = formatElapsed(performance.now() - workStart) }, 1000)
  $('progress').removeAttribute('value') // indeterminate while running
  status(message)
}

function endWork(message, error = false) {
  clearInterval(elapsedTimer)
  elapsedTimer = null
  const seconds = ((performance.now() - workStart) / 1000).toFixed(1)
  $('elapsed').textContent = formatElapsed(performance.now() - workStart)
  $('progress').value = error ? 0 : 1
  status(error ? message : `${message} · ${seconds} s`, error)
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error)
}

function updateImageControls() {
  const disabled = imageBusy || !imageProcessingReady;
  for (const control of document.querySelectorAll('#niftiInput, #dicomPick')) {
    control.disabled = disabled;
  }
  exampleControl.setDisabled(disabled);
  $("moreCommands").disabled = disabled || !uneditedImage;
  $("processButton").disabled = disabled || !uneditedImage;
  $("saveButton").disabled = disabled || !uneditedImage;
  $("resetButton").disabled = disabled || !uneditedImage;
}

async function runImageTask(task) {
  if (imageBusy || !imageProcessingReady) return;
  imageBusy = true;
  updateImageControls();
  try {
    return await task();
  } finally {
    imageBusy = false;
    updateImageControls();
  }
}

async function processImage(isOverlay, { command = $('command').value, signal, throwOnError = false } = {}) {
  const cmd = command.trim();
  beginWork(`Running niimath ${cmd} …`)
  try {
    signal?.throwIfAborted();
    await runAbortable(signal, ensureNiimath, cancelNiimath);
    const imageIndex = 0;
    const niiBuffer = await nv.saveImage({ volumeByIndex: imageIndex })
    const niiFile = new File([niiBuffer], 'image.nii')
    const imageProcessor = niimath.image(niiFile)
    // check if "mesh" is in the command, and set isMesh
    const isMesh = cmd.split(/\s+/).includes('-mesh')
    // check if "bitmap" is in the command, and set isBitmap
    const isBitmap = cmd.split(/\s+/).includes('-bitmap')
    // create array of commands by separating on spaces
    const commands = cmd.split(/\s+/).filter(Boolean)
    imageProcessor.commands = [...commands]
    const outName = isMesh ? 'mesh.mz3' : isBitmap ? 'bitmap.png' : 'image.nii.gz'
    log.log(`niimath ${commands.join(' ')} → ${outName}`, 'info')
    const processedBlob = await runAbortable(signal, () => imageProcessor.run(outName), cancelNiimath)
    log.log(`niimath produced ${outName} (${processedBlob.size} bytes)`, 'info')

    const arrayBuffer = await processedBlob.arrayBuffer()
    signal?.throwIfAborted();
    if (!isOverlay) {
      nv.removeVolume(nv.volumes[0]);
    }

    if (isBitmap) {
      // For bitmap outputs, use arrayBuffer with a name property ending in .png
      await nv.loadVolumes([{ url: arrayBuffer, name: outName }])
    } else {
      // For meshes and nifti files, use loadFromArrayBuffer
      await nv.loadFromArrayBuffer(arrayBuffer, outName)
    }

    // set the colormap to the value of the color dropdown
    if (isOverlay) {
      setOverlayColor();
    }
    $('outputSection').open = true;
    endWork(`${outName} ready${isOverlay ? ' as overlay' : ''}`)
    return { file: new File([processedBlob], outName), type: isMesh ? 'neuro:surface' : isBitmap ? 'file:image' : 'neuro:volume', commands };
  } catch (error) {
    endWork(`niimath failed: ${errorMessage(error)}`, true)
    if (throwOnError) throw error;
  }
}

// respond to our button press
function buttonProcessImage() {
  const isOverlay = $('overlayCheck').checked;
  void runImageTask(() => processImage(isOverlay));
}

// set overlay opacity
function setOverlayOpacity() {
  const opacity = parseFloat($('overlayOpacity').value);
  if (nv.volumes.length > 1) {
    nv.setOpacity(1, opacity);
  }
}

// set overlay color
function setOverlayColor() {
  const overlayColor = $('overlayColor');
  // get the text value of the selected option
  const colormap = overlayColor.options[overlayColor.selectedIndex].text;
  if (nv.volumes.length > 1) {
    nv.setColormap(nv.volumes[1].id, colormap)
  }

  // if meshes are present, set their color too
  if (nv.meshes.length > 0) {
    nv.setMeshProperty(nv.meshes[0].id, 'colormap', colormap);
  }
}

// remove every processed result (meshes, overlays, bitmaps) and show the unedited image again
function restoreOriginal() {
  for (const mesh of [...nv.meshes]) nv.removeMesh(mesh)
  for (const volume of [...nv.volumes]) nv.removeVolume(volume)
  nv.addVolume(uneditedImage)
}

// on reset button click
function reset() {
  if (!uneditedImage) return
  restoreOriginal()
  $('outputSection').open = false
  $('progress').value = 0
  $('elapsed').textContent = ''
  status('Original image restored')
}

// when overlay checkbox is checked hide or show the overlay appearance settings
function overlayChecked() {
  $('overlaySettings').hidden = !$('overlayCheck').checked
}

// populate overlay color dropdown
function populateOverlayColors() {
  const colormaps = nv.colormaps()
  const overlayColor = $('overlayColor')
  for (let i = 0; i < colormaps.length; i++) {
    let option = document.createElement("option");
    option.text = colormaps[i];
    overlayColor.add(option);
  }
  // find the index of red and set it as the default
  const redIndex = colormaps.indexOf('red')
  overlayColor.selectedIndex = redIndex;
}

// populate moreCommands dropdown with some niimath command strings for users to try
function populateMoreCommands() {
  const moreCommands = $('moreCommands');
  const commands = [
    '-dehaze -5 -dog 2 3.2',
    '-dehaze -5',
    '-mesh -i m -b',
    '-fmedian',
    '-fmean',
    '-sobel',
    '-sobel_binary',
    '-otsu 5',
    '-recip',
    '-bitmap -x 0.33 0.66 -r -y 0.33 0.66 -r -z 0.33 0.66 basic.png',
    '-bitmap -y 0.33 0.66 -z 0.33 0.66 -X 0.5 -c viridis cross.png',
    '-bitmap -o 0.5 -c inferno optimal.png',
  ];
  for (let i = 0; i < commands.length; i++) {
    let option = document.createElement("option");
    option.text = commands[i];
    moreCommands.add(option);
  }
  // set the default command
  moreCommands.selectedIndex = 0;
}

// when the user selects a command from the moreCommands dropdown
function moreCommandsSelected() {
  const moreCommands = $('moreCommands');
  $('command').value = moreCommands.options[moreCommands.selectedIndex].text;
  // start again from the unedited image, then process
  restoreOriginal()
  buttonProcessImage();
}

async function loadFile(file, signal) {
  const bytes = await file.arrayBuffer()
  signal?.throwIfAborted()
  for (const mesh of [...nv.meshes]) nv.removeMesh(mesh)
  for (const volume of [...nv.volumes]) nv.removeVolume(volume)
  await nv.loadFromArrayBuffer(bytes, file.name)
  signal?.throwIfAborted()
  uneditedImage = nv.volumes[0]
  nv.updateGLVolume()
  $('emptyState').hidden = true
  $('fileInfo').hidden = false
  $('fileInfo').textContent = file.name
  $('inputDropZone').classList.add('has-files')
  $('outputSection').open = false
}

async function loadImage(file, signal, description = file.name) {
  beginWork(`Loading ${description} …`)
  try {
    await loadFile(file, signal)
    endWork(`${file.name} loaded (${nv.volumes[0].dims.slice(1, 4).join(' × ')})`)
  } catch (error) {
    endWork(signal?.aborted ? 'Loading cancelled' : `Could not load ${file.name}: ${errorMessage(error)}`, true)
    throw error
  }
}

async function loadDicomFiles(files) {
  const needsConversion = files.some((file) => !/\.nii(\.gz)?$/i.test(file.name))
  beginWork(needsConversion
    ? `Converting ${files.length} DICOM file${files.length === 1 ? '' : 's'} with dcm2niix …`
    : `Loading ${files.length} file${files.length === 1 ? '' : 's'} …`)
  try {
    const converted = await readImageFiles(files)
    if (converted.length === 0) throw new Error('No NIfTI image was found in this folder.')
    const dicomPick = $('dicomPick')
    dicomPick.replaceChildren()
    for (const [index, file] of converted.entries()) {
      const option = document.createElement('option')
      option.value = String(index)
      option.textContent = file.name
      dicomPick.append(option)
    }
    $('dicomPickField').hidden = converted.length < 2
    if (needsConversion) log.log(`dcm2niix produced ${converted.length} image${converted.length === 1 ? '' : 's'}: ${converted.map((file) => file.name).join(', ')}`, 'info')
    await loadFile(converted[0])
    endWork(`${converted[0].name} loaded (${nv.volumes[0].dims.slice(1, 4).join(' × ')})`)
    dicomPick.onchange = () => void runImageTask(() => loadImage(converted[Number(dicomPick.value)]).catch(() => {}))
  } catch (error) {
    endWork(`Could not load image: ${errorMessage(error)}`, true)
  }
}


const exampleControl = createExampleSelector({
  examples,
  onLoad: async (example, { fetchFiles, signal, assertCurrent }) => {
    beginWork(`Downloading ${example.label} …`)
    const [file] = await fetchFiles()
    assertCurrent()
    if (imageBusy || !imageProcessingReady) throw new Error("Wait for the current image operation to finish.")
    await runImageTask(() => loadImage(file, signal, 'example'))
  },
})
$('exampleControl').append(exampleControl)
exampleControl.addEventListener('nd-example-status', (event) => {
  const { state, message } = event.detail
  if (state === 'error') endWork(message, true)
  if (state === 'cancelled') endWork(message)
})
exampleControl.setDisabled(true)

async function main() {

  // populate overlay color dropdown
  populateOverlayColors();

  // populate moreCommands dropdown
  populateMoreCommands();

  $('overlayOpacity').oninput = setOverlayOpacity;
  $('overlayColor').onchange = setOverlayColor;
  $('overlayCheck').onchange = overlayChecked;
  $('resetButton').onclick = reset;
  $('moreCommands').onchange = moreCommandsSelected;

  // enable our button after our WASM has been initialize
  function initializeImageProcessing() {
    imageProcessingReady = true;
    updateImageControls();
    $('processButton').onclick = buttonProcessImage;
  }
  $('saveButton').onclick = function () {
    const volumeByIndex = nv.volumes.length < 2 ? 0 : 1
    nv.saveImage({ filename: "niimath.nii.gz", isSaveDrawing: false, volumeByIndex });
    status('niimath.nii.gz saved')
  }
  const niftiInput = $('niftiInput')
  niftiInput.onchange = async function () {
    const files = Array.from(niftiInput.files ?? [])
    if (files.length) await runImageTask(() => loadDicomFiles(files))
    niftiInput.value = ''
  }
  bindFileDrop($('inputDropZone'), (pending) => runImageTask(async () => {
    const files = await pending
    if (files.length) await loadDicomFiles(files)
  }))
  $('helpButton').onclick = function () {
    // open link in new tab
    const link = "https://github.com/rordenlab/niimath/blob/9f3a301be72c331b90ef5baecb7a0232e9b47ba4/src/niimath.c#L259"
    window.open(link, '_blank');
  }

  updateImageControls();
  nv.setInterpolation(true);
  nv.attachToCanvas($('gl'));
  nv.setSliceType(SLICE_TYPE.MULTIPLANAR)
  nv.setMultiplanarLayout(MULTIPLANAR_TYPE.GRID)
  nv.opts.multiplanarShowRender = SHOW_RENDER.ALWAYS
  // initialize niimath (loads wasm and sets up worker)
  status('Loading niimath WebAssembly …')
  try {
    await ensureNiimath();
  } catch (error) {
    status(`niimath failed to initialise: ${errorMessage(error)}`, true)
    return
  }
  log.log('niimath worker ready', 'info')
  status('Drag and drop files')

  // enable our button after our WASM has been setup
  initializeImageProcessing();
}

const initialized = main()
async function runAutomationImage({ inputs, signal, progress }, command, artifact = {}) {
  await initialized;
  if (!imageProcessingReady || imageBusy) throw new Error('NiiMath is not ready for a new image operation.');
  return runImageTask(async () => {
    progress('Loading input');
    await loadImage(inputs.image[0], signal);
    progress('Running NiiMath');
    const result = await processImage(false, { command, signal, throwOnError: true });
    return { artifacts: [{ role: 'result', file: result.file, type: result.type, ...artifact }],
      provenance: { engine: 'niimath-wasm', commands: result.commands } };
  });
}

const automation = registerAppAutomation({ app: 'niimath', convertDicom: runDcm2niix, operations: {
  process: (request) => runAutomationImage(request, request.parameters.command),
  binarize: (request) => runAutomationImage(request, '-bin', { role: 'mask', type: 'neuro:mask' }),
} });
automation.registerViewer('main', {
  state: () => ({ tabs: Object.keys(layouts).map(id => ({ id, label: id, active: currentLayout === id })),
    dimensions: nv.volumes.map(volume => Array.from(volume.dims.slice(1, 4))) }),
  tabs: {
    list: () => Object.keys(layouts).map(id => ({ id, label: id, active: currentLayout === id })),
    select(id) { currentLayout = id; nv.setSliceType(layouts[id]); toolbar.setActive(id); },
  },
});
