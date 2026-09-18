import './style.css'
import '@neurodesk/webapp-components/styles/imaging-workspace.css'
import { mountImagingWorkspace } from '@neurodesk/webapp-components/core/mount-imaging-workspace'
import { bindFileDrop, createExampleSelector } from '@neurodesk/webapp-components/ui'
import { readImageFiles } from '@neurodesk/runtime-support/dcm2niix-client'
import { Niivue, SLICE_TYPE, SHOW_RENDER, MULTIPLANAR_TYPE } from '@niivue/niivue'
import { Niimath } from "@niivue/niimath"

import examples from './examples.json'

mountImagingWorkspace({
  controls: 'body > header',
  viewer: 'body > main',
  status: 'body > footer',
  title: 'NiiMath',
  subtitle: 'Interactive browser-native neuroimaging maths',
  mark: 'N',
})

// create niivue instance but don't setup the scene just yet
const nv = new Niivue({
  logLevel: 'debug'
});

// create niimath instance (will be initialized later)
const niimath = new Niimath();
console.log(niimath);


// store a reference to an unedited image for
// use when the user wants to change the command from the dropdown
let uneditedImage;
let imageBusy = false;
let imageProcessingReady = false;

function updateImageControls() {
  const disabled = imageBusy || !imageProcessingReady;
  for (const control of document.querySelectorAll('#niftiInput, #dicomInput, #dicomPick, #moreCommands')) {
    control.disabled = disabled;
  }
  exampleControl.setDisabled(disabled);
  document.getElementById("moreCommands").disabled = disabled || !uneditedImage;
  document.getElementById("processButton").disabled = disabled || !uneditedImage;
  document.getElementById("saveButton").disabled = disabled || !uneditedImage;
  document.getElementById("resetButton").disabled = disabled || !uneditedImage;
}

async function runImageTask(task) {
  if (imageBusy || !imageProcessingReady) return;
  imageBusy = true;
  updateImageControls();
  try {
    await task();
  } finally {
    imageBusy = false;
    updateImageControls();
  }
}

async function processImage(isOverlay) {
  loadingCircle.classList.remove('hidden')
  try {
    const imageIndex = 0;
    const niiBuffer = await nv.saveImage({ volumeByIndex: imageIndex })
    const niiFile = new File([niiBuffer], 'image.nii')
    const input = document.getElementById('command');
    const cmd = input.value;
    const imageProcessor = niimath.image(niiFile)
    // check if "mesh" is in the command, and set isMesh
    const isMesh = cmd.includes('mesh')
    // check if "bitmap" is in the command, and set isBitmap
    const isBitmap = cmd.includes('bitmap')
    // create array of commands by separating on spaces
    // trim any leading or trailing whitespace
    const commands = cmd.split(' ').map((c) => c.trim())
    imageProcessor.commands = [...commands]
    const outName = isMesh ? 'mesh.mz3' : isBitmap ? 'bitmap.png' : 'image.nii.gz'
    console.log('ismesh', isMesh);
    console.log(imageProcessor);
    const processedBlob = await imageProcessor.run(outName)
    console.log(processedBlob);

    const arrayBuffer = await processedBlob.arrayBuffer()
    if (!isOverlay) {
      nv.removeVolume(nv.volumes[0]);
    }

    if (isBitmap) {
      // For bitmap outputs, use arrayBuffer with a name property ending in .png
      await nv.loadVolumes([{ url: arrayBuffer, name: outName }])
    } else {
      // For meshes and nifti files, use loadFromArrayBuffer
      console.log('arrayBuffer', arrayBuffer);
      await nv.loadFromArrayBuffer(arrayBuffer, outName)
    }

    // set the colormap to the value of the color dropdown
    if (isOverlay) {
      setOverlayColor();
    }
    loadingCircle.classList.add('hidden')
    document.getElementById('outputSection').open = true;
  } catch (error) {
    loadingCircle.classList.add('hidden')
    console.error(error)
  }
}

// respond to our button press
function buttonProcessImage() {
  const isOverlay = overlayCheck.checked;
  void runImageTask(() => processImage(isOverlay));
}

// set overlay opacity
function setOverlayOpacity() {
  const opacityString = overlayOpacity.value;
  const opacity = parseFloat(opacityString);
  if (nv.volumes.length > 1) {
    nv.setOpacity(1, opacity);
  }
}

// set overlay color
function setOverlayColor() {
  const overlayColor = document.getElementById('overlayColor');
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

// on reset button click
function reset() {
  // reload the page
  location.reload();
}

// when overlay checkbox is checked hide or show the opacity slider and the color dropdown
function overlayChecked() {
  const overlayOpacity = document.getElementById('overlayOpacity');
  const overlayColor = document.getElementById('overlayColor');
  // get the labels too
  const overlayOpacityLabel = document.getElementById('overlayOpacityLabel');
  const overlayColorLabel = document.getElementById('overlayColorLabel');
  if (overlayCheck.checked) {
    overlayOpacity.style.display = 'inline';
    overlayColor.style.display = 'inline';
    overlayOpacityLabel.style.display = 'inline';
    overlayColorLabel.style.display = 'inline';
  } else {
    overlayOpacity.style.display = 'none';
    overlayColor.style.display = 'none';
    overlayOpacityLabel.style.display = 'none';
    overlayColorLabel.style.display = 'none';
  }
}

// populate overlay color dropdown
function populateOverlayColors() {
  const colormaps = nv.colormaps()
  const overlayColor = document.getElementById('overlayColor')
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
  const moreCommands = document.getElementById('moreCommands');
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
  const moreCommands = document.getElementById('moreCommands');
  const command = moreCommands.options[moreCommands.selectedIndex].text;
  const input = document.getElementById('command');
  input.value = command;

  // if a mesh is there, remove it
  if (nv.meshes.length > 0) {
    // loop through all meshes and remove them
    for (let i = 0; i < nv.meshes.length; i++) {
      nv.removeMesh(nv.meshes[i]);
    }
  }

  // if an overlay is there, remove it
  if (nv.volumes.length > 1) {
    // loop over all volumes from 1 to the end
    for (let i = 1; i < nv.volumes.length; i++) {
      nv.removeVolume(nv.volumes[i]);
    }
  } else {
    // restore the unedited image
    nv.removeVolume(nv.volumes[0]);
    nv.addVolume(uneditedImage);
  }

  // then click the process button
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
}

async function loadDicomFiles(files) {
  loadingCircle.classList.remove('hidden')
  try {
    const converted = await readImageFiles(files)
    if (converted.length === 0) throw new Error('No NIfTI image was found in this folder.')
    dicomPick.replaceChildren()
    for (const [index, file] of converted.entries()) {
      const option = document.createElement('option')
      option.value = String(index)
      option.textContent = file.name
      dicomPick.append(option)
    }
    dicomPick.classList.toggle('hidden', converted.length < 2)
    await loadFile(converted[0])
    dicomPick.onchange = () => void runImageTask(() => loadFile(converted[Number(dicomPick.value)]))
  } catch (error) {
    console.error(error)
    window.alert(error instanceof Error ? error.message : String(error))
  } finally {
    loadingCircle.classList.add('hidden')
  }
}


const exampleControl = createExampleSelector({
  examples,
  onLoad: async (_example, { fetchFiles, signal, assertCurrent }) => {
    const [file] = await fetchFiles()
    assertCurrent()
    if (imageBusy || !imageProcessingReady) throw new Error("Wait for the current image operation to finish.")
    await runImageTask(() => loadFile(file, signal))
  },
})
document.getElementById('exampleControl').append(exampleControl)
exampleControl.setDisabled(true)

async function main() {

  // populate overlay color dropdown
  populateOverlayColors();

  // populate moreCommands dropdown
  populateMoreCommands();

  // set overlay opacity
  overlayOpacity.oninput = setOverlayOpacity;

  // set overlay color
  overlayColor.onchange = setOverlayColor;

  // when overlay checkbox is checked
  overlayCheck.onchange = overlayChecked;

  // on reset button click
  resetButton.onclick = reset;

  // when the user selects a command from the moreCommands dropdown
  moreCommands.onchange = moreCommandsSelected;

  // enable our button after our WASM has been initialize
  function initializeImageProcessing() {
    // await initWasm();
    let button = document.getElementById('processButton');
    imageProcessingReady = true;
    updateImageControls();
    button.onclick = buttonProcessImage;
  }
  saveButton.onclick = function () {
    if (nv.volumes.length < 2)
      nv.saveImage({ filename: "niimath.nii.gz", isSaveDrawing: false, volumeByIndex: 0 });
    else
      nv.saveImage({ filename: "niimath.nii.gz", isSaveDrawing: false, volumeByIndex: 1 });
  }
  niftiInput.onchange = async function () {
    const files = Array.from(niftiInput.files ?? [])
    if (files.length) await runImageTask(() => loadDicomFiles(files))
    niftiInput.value = ''
  }
  dicomInput.onchange = async function () {
    const files = Array.from(dicomInput.files ?? [])
    if (files.length > 0) await runImageTask(() => loadDicomFiles(files))
    dicomInput.value = ''
  }
  bindFileDrop(document.getElementById('inputDropZone'), (pending) => runImageTask(async () => {
    const files = await pending
    if (files.length) await loadDicomFiles(files)
  }))
  helpButton.onclick = function () {
    // open link in new tab
    const link = "https://github.com/rordenlab/niimath/blob/9f3a301be72c331b90ef5baecb7a0232e9b47ba4/src/niimath.c#L259"
    window.open(link, '_blank');
  }

  updateImageControls();
  let canvas = document.getElementById('gl');
  nv.setInterpolation(true);
  nv.attachToCanvas(canvas);
  nv.setSliceType(SLICE_TYPE.MULTIPLANAR)
  nv.setMultiplanarLayout(MULTIPLANAR_TYPE.GRID)
  nv.opts.multiplanarShowRender = SHOW_RENDER.ALWAYS
  // initialize niimath (loads wasm and sets up worker)
  await niimath.init();
  console.log(niimath);

  // enable our button after our WASM has been setup
  initializeImageProcessing();
}

main()
