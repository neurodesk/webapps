// VesselCharter web application entry.
// Built strictly from @neurodesk/webapp-components shared vocabulary and
// @neurodesk/vesselcharter pure-JS morphometry worker.
import '@neurodesk/webapp-components/styles/imaging-workspace.css';
import { mountImagingWorkspace } from '@neurodesk/webapp-components/core/mount-imaging-workspace';
import {
  ProgressManager,
  bindFileDrop,
  bindInfoTooltips,
  createConsole,
  createExampleSelector,
  createInfoDialog,
  createResultList,
  createViewerToolbar,
} from '@neurodesk/webapp-components/ui';
import { downloadFile } from '@neurodesk/webapp-components/file-io';
import {
  createNiivueAdapter,
  registerAppAutomation,
  registerViewer,
} from '@neurodesk/webapp-components/automation';
import NiiVue, { SLICE_TYPE } from '@niivue/niivue';
import { APP } from './config.js';
import { renderVesselReport } from './report.js';
import examples from '../examples.json';

const $ = (id) => document.getElementById(id);

// 1. Mount shared workspace chrome (app bar, sidebar, viewer, footer).
const workspace = mountImagingWorkspace({
  controls: '#controls',
  viewer: '#viewer',
  status: '#status',
  title: APP.title,
  subtitle: APP.subtitle,
  controlsContract: { about: '#aboutBtn', privacy: '#privacyBtn' },
});

// 2. Viewer toolbar + single collapsed technical log.
const toolbar = createViewerToolbar({
  views: [
    { id: '3d', label: '3D', active: false },
    { id: 'multiplanar', label: 'Multiplanar', active: true },
    { id: 'axial', label: 'Axial' },
    { id: 'coronal', label: 'Coronal' },
    { id: 'sagittal', label: 'Sagittal' },
    { id: 'report', label: 'Report', disabled: true },
  ],
  window: false,
  overlay: true,
  colormap: false,
  download: false,
  screenshot: true,
});
$('viewer').prepend(toolbar);

const log = createConsole({ id: 'technicalLog', resizable: true });
$('viewer').append(log);
const progress = new ProgressManager();
bindInfoTooltips(document);

const info = createInfoDialog();
$('aboutBtn').onclick = () => info.open(`About ${APP.title}`, $('aboutContent'));
$('privacyBtn').onclick = () => info.open('Privacy', $('privacyContent'));

// 3. NiiVue 1.0 viewer initialization (graceful fallback if headless WebGL is unavailable).
let nv = null;
let viewerExtension = null;
let viewerReady = false;
let viewerInitPromise = null;
let hasVesselMesh = false;

function listViewerTabs() {
  return [
    { id: '3d', label: '3D', active: activeView === '3d' },
    { id: 'multiplanar', label: 'Multiplanar', active: activeView === 'multiplanar' },
    { id: 'axial', label: 'Axial', active: activeView === 'axial' },
    { id: 'coronal', label: 'Coronal', active: activeView === 'coronal' },
    { id: 'sagittal', label: 'Sagittal', active: activeView === 'sagittal' },
    { id: 'report', label: 'Report', active: activeView === 'report' },
  ];
}

function ensureViewer() {
  if (viewerInitPromise) {
    return viewerInitPromise;
  }
  viewerInitPromise = (async () => {
    try {
      const instance = new NiiVue({
        isColorbarVisible: false,
        isDragDropEnabled: false,
        backgroundColor: [0.06, 0.07, 0.08, 1],
      });
      await instance.attachTo('gl1');
      instance.isLegendVisible = false;
      instance.sliceType = SLICE_TYPE.MULTIPLANAR;
      instance.drawScene();
      viewerExtension = instance.createExtensionContext?.() ?? null;
      viewerExtension?.on('locationChange', (event) => {
        if (event.detail?.string) {
          $('location').textContent = event.detail.string;
        }
      });
      nv = instance;
      viewerReady = true;
      $('viewerError').hidden = true;
      registerViewer(
        'main',
        createNiivueAdapter(nv, {
          tabs: {
            list: listViewerTabs,
            select: (id) => setView(id),
          },
        }),
      );
    } catch (err) {
      log.log(`3D WebGL viewer unavailable: ${err instanceof Error ? err.message : String(err)}`, 'warning');
      $('viewerError').textContent = 'WebGL viewer unavailable in this browser; morphometry and exports still run normally.';
      $('viewerError').hidden = false;
      nv = null;
      viewerReady = false;
    }
    return nv;
  })();
  return viewerInitPromise;
}

void ensureViewer();

// 4. Application state.
let vesselFile = null;
let brainMaskFile = null;
let referenceFile = null;
let lastReportData = null;
let lastArtifactFiles = null;
let activeView = 'multiplanar';
let activeDisplay = 'mask';
let overlayOpacity = 0.8;
let loadingController = null;
let activeWorker = null;
let activeRunCancel = null;
let activeRunId = 0;

function status(message, isError = false) {
  $('statusText').textContent = message;
  $('statusText').classList.toggle('error', isError);
  log.log(message, isError ? 'error' : 'info');
}

function readParametersFromUi() {
  return {
    maskThreshold: Number($('maskThreshold').value || 0),
    fillHoles: $('fillHoles').checked,
    minComponentVoxels: Math.max(0, Math.round(Number($('minComponentVoxels').value || 0))),
    minSpurLengthMm: Math.max(0, Number($('minSpurLengthMm').value || 0)),
    pruneContainedSpurs: $('pruneContainedSpurs').checked,
    minIsolatedLengthMm: Math.max(0, Number($('minIsolatedLengthMm').value || 0)),
    smoothIterations: Math.max(0, Math.round(Number($('smoothIterations').value || 0))),
  };
}

function applyParametersToUi(params = {}) {
  if (params.maskThreshold !== undefined) $('maskThreshold').value = String(params.maskThreshold);
  if (params.fillHoles !== undefined) $('fillHoles').checked = Boolean(params.fillHoles);
  if (params.minComponentVoxels !== undefined) $('minComponentVoxels').value = String(params.minComponentVoxels);
  if (params.minSpurLengthMm !== undefined) $('minSpurLengthMm').value = String(params.minSpurLengthMm);
  if (params.pruneContainedSpurs !== undefined) $('pruneContainedSpurs').checked = Boolean(params.pruneContainedSpurs);
  if (params.minIsolatedLengthMm !== undefined) $('minIsolatedLengthMm').value = String(params.minIsolatedLengthMm);
  if (params.smoothIterations !== undefined) $('smoothIterations').value = String(params.smoothIterations);
}

function setView(viewId) {
  activeView = viewId;
  toolbar.setActive(viewId);
  const reportEl = $('resultsReport');
  if (viewId === 'report') {
    reportEl.hidden = false;
    $('emptyState').hidden = true;
    $('imageLabel').textContent = 'Vessel characterisation report';
    return;
  }
  reportEl.hidden = true;
  if (!nv) {
    return;
  }
  const map = {
    '3d': SLICE_TYPE.RENDER,
    multiplanar: SLICE_TYPE.MULTIPLANAR,
    axial: SLICE_TYPE.AXIAL,
    coronal: SLICE_TYPE.CORONAL,
    sagittal: SLICE_TYPE.SAGITTAL,
  };
  if (map[viewId] !== undefined) {
    if (nv.volumes.length > 0 && typeof nv.setVolume === 'function') {
      const targetOpacity = viewId === '3d' && hasVesselMesh && !referenceFile ? 0 : 1;
      void nv.setVolume(0, { opacity: targetOpacity });
    }
    nv.sliceType = map[viewId];
    nv.drawScene();
  }
}

toolbar.addEventListener('nd-view-change', (event) => {
  setView(event.detail.value);
});

toolbar.addEventListener('nd-overlay-change', (event) => {
  overlayOpacity = Number(event.detail.value ?? 0.8);
  if (nv && nv.volumes.length > 1) {
    if (typeof nv.setVolume === 'function') {
      void nv.setVolume(1, { opacity: overlayOpacity });
    } else if (typeof nv.setOpacity === 'function') {
      nv.setOpacity(1, overlayOpacity);
    }
  }
});

toolbar.addEventListener('nd-screenshot', () => {
  if (!nv) {
    return;
  }
  const saveFn = typeof nv.saveBitmap === 'function' ? nv.saveBitmap : nv.saveScene;
  if (typeof saveFn === 'function') {
    void Promise.resolve(saveFn.call(nv, 'vesselcharter-view.png')).catch((err) => {
      log.log(`Screenshot warning: ${err instanceof Error ? err.message : String(err)}`, 'warning');
    });
  }
});

async function clearViewerMeshes(viewer) {
  hasVesselMesh = false;
  while (viewer.meshes && viewer.meshes.length > 0) {
    if (typeof viewer.removeMesh === 'function') {
      await viewer.removeMesh(0);
    } else {
      viewer.meshes = [];
      break;
    }
  }
}

async function showVolumeInViewer(primaryFile, overlayFile = null, { colormap = 'warm', label = '' } = {}) {
  const viewer = await ensureViewer();
  if (!viewer || !primaryFile) {
    return;
  }
  try {
    await clearViewerMeshes(viewer);
    const volumes = [
      {
        url: primaryFile,
        name: primaryFile.name,
        colormap: overlayFile ? 'gray' : colormap,
        opacity: 1,
        isColorbarVisible: false,
      },
    ];
    if (overlayFile) {
      volumes.push({
        url: overlayFile,
        name: overlayFile.name,
        colormap,
        opacity: overlayOpacity,
        isColorbarVisible: false,
      });
    }
    await viewer.loadVolumes(volumes);
    $('emptyState').hidden = true;
    $('imageLabel').textContent = label || primaryFile.name;
  } catch (err) {
    log.log(`Viewer load warning: ${err instanceof Error ? err.message : String(err)}`, 'warning');
  }
}

async function showVesselTreeMesh(meshFile) {
  const viewer = await ensureViewer();
  if (!viewer || !meshFile) {
    return;
  }
  try {
    await clearViewerMeshes(viewer);
    await viewer.loadMeshes([{ url: meshFile, name: meshFile.name }]);
    hasVesselMesh = true;
    setView('3d');
    $('emptyState').hidden = true;
    $('imageLabel').textContent = '3D Vessel Tree (coloured by diameter)';
  } catch (err) {
    log.log(`3D mesh display warning: ${err instanceof Error ? err.message : String(err)}`, 'warning');
  }
}

const results = createResultList({
  element: $('resultList'),
  onView: async (stage, entry) => {
    activeDisplay = stage;
    if (stage === 'report' || stage === 'summary' || stage === 'segments' || stage === 'junctions' || stage === 'diameterBins') {
      setView('report');
      return;
    }
    if (stage === 'vesselMesh') {
      await showVesselTreeMesh(entry.file);
      return;
    }
    if (stage === 'diameterMap') {
      if (referenceFile) {
        await showVolumeInViewer(referenceFile, entry.file, { colormap: 'plasma', label: 'Diameter map (mm)' });
      } else {
        await showVolumeInViewer(entry.file, null, { colormap: 'plasma', label: 'Diameter map (mm)' });
      }
      setView('multiplanar');
      return;
    }
    if (stage === 'skeletonLabels') {
      const base = referenceFile || vesselFile;
      await showVolumeInViewer(base, entry.file, { colormap: 'actc', label: 'Skeleton topology (1=seg, 2=junc, 3=end, 4=iso)' });
      setView('multiplanar');
    }
  },
  onDownload: (_stage, entry) => {
    downloadFile(entry.file);
  },
});

function clearResults() {
  lastReportData = null;
  lastArtifactFiles = null;
  results.render();
  $('outputSection').open = false;
  renderVesselReport($('resultsReport'), null);
  const reportTab = toolbar.viewTabs.querySelector('[data-view="report"]');
  if (reportTab) {
    reportTab.disabled = true;
  }
  if (activeView === 'report') {
    setView('multiplanar');
  }
}

function updateRunButtonState() {
  $('runButton').disabled = !vesselFile || Boolean(loadingController) || Boolean(activeRunCancel);
}

// 5. File loading for primary vessel mask + optional brain/ROI mask & reference backdrop.
async function loadVesselMaskFiles(filesPromise, signal) {
  if (loadingController) {
    throw new Error('A vessel mask is still loading. Wait or cancel, then retry.');
  }
  const controller = new AbortController();
  const abort = () => controller.abort();
  signal?.throwIfAborted();
  signal?.addEventListener('abort', abort, { once: true });
  loadingController = controller;
  $('imageInput').disabled = true;
  exampleControl.setDisabled(true);
  updateRunButtonState();
  progress.begin('Loading vessel mask…');
  status('Loading vessel mask…');
  try {
    const files = await filesPromise;
    controller.signal.throwIfAborted();
    if (!files || files.length === 0) {
      throw new Error('Choose a 3D binary vessel mask NIfTI file.');
    }
    const candidate = files[0];
    if (!candidate.size) {
      throw new Error('The selected vessel mask file is empty.');
    }
    // Validate buffer readability before committing state.
    await candidate.arrayBuffer();
    controller.signal.throwIfAborted();

    activeRunCancel?.('Vessel mask changed', false, { resetProgress: false });
    activeRunId += 1;
    vesselFile = candidate;
    clearResults();
    progress.setProgress(0);
    $('fileInfo').hidden = false;
    $('fileInfo').textContent = `${vesselFile.name} (${(vesselFile.size / 1024).toFixed(1)} KB)`;
    $('dropZone').classList.add('has-files');
    $('emptyState').hidden = true;
    await showVolumeInViewer(referenceFile || vesselFile, referenceFile ? vesselFile : null, {
      colormap: 'red',
      label: vesselFile.name,
    });
    controller.signal.throwIfAborted();
    status(`${vesselFile.name} loaded`);
  } finally {
    signal?.removeEventListener('abort', abort);
    loadingController = null;
    $('imageInput').disabled = false;
    exampleControl.setDisabled(false);
    updateRunButtonState();
    progress.stopTimer();
    progress.setCancellable(false);
  }
}

function importVesselFiles(files) {
  exampleControl.cancel();
  return loadVesselMaskFiles(files).catch((error) =>
    status(
      error.name === 'AbortError' ? 'Loading cancelled' : error.message,
      error.name !== 'AbortError',
    ),
  );
}

$('imageInput').addEventListener('change', (event) => {
  const files = Array.from(event.target.files);
  event.target.value = '';
  if (files.length > 0) {
    void importVesselFiles(Promise.resolve(files));
  }
});
bindFileDrop($('dropZone'), importVesselFiles);

// Optional brain / ROI mask input
function setBrainMaskFile(file) {
  activeRunCancel?.('Brain / ROI mask changed', false);
  activeRunId += 1;
  brainMaskFile = file;
  if (file) {
    $('brainMaskInfo').hidden = false;
    $('brainMaskInfo').textContent = `${file.name} (${(file.size / 1024).toFixed(1)} KB)`;
    $('clearBrainMaskBtn').hidden = false;
    status(`Brain / ROI mask attached: ${file.name}`);
  } else {
    $('brainMaskInfo').hidden = true;
    $('brainMaskInfo').textContent = '';
    $('clearBrainMaskBtn').hidden = true;
    status('Brain / ROI mask cleared');
  }
  clearResults();
}

$('brainMaskInput').addEventListener('change', (event) => {
  const files = Array.from(event.target.files);
  event.target.value = '';
  if (files.length > 0 && files[0].size > 0) {
    setBrainMaskFile(files[0]);
  }
});
$('clearBrainMaskBtn').addEventListener('click', () => {
  setBrainMaskFile(null);
  $('brainMaskInput').dispatchEvent(new CustomEvent('nd-files', { detail: { files: [], cancelPending: true }, bubbles: true }));
});

// Optional background TOF/SWI scan input
function setReferenceFile(file) {
  referenceFile = file;
  if (file) {
    $('referenceInfo').hidden = false;
    $('referenceInfo').textContent = `${file.name} (${(file.size / 1024).toFixed(1)} KB)`;
    $('clearReferenceBtn').hidden = false;
    status(`Background scan attached: ${file.name}`);
    if (vesselFile) {
      void showVolumeInViewer(referenceFile, vesselFile, { colormap: 'red', label: `${referenceFile.name} + vessels` });
    }
  } else {
    $('referenceInfo').hidden = true;
    $('referenceInfo').textContent = '';
    $('clearReferenceBtn').hidden = true;
    status('Background scan cleared');
    if (vesselFile) {
      void showVolumeInViewer(vesselFile, null, { colormap: 'red', label: vesselFile.name });
    }
  }
}

$('referenceInput').addEventListener('change', (event) => {
  const files = Array.from(event.target.files);
  event.target.value = '';
  if (files.length > 0 && files[0].size > 0) {
    setReferenceFile(files[0]);
  }
});
$('clearReferenceBtn').addEventListener('click', () => {
  setReferenceFile(null);
  $('referenceInput').dispatchEvent(new CustomEvent('nd-files', { detail: { files: [], cancelPending: true }, bubbles: true }));
});

// 6. Working example selector (Lausanne 3T TOF VesselBoost mask)
const exampleControl = createExampleSelector({
  examples,
  onStatus: status,
  onLoad: async (_example, { fetchFiles, assertCurrent, signal }) => {
    const files = await fetchFiles();
    assertCurrent();
    await loadVesselMaskFiles(Promise.resolve(files), signal);
    assertCurrent();
  },
});
$('exampleControl').append(exampleControl);

// 7. Run VesselCharter inside a dedicated Module Web Worker with cancel support.
function cancelActiveWork() {
  exampleControl.cancel();
  if (loadingController) {
    loadingController.abort();
  }
  if (activeRunCancel) {
    activeRunCancel('Characterisation cancelled', true);
  }
}
$('cancelButton').onclick = cancelActiveWork;

function runCharacterisation(parametersOverride = null, signal = null) {
  if (signal?.aborted) {
    return Promise.reject(signal.reason ?? new DOMException('Characterisation cancelled', 'AbortError'));
  }
  if (!vesselFile || loadingController) {
    return Promise.reject(new Error('Load a 3D binary vessel mask before running characterisation.'));
  }
  if (activeRunCancel) {
    activeRunCancel('Superseded by a new characterisation run', false);
  }

  const runId = ++activeRunId;
  const currentVesselFile = vesselFile;
  const currentBrainMaskFile = brainMaskFile;
  const parameters = parametersOverride ? { ...readParametersFromUi(), ...parametersOverride } : readParametersFromUi();
  clearResults();
  progress.begin('Starting vessel characterisation…');
  progress.setCancellable(true);
  status('Characterising vessels…');

  return new Promise((resolve, reject) => {
    let worker = null;
    let settled = false;

    const cleanup = ({ preserveCancel = false } = {}) => {
      if (worker) {
        if (activeWorker === worker) {
          activeWorker = null;
        }
        worker.terminate();
        worker = null;
      }
      if (activeRunCancel === cancelRun) {
        activeRunCancel = null;
      }
      signal?.removeEventListener('abort', onAbort);
      if (!preserveCancel) {
        progress.setCancellable(false);
      }
      updateRunButtonState();
    };

    const cancelRun = (reason = 'Characterisation cancelled', reportStatus = false, { resetProgress = true } = {}) => {
      if (settled) {
        return;
      }
      settled = true;
      if (activeRunId === runId) {
        activeRunId += 1;
      }
      cleanup({ preserveCancel: !resetProgress });
      if (resetProgress) {
        progress.reset();
      }
      if (reportStatus) {
        status(reason);
      }
      reject(new DOMException(reason, 'AbortError'));
    };

    const onAbort = () => cancelRun('Characterisation cancelled', false);

    activeRunCancel = cancelRun;
    signal?.addEventListener('abort', onAbort, { once: true });
    updateRunButtonState();

    (async () => {
      let vesselBuffer;
      let brainMaskBuffer;
      try {
        vesselBuffer = await currentVesselFile.arrayBuffer();
        if (settled || activeRunId !== runId) {
          return;
        }
        brainMaskBuffer = currentBrainMaskFile ? await currentBrainMaskFile.arrayBuffer() : null;
        if (settled || activeRunId !== runId) {
          return;
        }
      } catch (err) {
        if (settled) {
          return;
        }
        settled = true;
        cleanup();
        progress.reset();
        const message = err instanceof Error ? err.message : String(err);
        status(message, true);
        reject(err);
        return;
      }

      worker = new Worker(new URL('./worker.js', import.meta.url), { type: 'module' });
      activeWorker = worker;
      updateRunButtonState();

      worker.onmessage = async (event) => {
        const msg = event.data;
        if (settled || msg.runId !== runId || activeRunId !== runId) {
          return;
        }
        if (msg.type === 'progress') {
          progress.setProgress(msg.fraction, msg.message);
          $('statusText').textContent = msg.message;
          return;
        }
        if (msg.type === 'error') {
          settled = true;
          cleanup();
          progress.end('Characterisation failed', { success: false });
          status(msg.message, true);
          reject(new Error(msg.message));
          return;
        }
        if (msg.type === 'result') {
          settled = true;
          cleanup();
          const { reportData, artifacts } = msg;
          lastReportData = reportData;

          const fileMap = {};
          for (const [key, item] of Object.entries(artifacts)) {
            fileMap[key] = {
              role: item.role,
              file: new File([item.buffer], item.name, { type: item.mediaType }),
            };
          }
          lastArtifactFiles = fileMap;

          const net = reportData.summary.network;
          const resultRows = {};
          if (fileMap.vesselMesh) {
            resultRows.vesselMesh = {
              description: '3D Vessel Tree (Diameter)',
              file: fileMap.vesselMesh.file,
            };
          }
          resultRows.diameterMap = {
            description: 'Diameter Map (NIfTI)',
            file: fileMap.diameterMap.file,
          };
          resultRows.skeletonLabels = {
            description: 'Skeleton Topology (NIfTI)',
            file: fileMap.skeletonLabels.file,
          };
          resultRows.summary = {
            description: 'Summary Metrics (JSON)',
            file: fileMap.summary.file,
          };
          resultRows.segments = {
            description: `Segments Table (${net.segmentCount}, CSV)`,
            file: fileMap.segments.file,
          };
          resultRows.junctions = {
            description: `Junctions Table (${net.junctionCount}, CSV)`,
            file: fileMap.junctions.file,
          };
          resultRows.diameterBins = {
            description: 'Diameter Bins (CSV)',
            file: fileMap.diameterBins.file,
          };
          resultRows.graph = {
            description: 'Full Vascular Graph (JSON)',
            file: fileMap.graph.file,
          };

          results.render(resultRows);
          $('outputSection').open = true;

          renderVesselReport($('resultsReport'), reportData, {
            onJumpWorld: (worldMm, label) => {
              if (nv && Array.isArray(worldMm)) {
                setView('multiplanar');
                if (typeof nv.setCrosshairPos === 'function') {
                  nv.setCrosshairPos([...worldMm]);
                } else if (typeof nv.mm2frac === 'function') {
                  nv.scene.crosshairPos = nv.mm2frac(worldMm);
                  nv.drawScene();
                }
                $('location').textContent = `${label} · (${worldMm.map((v) => v.toFixed(1)).join(', ')}) mm`;
              }
            },
          });
          const reportTab = toolbar.viewTabs.querySelector('[data-view="report"]');
          if (reportTab) {
            reportTab.disabled = false;
          }

          // Display the 3D diameter-coloured vessel tree right away (or diameter map if no mesh).
          await ensureViewer();
          if (activeRunId === runId) {
            if (fileMap.vesselMesh && viewerReady) {
              await showVesselTreeMesh(fileMap.vesselMesh.file);
            } else if (fileMap.diameterMap) {
              await showVolumeInViewer(referenceFile || fileMap.diameterMap.file, referenceFile ? fileMap.diameterMap.file : null, {
                colormap: 'plasma',
                label: 'Diameter map (mm)',
              });
            }
          }

          if (activeRunId === runId) {
            const headline = `${net.segmentCount} segments · ${net.junctionCount} junctions · ${net.totalLengthMm.toFixed(1)} mm · median ${net.medianDiameterMm !== null ? `${net.medianDiameterMm.toFixed(2)} mm` : 'n/a'}`;
            progress.end(headline);
            status(headline);
          }
          log.log(
            `Input: ${reportData.summary.input.dimensions.join('×')} (${reportData.summary.input.voxelSpacingMm.map((v) => v.toFixed(3)).join('×')} mm), ${reportData.summary.input.inputVesselVoxels} voxels, ${reportData.summary.input.holesFilledVoxels} cavities filled.`,
            'info',
          );
          if (reportData.summary.roi) {
            log.log(
              `ROI density: ${(reportData.summary.roi.vesselVolumeFraction * 100).toFixed(3)}% vol, ${reportData.summary.roi.vesselLengthDensityMmPerCm3.toFixed(1)} mm/cm³.`,
              'info',
            );
          }

          const automationArtifacts = Object.values(fileMap).map((entry) => ({
            role: entry.role,
            file: entry.file,
          }));
          resolve({
            artifacts: automationArtifacts,
            measurements: reportData.summary.network,
            provenance: {
              method: 'lee94-taubin-inscribed-ellipsoid-voronoi',
              parameters,
            },
          });
        }
      };

      worker.onerror = (err) => {
        if (settled) {
          return;
        }
        settled = true;
        cleanup();
        const message = err?.message || 'Worker execution failed.';
        progress.end('Characterisation failed', { success: false });
        status(message, true);
        reject(new Error(message));
      };

      const transfers = [vesselBuffer];
      if (brainMaskBuffer) {
        transfers.push(brainMaskBuffer);
      }
      worker.postMessage(
        {
          runId,
          vesselBytes: vesselBuffer,
          brainMaskBytes: brainMaskBuffer,
          parameters,
          baseName: currentVesselFile.name,
        },
        transfers,
      );
    })();
  });
}

$('runButton').addEventListener('click', () => {
  if (vesselFile && !loadingController && !activeRunCancel) {
    void runCharacterisation().catch(() => {});
  }
});

// 8. WebMCP / NeuroFlow automation registration.
registerAppAutomation({
  app: APP.id,
  operations: {
    characterize: async ({ inputs, parameters, signal }) => {
      if (inputs.referenceImage?.length) {
        setReferenceFile(inputs.referenceImage[0]);
      } else {
        setReferenceFile(null);
      }
      if (inputs.brainMask?.length) {
        setBrainMaskFile(inputs.brainMask[0]);
      } else {
        setBrainMaskFile(null);
      }
      await loadVesselMaskFiles(Promise.resolve(inputs.vessels), signal);
      applyParametersToUi(parameters);
      return runCharacterisation(parameters, signal);
    },
  },
});

window.addEventListener('pagehide', () => {
  exampleControl.destroy();
  cancelActiveWork();
  viewerExtension?.dispose();
  nv?.destroy();
});

export default Object.freeze({ workspace, toolbar, log, info, results });
