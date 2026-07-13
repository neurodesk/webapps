import { FileIOController } from './controllers/FileIOController.js';
import { ViewerController } from './controllers/ViewerController.js';
import { InferenceExecutor } from './controllers/InferenceExecutor.js';
import { MaskDrawingController } from './controllers/MaskDrawingController.js';
import { LNM_PIPELINES, getPipelineById } from './app/lnm-tasks.js';
import {
  ATLAS_OPTIONS,
  DEFAULT_ATLAS_OPTION_ID,
  getAtlasOptionById
} from './app/atlas-options.js';
import {
  LESION_MASK_COLORMAP,
  LESION_MASK_COLORMAP_ID,
  SCHAEFER400_COLORMAP,
  YEO7_COLORMAP
} from './app/lnm-labels.js';
import { computeParcelOverlap, summarizeNetworkOverlap } from './modules/parcel-overlap.js';
import {
  loadAtlasFromManifest,
  loadConnectomeFromManifest,
  loadConnectomeChannelsFromManifest,
  decodeNiftiBuffer
} from './modules/atlas-loader.js';
import {
  fcWeightedSum,
  decodeFcPack,
  parcelResultToChannelWeights,
  summaryToNetworkWeights
} from './modules/fc-weighted-sum.js';
import { applyThresholdDetailed } from './modules/threshold.js';
import { affineFromHeader, resampleAffine } from './modules/resample.js';
import { centroidOfMask, applyAffineToVoxel, computePrealignAffine, principalAxisAlign } from './modules/prealign.js';
import { writeNifti1 } from './modules/nifti-writer.js';
import { resampleBinaryMask, writeBinaryMaskNifti } from './modules/mask-transform.js';
import {
  VOLUME_SPACES,
  atlasOptionSpace,
  atlasVolumeSpace,
  assertSameSpace,
  assertSpace,
  assertVolumeStackSpaces,
  getSpatialMetadata,
  tagSpatialFile
} from './modules/spatial-file.js';
import { serializeOverlapCsv } from './modules/overlap-export.js';
import { renderOverlapTable } from './modules/overlap-render.js';
import {
  loadFunctionProfilesFromManifest,
  rankFunctionalTerms,
  renderFunctionalProfileTable
} from './modules/function-profiles.js';
import { ConsoleOutput } from './modules/ui/ConsoleOutput.js';
import { ProgressManager } from '@neurodesk/webapp-components/ui';
import { ModalManager } from '@neurodesk/webapp-components/ui';
import * as Config from './app/config.js';

const NETWORK_TOP_PERCENT_MAX = 10;
const NETWORK_TOP_PERCENT_STEP = 0.1;
const MASK_DOWNLOAD_CACHE = 'lnm-mask-downloads-v1';
const MASK_DOWNLOAD_PATH = '__lnm_downloads';

function splitModelUrl(url) {
  const i = url.lastIndexOf('/');
  return { base: url.slice(0, i), name: url.slice(i + 1) };
}

function arrayBufferToFile(buffer, name, spatial = null) {
  // The worker emits uncompressed NIfTI bytes (createOutputNifti); files
  // ending in .nii are raw, .nii.gz are gzip-compressed. We use .nii.
  const blob = new Blob([buffer], { type: 'application/octet-stream' });
  const file = new File([blob], name, { type: 'application/octet-stream' });
  return spatial ? tagSpatialFile(file, spatial) : file;
}

function downloadSafeFilename(filename) {
  return String(filename || 'lnm-mask.nii').replace(/[^A-Za-z0-9._-]+/g, '_');
}

function bytesToBase64(bytes) {
  let binary = '';
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    const chunk = bytes.subarray(i, i + chunkSize);
    binary += String.fromCharCode(...chunk);
  }
  return globalThis.btoa(binary);
}

function binarise(typedArray) {
  const out = new Uint8Array(typedArray.length);
  for (let i = 0; i < typedArray.length; i++) {
    out[i] = typedArray[i] > 0 ? 1 : 0;
  }
  return out;
}

function foregroundMaskFromIntensity(data, dims = null, fractionOfMax = 0.05) {
  let max = -Infinity;
  for (let i = 0; i < data.length; i++) {
    const v = Number(data[i]);
    if (v > max) max = v;
  }
  const threshold = (Number.isFinite(max) ? max : 0) * fractionOfMax;
  const mask = new Uint8Array(data.length);
  let count = 0;
  for (let i = 0; i < data.length; i++) {
    if (Number(data[i]) > threshold) {
      mask[i] = 1;
      count++;
    }
  }
  if (count === 0) {
    let fallback = Math.floor(data.length / 2);
    if (Array.isArray(dims) && dims.length === 3) {
      const x = Math.min(Math.floor(dims[0] / 2), dims[0] - 1);
      const y = Math.min(Math.floor(dims[1] / 2), dims[1] - 1);
      const z = Math.min(Math.floor(dims[2] / 2), dims[2] - 1);
      fallback = x + y * dims[0] + z * dims[0] * dims[1];
    }
    if (fallback >= 0 && fallback < mask.length) mask[fallback] = 1;
  }
  return mask;
}

function dimsEqual(a, b) {
  return Array.isArray(a) && Array.isArray(b) &&
    a.length === b.length &&
    a.every((value, index) => value === b[index]);
}

function affineNearlyEqual(a, b, tolerance = 1e-3) {
  if (!Array.isArray(a) || !Array.isArray(b) || a.length < 3 || b.length < 3) return false;
  for (let r = 0; r < 3; r++) {
    if (!Array.isArray(a[r]) || !Array.isArray(b[r]) || a[r].length < 4 || b[r].length < 4) {
      return false;
    }
    for (let c = 0; c < 4; c++) {
      if (Math.abs(a[r][c] - b[r][c]) > tolerance) return false;
    }
  }
  return true;
}

function spacingFromHeader(header) {
  return [
    Math.abs(Number(header?.pixDims?.[1])) || 1,
    Math.abs(Number(header?.pixDims?.[2])) || 1,
    Math.abs(Number(header?.pixDims?.[3])) || 1
  ];
}

function flattenAffine3Rows(affine) {
  return [
    affine[0][0], affine[0][1], affine[0][2], affine[0][3],
    affine[1][0], affine[1][1], affine[1][2], affine[1][3],
    affine[2][0], affine[2][1], affine[2][2], affine[2][3]
  ];
}

function computeLabelSizes(atlasData, labelMap) {
  const sizes = {};
  for (let i = 0; i < atlasData.length; i++) {
    const label = atlasData[i];
    if (label === 0 || !Object.prototype.hasOwnProperty.call(labelMap, label)) continue;
    const network = labelMap[label];
    sizes[network] = (sizes[network] || 0) + 1;
  }
  return sizes;
}

function computeNetworkSizes(atlasData, networkLabels) {
  return computeLabelSizes(atlasData, networkLabels);
}

function summarizeParcelLabelOverlap(parcelResult, parcelLabels) {
  const labelMap = parcelLabels || {};
  const networks = parcelResult.parcels.map(parcel => ({
    network: Object.prototype.hasOwnProperty.call(labelMap, parcel.label)
      ? labelMap[parcel.label]
      : `Parcel ${parcel.label}`,
    voxelsInLesion: parcel.voxelsInLesion,
    fractionOfLesion: parcel.fractionOfLesion,
    parcels: [parcel.label]
  }));
  return { totalLesionVoxels: parcelResult.totalLesionVoxels, networks };
}

function labelMapForAtlas(atlas, atlasOption) {
  if (atlasOption?.weightSource === 'parcel') {
    return atlas.parcelLabels || atlas.manifestEntry?.parcelLabels || {};
  }
  return atlas.networkLabels || atlas.manifestEntry?.networkLabels || {};
}

function summarizeAtlasOverlap(parcelResult, atlas, atlasOption) {
  const labelMap = labelMapForAtlas(atlas, atlasOption);
  if (atlasOption?.weightSource === 'parcel') {
    return summarizeParcelLabelOverlap(parcelResult, labelMap);
  }
  return summarizeNetworkOverlap(parcelResult, labelMap);
}

function normalizeMinClusterVoxels(value) {
  const n = Math.floor(Number(value));
  return Number.isFinite(n) && n > 0 ? n : 0;
}

function filterSummaryByMinCluster(summary, minClusterVoxels = 0) {
  if (!summary || !Array.isArray(summary.networks)) return summary || null;
  const minVoxels = normalizeMinClusterVoxels(minClusterVoxels);
  if (minVoxels <= 1) return summary;
  return {
    ...summary,
    networks: summary.networks.filter(
      row => (Number(row?.voxelsInLesion) || 0) >= minVoxels
    )
  };
}

function atlasSpaceName(atlasOption) {
  return atlasOption?.displayName || 'selected atlas';
}

export function formatVersionLabel(version, buildInfo = null) {
  let label = version ? `v${version}` : '';
  const versionText = version || '';
  const bits = [];
  const sha = buildInfo?.sha || '';
  if (sha && !versionText.includes(sha)) bits.push(sha);
  // Production deploys set `branch` to the release tag (e.g. `v0.17.13`),
  // which duplicates the version. Only surface a branch that adds information.
  const branch = buildInfo?.branch || '';
  const isVersionTag = branch === label || branch === versionText || branch === `v${versionText}`;
  if (branch && branch !== 'main' && branch !== 'detached' && !isVersionTag) bits.push(branch);
  if (buildInfo?.dirty) bits.push('dirty');
  if (bits.length) label += ` (${bits.join(', ')})`;
  return label;
}

export class LesionNetworkMappingApp {
  constructor() {
    this.nv = new niivue.Niivue({
      ...Config.VIEWER_CONFIG,
      onLocationChange: (data) => this.updateViewerInfo(data)
    });

    this.console = new ConsoleOutput('consoleOutput', { copyButtonId: 'copyConsole' });
    this.technicalConsole = new ConsoleOutput('technicalConsoleOutput', {
      copyButtonId: 'copyTechnicalConsole',
      mirrorToBrowserConsole: false
    });
    this.progress = new ProgressManager(Config.PROGRESS_CONFIG);
    this.structuralFile = null;
    this.viewerBaseFile = null;
    this.nativeStructuralFile = null;
    this.deepIslesDwiFile = null;
    this.deepIslesAdcFile = null;
    this.deepIslesSeedFile = null;
    this.deepIslesSeedCompatibleWithNativeT1 = false;
    this.nativeStructuralInfo = null;
    this.fixedMni160Info = null;
    this.prealignSamplingAffine = null;
    this.lesionFile = null;
    this.overlapResult = null;
    this.brainmaskFile = null;     // populated by handleStageData('brainmask')
    this.nativeBrainmaskFile = null; // brain mask in nativeStructuralFile space for lesion-mask review
    this.lesionMaskFile = null;    // confirmed edited mask on fixed lnm-mni160
    this.lesionMaskConfirmed = false;
    this.autoLesionSeedFile = null;
    this.nativeLesionSeedFile = null;
    this.confirmedNativeLesionFile = null;
    this.maskReviewActive = false;
    this._pendingMaskResume = null;
    this.networkMapFile = null;    // Phase 4: populated by runFcNetworkMap
    this.networkMapData = null;    // Phase 5: raw Float32Array for re-thresholding
    this.networkMapDims = null;
    this.networkMapSpacing = null;
    this.networkMapAffine = null;
    this.networkMapBaseFile = null;
    this.networkMapLabelAtlas = null;
    this.thresholdedMaskFile = null; // Phase 5: thresholded binary NIfTI
    this.patientThresholdedMaskFile = null;
    this.patientAtlasFile = null;
    this.registrationTemplateFile = null;
    this.registeredT1MniFile = null;
    this.displacementMagnitudeFile = null;
    this.yeoAtlasMni160File = null;
    this.registrationCheckerboardFile = null;
    this.registrationQcMode = 'mni';
    this.registrationBlendValue = 0.5;
    this.affectedNetworkResult = null;
    this.functionProfiles = null;
    this._functionalProfileRenderPromise = Promise.resolve();
    this._thresholdPreviewTimer = null;
    this._thresholdPreviewRenderPromise = Promise.resolve();
    this._thresholdPreviewVersion = 0;
    this._thresholdProjectionWarningShown = false;
    this._inverseWarpQueue = Promise.resolve();
    this.hasRegistrationDisplacement = false;
    this.mniLesionFile = null;       // Phase 6: warped lesion at MNI160 1mm (pre-resample)
    this._mniLesionResolver = null;  // Phase 6: one-shot promise for warp-mask stage data
    this._perfStats = [];            // Phase 19: per-stage runtime markers
    this._perfRunStart = null;       // Phase 19: total runFullPipeline start
    this._lastClinicalLogMessage = null;
    this._stageDataResolvers = new Map();
    this._stepCompleteResolvers = new Map();
    this._preMaskReviewMultiplanarShowRender = null;
    this.manifest = null;          // populated lazily by ensureManifest()
    this.atlasOptions = ATLAS_OPTIONS;
    this.selectedAtlasOptionId = DEFAULT_ATLAS_OPTION_ID;
    // Run analysis is input-driven: structural T1 uses the full auto chain,
    // while researcher-mode atlas-grid masks auto-select the manual network-map path.
    this.selectedPipeline = getPipelineById('lnm-yeo-auto') || LNM_PIPELINES[0];
    this.viewerLayerVisibility = {
      structural: true,
      brainmask: true,
      lesion: true,
      threshold: true,
      atlasQc: true
    };

    this.executor = new InferenceExecutor({
      updateOutput: (msg) => this.updateOutput(msg),
      updateDebugOutput: (msg, options) => this.updateDebugOutput(msg, options),
      setProgress: (frac, label) => this.handleWorkerProgress(frac, label),
      onStageData: (data) => this.handleStageData(data),
      onStepComplete: (step) => this.handleStepComplete(step),
      onError: (msg) => {
        this.updateOutput(`Worker error: ${msg}`);
        this._rejectPendingWorkerWaits(msg);
      },
      onInitialized: () => this.updateDebugOutput('Inference worker ready.', { source: 'worker' })
    });
  }

  async init() {
    this.structuralFileIO = new FileIOController({
      updateOutput: (msg) => this.updateOutput(msg),
      onFileLoaded: (file) => this.setStructural(file)
    });
    this.lesionFileIO = new FileIOController({
      updateOutput: (msg) => this.updateOutput(msg),
      onFileLoaded: (file) => this.setLesion(file)
    });
    this.viewerController = new ViewerController({
      nv: this.nv,
      updateOutput: (msg) => this.updateOutput(msg)
    });
    this.maskDrawingController = new MaskDrawingController({
      nv: this.nv,
      defaultColormap: LESION_MASK_COLORMAP,
      updateOutput: (msg) => this.updateOutput(msg)
    });

    this.aboutModal = new ModalManager('aboutModal');
    this.privacyModal = new ModalManager('privacyModal');
    this.citationsModal = new ModalManager('citationsModal');

    await this.setupViewer();
    this.viewerController.registerSctColormap(YEO7_COLORMAP, 'lnm-yeo7');
    this.viewerController.registerSctColormap(SCHAEFER400_COLORMAP, 'lnm-schaefer400');
    this.viewerController.registerSctColormap(LESION_MASK_COLORMAP, LESION_MASK_COLORMAP_ID);
    this.bindEvents();
    this.populateAtlasSelect();
    this.populateVersionLabel();
    this.updateOutput('Ready.');
  }

  async setupViewer() {
    await this.nv.attachTo('gl1');
    this.nv.setMultiplanarPadPixels(5);
    this.nv.setSliceType(this.nv.sliceTypeMultiplanar);
    this.nv.setInterpolation(true);
    this.nv.drawScene();
  }

  bindEvents() {
    const structuralInput = document.getElementById('structuralFileInput');
    if (structuralInput) {
      structuralInput.addEventListener('change', (event) => {
        this.structuralFileIO.handleFiles(event.target.files);
      });
    }

    const deepIslesDwiInput = document.getElementById('deepIslesDwiFileInput');
    if (deepIslesDwiInput) {
      deepIslesDwiInput.addEventListener('change', (event) => {
        const file = event.target.files?.[0] || null;
        this.setDeepIslesInput('dwi', file)
          .catch(err => this.updateOutput(`DeepISLES DWI/TRACE input failed: ${err.message}`));
      });
    }
    const deepIslesAdcInput = document.getElementById('deepIslesAdcFileInput');
    if (deepIslesAdcInput) {
      deepIslesAdcInput.addEventListener('change', (event) => {
        const file = event.target.files?.[0] || null;
        this.setDeepIslesInput('adc', file)
          .catch(err => this.updateOutput(`DeepISLES ADC input failed: ${err.message}`));
      });
    }

    const lesionInput = document.getElementById('lesionFileInput');
    if (lesionInput) {
      lesionInput.addEventListener('change', (event) => {
        this.lesionFileIO.handleFiles(event.target.files);
      });
    }

    const atlasSelect = document.getElementById('atlasSelect');
    if (atlasSelect) {
      atlasSelect.value = this.selectedAtlasOptionId;
      atlasSelect.addEventListener('change', () => this.handleAtlasSelectionChange(atlasSelect.value));
    }

    const computeButton = document.getElementById('computeOverlapButton');
    if (computeButton) computeButton.addEventListener('click', () => this.runAtlasOverlap());

    const csvButton = document.getElementById('downloadOverlapCsv');
    if (csvButton) {
      csvButton.disabled = true;
      csvButton.addEventListener('click', () => this.exportCsv());
    }

    const runBrainBtn = document.getElementById('runBrainExtractionButton');
    if (runBrainBtn) {
      runBrainBtn.addEventListener('click', () => {
        this.runBrainExtraction().catch(
          err => this.updateOutput(`Brain extraction failed: ${err.message}`)
        );
      });
    }
    const downloadBrainBtn = document.getElementById('downloadBrainMaskButton');
    if (downloadBrainBtn) {
      downloadBrainBtn.disabled = true;
      downloadBrainBtn.addEventListener('click', () => this.downloadBrainMask());
    }

    const runLesionBtn = document.getElementById('runLesionSegmentationButton');
    if (runLesionBtn) {
      runLesionBtn.addEventListener('click', () => {
        this.runLesionSegmentation()
          .then(() => this.startLesionMaskReview({ seedFile: this.autoLesionSeedFile }))
          .catch(err => this.updateOutput(`Lesion segmentation failed: ${err.message}`));
      });
    }
    const runDeepIslesBtn = document.getElementById('runDeepIslesSegmentationButton');
    if (runDeepIslesBtn) {
      runDeepIslesBtn.addEventListener('click', () => {
        this.runDeepIslesSegmentation()
          .then(() => {
            if (this.deepIslesSeedCompatibleWithNativeT1) {
              return this.startLesionMaskReview({ seedFile: this.autoLesionSeedFile });
            }
            return null;
          })
          .catch(err => this.updateOutput(`DeepISLES lesion seed failed: ${err.message}`));
      });
    }
    const manualMaskBtn = document.getElementById('startManualMaskButton');
    if (manualMaskBtn) {
      manualMaskBtn.addEventListener('click', () => {
        this.startLesionMaskReview({ blank: true })
          .catch(err => this.updateOutput(`Manual mask failed: ${err.message}`));
      });
    }
    const manualMaskInput = document.getElementById('manualMaskFileInput');
    const openManualMaskInput = () => {
      if (!manualMaskInput) {
        this.updateOutput('Manual mask upload input is unavailable.');
        return;
      }
      manualMaskInput.click();
    };
    for (const id of ['uploadManualMaskButton', 'uploadReviewMaskButton']) {
      const button = document.getElementById(id);
      if (button) button.addEventListener('click', openManualMaskInput);
    }
    if (manualMaskInput) {
      manualMaskInput.addEventListener('change', (event) => {
        const file = event.target.files?.[0] || null;
        if (!file) return;
        this.startUploadedLesionMaskReview(file)
          .catch(err => this.updateOutput(
            `Manual mask input failed for ${file.name || 'selected file'}: ` +
            `${err.message}. Choose a NIfTI mask file (.nii or .nii.gz).`
          ))
          .finally(() => { event.target.value = ''; });
      });
    }
    const downloadLesionBtn = document.getElementById('downloadLesionMaskButton');
    if (downloadLesionBtn) {
      downloadLesionBtn.disabled = true;
      downloadLesionBtn.addEventListener('click', () => {
        this.downloadLesionMask()
          .catch(err => this.updateOutput(`Lesion mask download failed: ${err.message}`));
      });
    }

    const runRegBtn = document.getElementById('runRegistrationButton');
    if (runRegBtn) {
      runRegBtn.addEventListener('click', () => {
        this.runRegistration().catch(
          err => this.updateOutput(`Registration failed: ${err.message}`)
        );
      });
    }

    const checkAtlasAlignmentBtn = document.getElementById('checkAtlasAlignmentButton');
    if (checkAtlasAlignmentBtn) {
      checkAtlasAlignmentBtn.disabled = true;
      checkAtlasAlignmentBtn.addEventListener('click', () => {
        this.showRegistrationQc().catch(
          err => this.updateOutput(`Atlas alignment QC failed: ${err.message}`)
        );
      });
    }

    const registrationQcMode = document.getElementById('registrationQcMode');
    if (registrationQcMode) {
      this.registrationQcMode = registrationQcMode.value || this.registrationQcMode;
      registrationQcMode.addEventListener('change', () => {
        this.registrationQcMode = registrationQcMode.value || 'patient';
        if (this.hasRegistrationDisplacement) {
          this.showRegistrationQc().catch(
            err => this.updateOutput(`Registration QC failed: ${err.message}`)
          );
        }
      });
    }
    const registrationBlendValue = document.getElementById('registrationBlendValue');
    if (registrationBlendValue) {
      this.registrationBlendValue = this.getRegistrationBlendValue();
      this.updateRegistrationBlendLabel(this.registrationBlendValue);
      const handleRegistrationBlendInput = () => {
        this.handleRegistrationBlendInput().catch(
          err => this.updateOutput(`Registration blend update failed: ${err.message}`)
        );
      };
      registrationBlendValue.addEventListener('input', handleRegistrationBlendInput);
      registrationBlendValue.addEventListener('change', handleRegistrationBlendInput);
    }

    const applyRegBtn = document.getElementById('applyRegistrationToLesionButton');
    if (applyRegBtn) {
      applyRegBtn.addEventListener('click', () => {
        this.applyRegistrationToLesion().catch(
          err => this.updateOutput(`Apply registration failed: ${err.message}`)
        );
      });
    }

    const prealignBtn = document.getElementById('prealignToMniButton');
    if (prealignBtn) {
      prealignBtn.addEventListener('click', () => {
        this.prealignToMni160().catch(
          err => this.updateOutput(`Prealign failed: ${err.message}`)
        );
      });
    }

    const runFullBtn = document.getElementById('runFullPipelineButton');
    if (runFullBtn) {
      runFullBtn.addEventListener('click', () => {
        this.runFullPipeline().catch(
          err => this.updateOutput(`Full pipeline failed: ${err.message}`)
        );
      });
    }

    // Phase 14: cancel button terminates the worker. The executor's
    // cancel() rejects pending restores + clears running-step state and
    // surfaces a 'Cancelled' status. Disabled state is driven from
    // handleWorkerProgress / handleStepComplete.
    const cancelBtn = document.getElementById('cancelButton');
    if (cancelBtn) {
      cancelBtn.disabled = true;
      cancelBtn.addEventListener('click', () => {
        try { this.executor.cancel(); }
        catch (err) { this.updateOutput(`Cancel failed: ${err.message}`); }
      });
    }

    const clearBtn = document.getElementById('clearResultsButton');
    if (clearBtn) {
      clearBtn.addEventListener('click', () => this.clearResults({ full: false }));
    }

    const runFcBtn = document.getElementById('computeNetworkMapButton');
    if (runFcBtn) {
      runFcBtn.addEventListener('click', () => {
        this.runFcNetworkMap().catch(
          err => this.updateOutput(`Network map failed: ${err.message}`)
        );
      });
    }
    const downloadFcBtn = document.getElementById('downloadNetworkMapButton');
    if (downloadFcBtn) {
      downloadFcBtn.disabled = true;
      downloadFcBtn.addEventListener('click', () => this.downloadNetworkMap());
    }

    const thresholdValue = document.getElementById('networkThresholdValue');
    const thresholdSym = document.getElementById('networkThresholdSymmetric');
    const thresholdMinCluster = document.getElementById('networkThresholdMinCluster');
    const triggerThresholdRecompute = () => {
      this.updateThresholdValueLabel();
      if (this.networkMapData) {
        try { this.applyNetworkThreshold(); }
        catch (err) { this.updateOutput(`Threshold failed: ${err.message}`); }
      }
    };
    const triggerResultsFilterRecompute = () => {
      this.updateThresholdValueLabel();
      if (this.overlapResult) {
        this.renderDirectOverlapTable();
        this.updateDirectFunctionProfile();
      }
      if (this.networkMapData) {
        try { this.applyNetworkThreshold(); }
        catch (err) { this.updateOutput(`Threshold failed: ${err.message}`); }
      } else if (this.affectedNetworkResult) {
        this.renderAffectedNetworkTable();
        this.updateAffectedFunctionProfile();
      }
    };
    if (thresholdValue) thresholdValue.addEventListener('input', triggerThresholdRecompute);
    if (thresholdSym) thresholdSym.addEventListener('change', triggerThresholdRecompute);
    if (thresholdMinCluster) {
      thresholdMinCluster.addEventListener('input', triggerResultsFilterRecompute);
      thresholdMinCluster.addEventListener('change', triggerResultsFilterRecompute);
    }
    this.configureTopPercentThresholdSlider();
    this.updateThresholdValueLabel();

    const downloadThreshBtn = document.getElementById('downloadThresholdedNetworkMapButton');
    if (downloadThreshBtn) {
      downloadThreshBtn.disabled = true;
      downloadThreshBtn.addEventListener('click', () => this.downloadThresholdedNetworkMap());
    }

    const showAtlasQcBtn = document.getElementById('showSubjectAtlasButton');
    if (showAtlasQcBtn) {
      showAtlasQcBtn.disabled = true;
      showAtlasQcBtn.addEventListener('click', () => {
        this.showSubjectSpaceAtlas().catch(
          err => this.updateOutput(`Subject-space atlas failed: ${err.message}`)
        );
      });
    }

    const downloadAtlasQcBtn = document.getElementById('downloadSubjectAtlasButton');
    if (downloadAtlasQcBtn) {
      downloadAtlasQcBtn.disabled = true;
      downloadAtlasQcBtn.addEventListener('click', () => this.downloadSubjectSpaceAtlas());
    }

    const copyConsole = document.getElementById('copyConsole');
    if (copyConsole) copyConsole.addEventListener('click', () => this.console.copyToClipboard());

    const clearConsole = document.getElementById('clearConsole');
    if (clearConsole) clearConsole.addEventListener('click', () => this.console.clear());

    const copyTechnicalConsole = document.getElementById('copyTechnicalConsole');
    if (copyTechnicalConsole) {
      copyTechnicalConsole.addEventListener('click', () => this.technicalConsole.copyToClipboard());
    }

    const clearTechnicalConsole = document.getElementById('clearTechnicalConsole');
    if (clearTechnicalConsole) {
      clearTechnicalConsole.addEventListener('click', () => this.technicalConsole.clear());
    }

    document.querySelectorAll('.view-tab[data-view]').forEach(button => {
      button.addEventListener('click', () => {
        const view = button.dataset.view;
        if (this.maskReviewActive && view === 'render') {
          this.setViewerView('multiplanar');
          this.updateOutput('3D render view is hidden while reviewing the editable lesion mask.');
          return;
        }
        this.setViewerView(view);
      });
    });

    const overlayOpacity = document.getElementById('overlayOpacity');
    if (overlayOpacity) {
      overlayOpacity.addEventListener('input', (event) => {
        const value = parseFloat(event.target.value);
        this.viewerController.setOverlayOpacity(value);
        const display = document.getElementById('overlayOpacityValue');
        if (display) display.textContent = `${Math.round(value * 100)}%`;
      });
    }

    this.bindViewerLayerToggles();

    const interpolation = document.getElementById('interpolation');
    if (interpolation) {
      interpolation.addEventListener('change', (event) => {
        this.nv.setInterpolation(!event.target.checked);
        this.nv.drawScene();
      });
    }

    const colorbarToggle = document.getElementById('colorbarToggle');
    if (colorbarToggle) {
      colorbarToggle.addEventListener('change', (event) => {
        this.nv.opts.isColorbar = event.target.checked;
        this.nv.drawScene();
      });
    }

    const crosshairToggle = document.getElementById('crosshairToggle');
    if (crosshairToggle) {
      crosshairToggle.addEventListener('change', (event) => {
        this.nv.setCrosshairWidth(event.target.checked ? 1 : 0);
      });
    }

    const colormapSelect = document.getElementById('colormapSelect');
    if (colormapSelect) {
      colormapSelect.addEventListener('change', (event) => {
        if (this.nv.volumes?.[0]) {
          this.nv.volumes[0].colormap = event.target.value;
          this.nv.updateGLVolume();
        }
      });
    }

    this.bindMaskDrawingControls();
    this.bindStartPageControls();
    this.bindModalButton('aboutButton', this.aboutModal);
    this.bindModalButton('privacyButton', this.privacyModal);
    this.bindModalButton('startPrivacyButton', this.privacyModal);
    this.bindModalButton('startPrivacyInlineButton', this.privacyModal);
    this.bindModalButton('citationsButton', this.citationsModal);
    this.bindModalButton('startCitationsButton', this.citationsModal);
    this.bindCloseButton('closeAbout', this.aboutModal);
    this.bindCloseButton('closePrivacy', this.privacyModal);
    this.bindCloseButton('closeCitations', this.citationsModal);
  }

  getAtlasOption() {
    return getAtlasOptionById(this.selectedAtlasOptionId, this.atlasOptions) ||
      this.atlasOptions[0] ||
      ATLAS_OPTIONS[0];
  }

  getAtlasColormap(atlasOption = this.getAtlasOption()) {
    return atlasOption?.id === 'schaefer400' ? SCHAEFER400_COLORMAP : YEO7_COLORMAP;
  }

  populateAtlasSelect() {
    const select = document.getElementById('atlasSelect');
    if (!select) return;
    const existing = new Set(Array.from(select.options).map(option => option.value));
    for (const option of this.atlasOptions) {
      if (existing.has(option.id)) continue;
      const item = document.createElement('option');
      item.value = option.id;
      item.textContent = option.displayName;
      select.appendChild(item);
    }
    select.value = this.selectedAtlasOptionId;
  }

  handleAtlasSelectionChange(value) {
    const option = getAtlasOptionById(value, this.atlasOptions);
    if (!option) return;
    this.selectedAtlasOptionId = option.id;
    this.overlapResult = null;
    this.affectedNetworkResult = null;
    this.networkMapFile = null;
    this.networkMapData = null;
    this.networkMapDims = null;
    this.networkMapSpacing = null;
    this.networkMapAffine = null;
    this.networkMapBaseFile = null;
    this.networkMapLabelAtlas = null;
    this.thresholdedMaskFile = null;
    this.patientThresholdedMaskFile = null;
    this.patientAtlasFile = null;
    this.functionProfiles = null;
    this.clearAffectedNetworkTable();
    this.clearFunctionProfileTable('directFunctionProfileResults', 'directFunctionProfileTable');
    const csvButton = document.getElementById('downloadOverlapCsv');
    if (csvButton) csvButton.disabled = true;
    this.showAtlasCoverageNote(0, 0);
    this.updateOutput(`Atlas set to ${option.displayName}.`);
  }

  bindModalButton(buttonId, modal) {
    const button = document.getElementById(buttonId);
    if (button) button.addEventListener('click', () => modal.open());
  }

  bindStartPageControls() {
    const startPage = document.getElementById('startPage');
    const enterButton = document.getElementById('enterAppButton');
    if (!startPage || !enterButton) return;

    enterButton.addEventListener('click', () => {
      startPage.classList.add('hidden');
      document.getElementById('structuralFileInput')?.focus();
      requestAnimationFrame(() => {
        window.dispatchEvent(new Event('resize'));
        this.nv.drawScene();
      });
    });
  }

  bindCloseButton(buttonId, modal) {
    const button = document.getElementById(buttonId);
    if (button) button.addEventListener('click', () => modal.close());
  }

  bindMaskDrawingControls() {
    const bindClick = (id, fn) => {
      const el = document.getElementById(id);
      if (el) el.addEventListener('click', fn);
    };
    bindClick('maskPaintButton', () => this.setMaskDrawingTool('paint'));
    bindClick('maskEraseButton', () => this.setMaskDrawingTool('erase'));
    bindClick('maskEraseClusterButton', () => this.setMaskDrawingTool('eraseCluster'));
    bindClick('maskUndoButton', () => this.maskDrawingController?.undo());
    bindClick('maskBlankButton', () => {
      this.startLesionMaskReview({ blank: true })
        .catch(err => this.updateOutput(`Blank mask failed: ${err.message}`));
    });
    bindClick('maskSmoothButton', () => {
      if (!this.maskDrawingController?.smoothDrawing()) {
        this.updateOutput('Smooth mask needs an editable drawing.');
      }
    });
    bindClick('maskInterpolateButton', () => {
      const axis = Number(document.getElementById('maskInterpolateAxis')?.value || 0);
      if (!this.maskDrawingController?.interpolateAcrossSlices(axis)) {
        this.updateOutput('Interpolate needs at least two drawn slices on the selected axis.');
      }
    });
    bindClick('confirmLesionMaskButton', () => {
      this.confirmLesionDrawing({ resumePipeline: true })
        .catch(err => this.updateOutput(`Confirm lesion mask failed: ${err.message}`));
    });
    bindClick('downloadEditedLesionMaskButton', () => {
      this.downloadEditedLesionMask()
        .catch(err => this.updateOutput(`Edited mask download failed: ${err.message}`));
    });

    const brush = document.getElementById('maskBrushSize');
    if (brush) {
      brush.addEventListener('input', () => {
        const size = this.maskDrawingController?.setBrushSize(brush.value) || 1;
        const label = document.getElementById('maskBrushSizeLabel');
        if (label) label.textContent = `${size} vox`;
      });
    }
    const filled = document.getElementById('maskFilledToggle');
    if (filled) {
      filled.addEventListener('change', () => {
        this.maskDrawingController?.setFilled(filled.checked);
      });
    }
    const shape = document.getElementById('maskShapeSelect');
    if (shape) {
      shape.addEventListener('change', () => {
        this.maskDrawingController?.setPenShape(shape.value);
      });
    }
    this.refreshMaskDrawingControls();
  }

  setMaskDrawingTool(tool) {
    this.maskDrawingController?.ensureDrawing();
    this.maskDrawingController?.setTool(tool);
    for (const id of ['maskPaintButton', 'maskEraseButton', 'maskEraseClusterButton']) {
      const el = document.getElementById(id);
      if (el) el.classList.remove('active');
    }
    const activeId = tool === 'erase'
      ? 'maskEraseButton'
      : tool === 'eraseCluster'
        ? 'maskEraseClusterButton'
        : 'maskPaintButton';
    document.getElementById(activeId)?.classList.add('active');
  }

  refreshMaskDrawingControls() {
    const toolbar = document.getElementById('maskDrawingToolbar');
    const available = !!(
      this.maskReviewActive &&
      (this.nativeStructuralFile || this.structuralFile || this.autoLesionSeedFile || this.confirmedNativeLesionFile)
    );
    if (toolbar) toolbar.classList.toggle('hidden', !available);
    const banner = document.getElementById('maskApprovalBanner');
    if (banner) banner.classList.toggle('hidden', !available);
    const confirm = document.getElementById('confirmLesionMaskButton');
    if (confirm) confirm.disabled = !available;
    const uploadReview = document.getElementById('uploadReviewMaskButton');
    if (uploadReview) uploadReview.disabled = !available;
    const download = document.getElementById('downloadEditedLesionMaskButton');
    const downloadAvailable = !!(this.confirmedNativeLesionFile || this.maskDrawingController?.hasDrawing);
    if (download) download.disabled = !downloadAvailable;
    const status = document.getElementById('maskReviewStatus');
    if (status) {
      status.textContent = this.maskReviewActive
        ? 'Review lesion mask'
        : this.lesionMaskConfirmed
          ? 'Mask confirmed'
          : available
            ? 'Mask tools ready'
            : '';
    }
  }

  getViewerLayerControlConfig() {
    return [
      { layer: 'structural', id: 'layerToggleT1', stages: ['structural'] },
      { layer: 'brainmask', id: 'layerToggleBrainMask', stages: ['brainmask'] },
      { layer: 'lesion', id: 'layerToggleLesionMask', stages: ['segmentation', 'lesion'] },
      { layer: 'threshold', id: 'layerToggleThresholdMap', stages: ['threshold-preview'] },
      { layer: 'atlasQc', id: 'layerToggleAtlasQc', stages: ['atlas-qc'] }
    ];
  }

  bindViewerLayerToggles() {
    for (const config of this.getViewerLayerControlConfig()) {
      const el = document.getElementById(config.id);
      if (!el) continue;
      el.addEventListener('change', (event) => {
        this.viewerLayerVisibility[config.layer] = !!event.target.checked;
        if (event.target.checked) {
          this.ensureViewerLayerLoaded(config.layer)
            .then(() => {
              this.applyViewerLayerVisibility(config.layer);
              this.refreshViewerLayerControls();
            })
            .catch(err => {
              this.viewerLayerVisibility[config.layer] = false;
              this.updateOutput(`Could not show ${this.getViewerLayerLabel(config.layer)}: ${err.message}`);
              this.refreshViewerLayerControls();
            });
        } else {
          this.applyViewerLayerVisibility(config.layer);
          this.refreshViewerLayerControls();
        }
      });
    }
    this.refreshViewerLayerControls();
  }

  isViewerStageLoaded(stage) {
    if (!stage || !this.viewerController?.getVolumeIndexForStage) return false;
    return this.viewerController.getVolumeIndexForStage(stage) !== null;
  }

  getViewerLayerAvailable(layer, config = null) {
    const layerConfig = config || this.getViewerLayerControlConfig().find(item => item.layer === layer);
    const stageLoaded = layerConfig?.stages?.some(stage => this.isViewerStageLoaded(stage)) || false;
    if (layer === 'lesion') {
      return stageLoaded || !!(
        (this.maskReviewActive && this.maskDrawingController?.hasDrawing) ||
        this.confirmedNativeLesionFile ||
        this.lesionMaskFile ||
        this.lesionFile
      );
    }
    if (stageLoaded) return true;
    switch (layer) {
      case 'structural':
        return !!this.structuralFile;
      case 'brainmask':
        return !!this.getBrainmaskFileForActiveViewer();
      case 'threshold':
        return !!(this.patientThresholdedMaskFile || this.thresholdedMaskFile);
      case 'atlasQc':
        return !!(
          this.patientAtlasFile ||
          (this.structuralFile && this.hasRegistrationDisplacement && this.executor?.runInverseWarpMask)
        );
      default:
        return false;
    }
  }

  isViewerLayerLoaded(layer, config = null) {
    const layerConfig = config || this.getViewerLayerControlConfig().find(item => item.layer === layer);
    const stageLoaded = layerConfig?.stages?.some(stage => this.isViewerStageLoaded(stage)) || false;
    if (layer === 'lesion') {
      return stageLoaded || !!(this.maskReviewActive && this.maskDrawingController?.hasDrawing);
    }
    return stageLoaded;
  }

  getViewerLayerLabel(layer) {
    return {
      structural: 'T1',
      brainmask: 'brain mask',
      lesion: 'lesion mask',
      threshold: 'threshold map',
      atlasQc: 'atlas'
    }[layer] || layer;
  }

  async ensureViewerLayerLoaded(layer) {
    if (this.isViewerLayerLoaded(layer)) return;
    if (layer === 'structural') {
      if (!this.structuralFile) throw new Error('No structural T1 is available.');
      await this.loadViewerBaseVolume(this.structuralFile, {
        stage: 'structural',
        visible: this.layerVisible('structural')
      });
      return;
    }
    if (!this.isViewerStageLoaded('structural')) {
      throw new Error('Load a structural T1 base before adding overlays.');
    }
    if (layer === 'brainmask') {
      const brainmaskFile = this.getBrainmaskFileForActiveViewer();
      if (!brainmaskFile) {
        throw new Error(this.maskReviewActive
          ? 'No native-space brain mask is available for mask review.'
          : 'No brain mask is available.');
      }
      this.assertViewerOverlaySpace(brainmaskFile, 'Brain mask overlay');
      await this.viewerController.loadOverlay(brainmaskFile, 'green', 0.4, {
        stage: 'brainmask',
        visible: this.layerVisible('brainmask')
      });
      return;
    }
    if (layer === 'lesion') {
      if (this.maskReviewActive && this.maskDrawingController?.hasDrawing) return;
      const lesionOverlay = this.getLesionFileForActiveViewer();
      if (!lesionOverlay) throw new Error('No lesion mask is available.');
      this.assertViewerOverlaySpace(lesionOverlay, 'Lesion mask overlay');
      await this.viewerController.loadOverlay(lesionOverlay, LESION_MASK_COLORMAP_ID, 0.5, {
        stage: this.getLesionViewerStage(lesionOverlay),
        visible: this.layerVisible('lesion')
      });
      return;
    }
    if (layer === 'threshold') {
      const thresholdFile = this.patientThresholdedMaskFile || this.thresholdedMaskFile;
      if (!thresholdFile) throw new Error('No threshold map is available.');
      this.assertViewerOverlaySpace(thresholdFile, 'Threshold map overlay');
      await this.viewerController.loadOverlay(thresholdFile, 'red', 0.65, {
        stage: 'threshold-preview',
        visible: this.layerVisible('threshold')
      });
      return;
    }
    if (layer === 'atlasQc') {
      if (!this.patientAtlasFile) {
        await this.projectAtlasToPatientSpace();
      }
      if (!this.patientAtlasFile) throw new Error('No atlas projection is available.');
      this.assertViewerOverlaySpace(this.patientAtlasFile, 'Atlas QC overlay');
      await this.viewerController.loadOverlay(this.patientAtlasFile, this.getAtlasOption().colormap, 0.45, {
        stage: 'atlas-qc',
        visible: this.layerVisible('atlasQc')
      });
    }
  }

  refreshViewerLayerControls() {
    for (const config of this.getViewerLayerControlConfig()) {
      const el = document.getElementById(config.id);
      if (!el) continue;
      const available = this.getViewerLayerAvailable(config.layer, config);
      el.disabled = !available;
      el.checked = available &&
        this.isViewerLayerLoaded(config.layer, config) &&
        this.viewerLayerVisibility[config.layer] !== false;
    }
    this.refreshSubjectAtlasControls();
  }

  refreshSubjectAtlasControls() {
    const canProject = !!(
      this.structuralFile &&
      this.hasRegistrationDisplacement &&
      this.executor?.runInverseWarpMask
    );
    const showBtn = document.getElementById('showSubjectAtlasButton');
    if (showBtn) showBtn.disabled = !canProject;
    const checkBtn = document.getElementById('checkAtlasAlignmentButton');
    if (checkBtn) checkBtn.disabled = !canProject;
    const downloadBtn = document.getElementById('downloadSubjectAtlasButton');
    if (downloadBtn) downloadBtn.disabled = !this.patientAtlasFile;
  }

  applyViewerLayerVisibility(layer = null) {
    if (this.viewerController?.setStageVisible) {
      for (const config of this.getViewerLayerControlConfig()) {
        if (layer && config.layer !== layer) continue;
        const visible = this.viewerLayerVisibility[config.layer] !== false;
        for (const stage of config.stages) {
          this.viewerController.setStageVisible(stage, visible);
        }
      }
    }
    if (!layer || layer === 'lesion') this.applyMaskDrawingVisibility();
  }

  layerVisible(layer) {
    return this.viewerLayerVisibility[layer] !== false;
  }

  setViewerView(view) {
    if (!view) return;
    document.querySelectorAll('.view-tab[data-view]').forEach(tab => {
      tab.classList.toggle('active', tab.dataset.view === view);
    });
    this.viewerController?.setViewType?.(view);
  }

  setMaskReview3DRenderEnabled(enabled) {
    if (!this.nv?.opts) return;
    const showRenderNever = globalThis.niivue?.SHOW_RENDER?.NEVER ?? 0;
    if (!enabled) {
      if (this._preMaskReviewMultiplanarShowRender === null) {
        this._preMaskReviewMultiplanarShowRender = this.nv.opts.multiplanarShowRender;
      }
      this.nv.opts.multiplanarShowRender = showRenderNever;
      if (this.nv.opts.sliceType === this.nv.sliceTypeRender) {
        this.setViewerView('multiplanar');
      } else {
        this.nv.drawScene?.();
      }
      return;
    }
    if (this._preMaskReviewMultiplanarShowRender !== null) {
      this.nv.opts.multiplanarShowRender = this._preMaskReviewMultiplanarShowRender;
      this._preMaskReviewMultiplanarShowRender = null;
      this.nv.drawScene?.();
    }
  }

  tagFileSpace(file, { space, role, sourceStage, dims, affine } = {}) {
    return tagSpatialFile(file, {
      space,
      role,
      sourceStage,
      dims,
      affine
    });
  }

  tagDecodedFileSpace(file, decoded, spatial = {}) {
    return this.tagFileSpace(file, {
      ...spatial,
      dims: decoded?.dims,
      affine: decoded?.header ? affineFromHeader(decoded.header) : undefined
    });
  }

  async loadViewerBaseVolume(file, options = {}) {
    await this.viewerController.loadBaseVolume(file, options);
    this.viewerBaseFile = file;
  }

  async loadViewerVolumeStack(entries = []) {
    await this.viewerController.loadVolumeStack(entries);
    this.viewerBaseFile = entries[0]?.file || null;
  }

  getActiveViewerBaseFile() {
    return this.viewerBaseFile || this.structuralFile;
  }

  structuralSpace() {
    return getSpatialMetadata(this.structuralFile)?.space ||
      (this.structuralFile && this.structuralFile === this.nativeStructuralFile ? VOLUME_SPACES.NATIVE_T1 : null);
  }

  assertViewerOverlaySpace(overlayFile, context) {
    return assertSameSpace(this.getActiveViewerBaseFile(), overlayFile, context);
  }

  assertViewerStackSpaces(entries, context) {
    return assertVolumeStackSpaces(entries, context);
  }

  getBrainmaskFileForActiveViewer() {
    const baseFile = this.getActiveViewerBaseFile();
    const baseSpace = getSpatialMetadata(baseFile)?.space;
    if (baseFile === this.nativeStructuralFile || baseSpace === VOLUME_SPACES.NATIVE_T1) {
      if (this.nativeBrainmaskFile) return this.nativeBrainmaskFile;
      return this.structuralFile === this.nativeStructuralFile ? this.brainmaskFile : null;
    }
    if (this.maskReviewActive) {
      if (this.nativeBrainmaskFile) return this.nativeBrainmaskFile;
      return this.structuralFile === this.nativeStructuralFile ? this.brainmaskFile : null;
    }
    return this.brainmaskFile;
  }

  getLesionFileForActiveViewer() {
    if (this.maskReviewActive) return null;
    const baseFile = this.getActiveViewerBaseFile();
    const baseSpace = getSpatialMetadata(baseFile)?.space;
    if (
      this.confirmedNativeLesionFile &&
      (baseFile === this.nativeStructuralFile || baseSpace === VOLUME_SPACES.NATIVE_T1)
    ) {
      return this.confirmedNativeLesionFile;
    }
    return this.lesionMaskFile || this.lesionFile || this.confirmedNativeLesionFile;
  }

  getLesionViewerStage(file) {
    return (file === this.lesionMaskFile || file === this.confirmedNativeLesionFile)
      ? 'segmentation'
      : 'lesion';
  }

  async renderConfirmedNativeLesionOverlay() {
    if (!this.confirmedNativeLesionFile || !this.viewerController?.loadOverlay) return;
    const baseFile = this.nativeStructuralFile || this.structuralFile;
    if (!baseFile) return;
    if (this.getActiveViewerBaseFile() !== baseFile) {
      await this.loadViewerBaseVolume(baseFile, {
        stage: 'structural',
        visible: this.layerVisible('structural')
      });
    }
    this.assertViewerOverlaySpace(this.confirmedNativeLesionFile, 'Confirmed lesion mask overlay');
    await this.viewerController.loadOverlay(this.confirmedNativeLesionFile, LESION_MASK_COLORMAP_ID, 0.5, {
      stage: 'segmentation',
      visible: this.layerVisible('lesion')
    });
  }

  applyMaskDrawingVisibility() {
    if (!this.maskDrawingController?.setVisible) return;
    this.maskDrawingController.setVisible(this.maskReviewActive && this.layerVisible('lesion'));
  }

  // Phase 13 + Phase 40: populate every visible version slot from
  // Config.VERSION. Best-effort augment with build-info.json (written
  // by web/run.sh for local dev + by .github/workflows/ for deploys)
  // to surface the commit SHA / branch / dirty flag.
  //
  //   local dev    -> "v0.17.0 (abc1234, dirty)" on main
  //   staging      -> "v0.17.0-staging+abc1234"  (sed'd by deploy-pages.yml)
  //                   with build-info.json SHA suppressed as duplicate
  //   production   -> "v0.17.0" (release-tag build; build-info.json may
  //                   carry the tag SHA)
  //
  // build-info.json is fetched best-effort — a 404 falls back to just
  // VERSION, so the static deploy works whether or not the file exists.
  async populateVersionLabel() {
    let buildInfo = null;
    try {
      const r = await fetch('build-info.json', { cache: 'no-store' });
      if (r.ok) {
        buildInfo = await r.json();
      }
    } catch (e) { /* best-effort: silent fallback to VERSION */ }
    const label = formatVersionLabel(Config.VERSION, buildInfo);
    const ids = ['aboutAppVersion', 'appVersion', 'footerVersion'];
    for (const id of ids) {
      const el = document.getElementById(id);
      if (el) el.textContent = label;
    }
  }

  async setStructural(file) {
    if (!file) return;
    this.tagFileSpace(file, {
      space: VOLUME_SPACES.NATIVE_T1,
      role: 'structural',
      sourceStage: 'input'
    });
    this.structuralFile = file;
    this.nativeStructuralFile = file;
    this.nativeStructuralInfo = null;
    this.fixedMni160Info = null;
    this.prealignSamplingAffine = null;
    this.deepIslesSeedFile = null;
    this.deepIslesSeedCompatibleWithNativeT1 = false;
    this.autoLesionSeedFile = null;
    this.nativeLesionSeedFile = null;
    this.confirmedNativeLesionFile = null;
    this.lesionMaskFile = null;
    this.lesionMaskConfirmed = false;
    this.maskReviewActive = false;
    this.setMaskReview3DRenderEnabled(true);
    this._pendingMaskResume = null;
    this.hasRegistrationDisplacement = false;
    this.patientThresholdedMaskFile = null;
    this.patientAtlasFile = null;
    this.registeredT1MniFile = null;
    this.displacementMagnitudeFile = null;
    this.registrationCheckerboardFile = null;
    this._thresholdProjectionWarningShown = false;
    await this.loadViewerBaseVolume(file, {
      stage: 'structural',
      visible: this.layerVisible('structural')
    });
    this.refreshViewerLayerControls();
    this.refreshMaskDrawingControls();
    this.updateOutput(`Structural image ready: ${file.name}`);
    // Phase 31: auto-promote the pipeline selection. A structural T1
    // means the explicit Run analysis action should use the full auto chain.
    this._autoPromotePipeline('lnm-yeo-auto');
  }

  async setDeepIslesInput(kind, file) {
    if (!file) return null;
    if (kind !== 'dwi' && kind !== 'adc') {
      throw new Error(`Unknown DeepISLES input kind '${kind}'.`);
    }
    const decoded = await decodeNiftiBuffer(await file.arrayBuffer());
    this.tagDecodedFileSpace(file, decoded, {
      space: VOLUME_SPACES.NATIVE_DWI,
      role: kind === 'dwi' ? 'deepisles-dwi' : 'deepisles-adc',
      sourceStage: 'deepisles-input'
    });
    if (kind === 'dwi') this.deepIslesDwiFile = file;
    else this.deepIslesAdcFile = file;
    this.deepIslesSeedFile = null;
    this.deepIslesSeedCompatibleWithNativeT1 = false;
    this.updateOutput(`DeepISLES ${kind === 'dwi' ? 'DWI/TRACE' : 'ADC'} input ready: ${file.name}`);
    return file;
  }

  async deepIslesSeedCanReviewOnNativeT1() {
    if (!this.deepIslesDwiFile || !this.nativeStructuralFile) return false;
    const native = await this.ensureNativeStructuralInfo();
    const dwiMeta = getSpatialMetadata(this.deepIslesDwiFile);
    if (!dwiMeta?.dims || !dwiMeta?.affine) return false;
    return dimsEqual(dwiMeta.dims, native.dims) && affineNearlyEqual(dwiMeta.affine, native.affine, 1e-3);
  }

  async setLesion(file) {
    if (!file) return;
    if (!this.structuralFile) {
      this.tagFileSpace(file, {
        space: atlasOptionSpace(this.getAtlasOption(), 'overlap'),
        role: 'lesion',
        sourceStage: 'input'
      });
    }
    this.lesionFile = file;
    if (this.structuralFile) {
      this.assertViewerOverlaySpace(file, 'Lesion mask overlay');
      await this.viewerController.loadOverlay(file, LESION_MASK_COLORMAP_ID, 0.5, {
        stage: 'lesion',
        visible: this.layerVisible('lesion')
      });
    } else {
      await this.loadViewerBaseVolume(file, {
        stage: 'lesion',
        visible: this.layerVisible('lesion')
      });
    }
    this.refreshViewerLayerControls();
    this.updateOutput(`Lesion mask ready: ${file.name}`);
    // Phase 31: a manual lesion mask without a structural T1 means the
    // user wants the manual-mask network-map chain (overlap + FC +
    // threshold). With a structural already loaded we leave the auto
    // pipeline selected.
    if (!this.structuralFile) {
      this._autoPromotePipeline('lnm-network-map');
    }
  }

  // Phase 31 + selector cleanup: Run analysis is driven by the loaded input.
  // Structural T1 promotes to the full auto chain; a researcher-mode Yeo mask
  // promotes to the manual network-map path.
  _autoPromotePipeline(pipelineId) {
    const pipeline = getPipelineById(pipelineId);
    if (!pipeline) return;
    this.selectedPipeline = pipeline;
  }

  async runYeoOverlap() {
    return this.runAtlasOverlap();
  }

  async runAtlasOverlap() {
    if (!this.lesionFile) {
      this.updateOutput('Drop a lesion mask before computing overlap.');
      return;
    }
    const atlasOption = this.getAtlasOption();
    this.updateOutput(`Loading ${atlasSpaceName(atlasOption)} atlas...`);
    const atlas = await loadAtlasFromManifest(atlasOption.overlapAtlasAssetId);
    const overlapSpace = atlasOptionSpace(atlasOption, 'overlap');
    assertSpace(this.lesionFile, overlapSpace, 'Direct lesion overlap');
    this.updateOutput('Decoding lesion mask...');
    const lesionBuf = await this.lesionFile.arrayBuffer();
    const lesion = await decodeNiftiBuffer(lesionBuf);

    if (!dimsEqual(lesion.dims, atlas.dims)) {
      this.updateOutput(`Lesion dims ${lesion.dims.join('x')} do not match atlas ${atlas.dims.join('x')}. Re-register or warp the mask to the selected atlas first.`);
      return;
    }
    this.tagDecodedFileSpace(this.lesionFile, lesion, {
      space: overlapSpace,
      role: 'lesion',
      sourceStage: 'atlas-overlap'
    });

    const lesionBin = binarise(lesion.data);
    const parcelResult = computeParcelOverlap({
      lesion: lesionBin,
      atlas: atlas.data,
      dims: atlas.dims,
    });
    const labelMap = labelMapForAtlas(atlas, atlasOption);
    const summary = summarizeAtlasOverlap(parcelResult, atlas, atlasOption);
    const networkSizes = computeLabelSizes(atlas.data, labelMap);
    this.overlapResult = { parcelResult, summary, atlas, networkSizes, atlasOption };
    this.showAtlasCoverageNote(parcelResult.voxelsOutsideAtlas, parcelResult.totalLesionVoxels);

    this.renderDirectOverlapTable();
    this.clearAffectedNetworkTable();
    const csvButton = document.getElementById('downloadOverlapCsv');
    if (csvButton) csvButton.disabled = false;

    this.updateOutput(
      `Overlap computed for ${summary.networks.length} ${atlasOption.weightSource === 'parcel' ? 'parcels' : 'networks'} ` +
      `(${parcelResult.totalLesionVoxels - parcelResult.voxelsOutsideAtlas} of ` +
      `${parcelResult.totalLesionVoxels} lesion voxels assigned to ${atlasSpaceName(atlasOption)} ` +
      `labels; ${parcelResult.voxelsOutsideAtlas} unlabeled).`
    );
    await this.updateDirectFunctionProfile();
  }

  async ensureFunctionProfiles() {
    if (this.functionProfiles) return this.functionProfiles;
    const atlasOption = this.getAtlasOption();
    if (!atlasOption?.functionProfileAssetId) {
      throw new Error(`${atlasSpaceName(atlasOption)} has no functional profile asset.`);
    }
    const manifest = await this.ensureManifest();
    const { profiles } = await loadFunctionProfilesFromManifest(
      atlasOption.functionProfileAssetId,
      { manifest }
    );
    this.functionProfiles = profiles;
    return profiles;
  }

  clearFunctionProfileTable(resultId, tableId) {
    const resultEl = document.getElementById(resultId);
    if (resultEl) resultEl.classList.add('hidden');
    const tableEl = document.getElementById(tableId);
    if (tableEl) tableEl.innerHTML = '';
  }

  getResultsMinClusterVoxels() {
    const minClEl = document.getElementById('networkThresholdMinCluster');
    if (minClEl) return normalizeMinClusterVoxels(minClEl.value);
    return 0;
  }

  filterSummaryForResults(summary) {
    return filterSummaryByMinCluster(summary, this.getResultsMinClusterVoxels());
  }

  minClusterEmptyLabel(fallback) {
    const minClusterVoxels = this.getResultsMinClusterVoxels();
    return minClusterVoxels > 1
      ? `No atlas labels with >= ${minClusterVoxels} voxels`
      : fallback;
  }

  getDisplayOverlapSummary() {
    if (!this.overlapResult?.summary) return null;
    const displaySummary = this.filterSummaryForResults(this.overlapResult.summary);
    this.overlapResult.displaySummary = displaySummary;
    return displaySummary;
  }

  getDisplayAffectedSummary() {
    if (!this.affectedNetworkResult?.summary) return null;
    const displaySummary = this.filterSummaryForResults(this.affectedNetworkResult.summary);
    this.affectedNetworkResult.displaySummary = displaySummary;
    return displaySummary;
  }

  renderDirectOverlapTable() {
    if (!this.overlapResult) return null;
    const tableEl = document.getElementById('networkOverlapTable');
    const atlasOption = this.overlapResult.atlasOption || this.getAtlasOption();
    const displaySummary = this.getDisplayOverlapSummary();
    if (tableEl) {
      renderOverlapTable(tableEl, displaySummary, {
        colormap: this.getAtlasColormap(atlasOption),
        percentHeader: 'Lesion %',
        emptyLabel: this.minClusterEmptyLabel('No overlap')
      });
    }
    return displaySummary;
  }

  renderAffectedNetworkTable() {
    if (!this.affectedNetworkResult) return null;
    const tableEl = document.getElementById('affectedNetworkTable');
    const resultEl = document.getElementById('affectedNetworkResults');
    const atlasOption = this.affectedNetworkResult.atlasOption || this.getAtlasOption();
    const displaySummary = this.getDisplayAffectedSummary();
    if (tableEl) {
      renderOverlapTable(tableEl, displaySummary, {
        colormap: this.getAtlasColormap(atlasOption),
        percentHeader: '% of map',
        emptyLabel: this.minClusterEmptyLabel('No affected voxels')
      });
    }
    if (resultEl) resultEl.classList.remove('hidden');
    return displaySummary;
  }

  async renderFunctionProfileForSummary(summary, {
    resultId,
    tableId,
    emptyLabel = 'No functional associations'
  }) {
    const resultEl = document.getElementById(resultId);
    const tableEl = document.getElementById(tableId);
    if (!resultEl || !tableEl) return null;
    if (!summary || !Array.isArray(summary.networks) || summary.networks.length === 0) {
      this.clearFunctionProfileTable(resultId, tableId);
      return null;
    }

    const profiles = await this.ensureFunctionProfiles();
    const ranked = rankFunctionalTerms(summary, profiles, {
      topN: 8,
      minScore: 0.01
    });
    const atlasOption = this.getAtlasOption();
    renderFunctionalProfileTable(tableEl, ranked, {
      sourceLabel: profiles.sourceLabel || 'Neurosynth v7 via NiMARE',
      emptyLabel,
      driverHeader: atlasOption?.weightSource === 'parcel'
        ? 'Atlas label drivers'
        : 'Network drivers'
    });
    resultEl.classList.remove('hidden');
    return ranked;
  }

  updateDirectFunctionProfile() {
    if (!this.getAtlasOption()?.functionProfileAssetId) {
      this.clearFunctionProfileTable('directFunctionProfileResults', 'directFunctionProfileTable');
      return Promise.resolve(null);
    }
    this._functionalProfileRenderPromise = this._functionalProfileRenderPromise
      .then(() => this.renderFunctionProfileForSummary(this.getDisplayOverlapSummary(), {
        resultId: 'directFunctionProfileResults',
        tableId: 'directFunctionProfileTable',
        emptyLabel: 'No direct-overlap functional associations'
      }))
      .catch(err => {
        this.clearFunctionProfileTable('directFunctionProfileResults', 'directFunctionProfileTable');
        this.updateOutput(`Functional profiles unavailable: ${err.message}`);
        return null;
      });
    return this._functionalProfileRenderPromise;
  }

  updateAffectedFunctionProfile() {
    if (!this.getAtlasOption()?.functionProfileAssetId) {
      this.clearFunctionProfileTable('mapFunctionProfileResults', 'mapFunctionProfileTable');
      return Promise.resolve(null);
    }
    this._functionalProfileRenderPromise = this._functionalProfileRenderPromise
      .then(() => this.renderFunctionProfileForSummary(this.getDisplayAffectedSummary(), {
        resultId: 'mapFunctionProfileResults',
        tableId: 'mapFunctionProfileTable',
        emptyLabel: 'No connectivity-map functional associations'
      }))
      .catch(err => {
        this.clearFunctionProfileTable('mapFunctionProfileResults', 'mapFunctionProfileTable');
        this.updateOutput(`Functional profiles unavailable: ${err.message}`);
        return null;
      });
    return this._functionalProfileRenderPromise;
  }

  // ---- Phase 2a.1.4b: brain extraction wiring ----

  async ensureManifest() {
    if (this.manifest) return this.manifest;
    const response = await fetch('./models/manifest.json');
    if (!response.ok) {
      throw new Error(`Failed to load manifest: HTTP ${response.status}`);
    }
    this.manifest = await response.json();
    if (Array.isArray(this.manifest.atlasOptions) && this.manifest.atlasOptions.length > 0) {
      this.atlasOptions = this.manifest.atlasOptions;
      if (!getAtlasOptionById(this.selectedAtlasOptionId, this.atlasOptions)) {
        this.selectedAtlasOptionId = this.atlasOptions[0].id;
      }
      this.populateAtlasSelect();
    }
    return this.manifest;
  }

  async ensureNativeStructuralInfo() {
    if (this.nativeStructuralInfo) return this.nativeStructuralInfo;
    const file = this.nativeStructuralFile || this.structuralFile;
    if (!file || typeof file.arrayBuffer !== 'function') {
      throw new Error('Native structural image is not available.');
    }
    const decoded = await decodeNiftiBuffer(await file.arrayBuffer());
    this.nativeStructuralFile = file;
    this.tagDecodedFileSpace(file, decoded, {
      space: VOLUME_SPACES.NATIVE_T1,
      role: 'structural',
      sourceStage: 'native-structural'
    });
    this.nativeStructuralInfo = {
      dims: decoded.dims,
      affine: affineFromHeader(decoded.header),
      spacing: spacingFromHeader(decoded.header)
    };
    return this.nativeStructuralInfo;
  }

  async ensureFixedMni160Info() {
    if (this.fixedMni160Info) return this.fixedMni160Info;
    const mni160 = await loadAtlasFromManifest('lnm-mni160');
    this.fixedMni160Info = {
      dims: mni160.dims,
      affine: affineFromHeader(mni160.header),
      spacing: [1, 1, 1]
    };
    return this.fixedMni160Info;
  }

  async runBrainExtraction() {
    if (!this.structuralFile) {
      this.updateOutput('Drop a structural image first.');
      return;
    }
    const manifest = await this.ensureManifest();
    const entry = manifest.modelAssets?.find(a => a.id === 'lnm-synthstrip');
    if (!entry) throw new Error("Manifest is missing the 'lnm-synthstrip' model asset.");
    if (entry.supportStatus !== 'supported') {
      throw new Error(`'lnm-synthstrip' is ${entry.supportStatus}; cannot run brain extraction.`);
    }
    const { base, name } = splitModelUrl(entry.sourceUrl);

    this.updateOutput('Starting SynthStrip brain extraction...');
    const brainmaskReady = this._waitForStageData('brainmask');
    const brainmaskStepDone = this._waitForStepComplete('brainmask');
    const inputBuffer = await this.structuralFile.arrayBuffer();
    await this.executor.loadVolume(inputBuffer);
    await this.executor.runSynthStrip({
      modelAssetId: entry.id,
      modelName: name || 'synthstrip.onnx',
      modelBaseUrl: base,
      cacheKey: entry.cacheKey,
      // SynthStrip 'fast' mode caps the resample target at 2mm (instead of
      // 1mm). For 1-2mm inputs this is a no-op resample and brings the
      // conformed inference volume down to ~7-8M voxels — within the WASM
      // 4GB heap. 1mm-mode produces ~12-15M voxels and reliably ORT-OOMs
      // in headless Chromium; the higher-quality path is a future option.
      fast: true,
      dilate: false
    });
    await Promise.all([brainmaskReady, brainmaskStepDone]);
  }

  handleWorkerProgress(frac, label) {
    if (!this.progress) return;
    this.progress.setProgress(frac, label);
    // Phase 14: enable the cancel button while the worker is mid-run.
    const cancelBtn = document.getElementById('cancelButton');
    if (cancelBtn) {
      cancelBtn.disabled = !(typeof frac === 'number' && frac >= 0 && frac < 1);
    }
  }

  _waitForStageData(stage) {
    return new Promise((resolve, reject) => {
      const waiters = this._stageDataResolvers.get(stage) || [];
      waiters.push({ resolve, reject });
      this._stageDataResolvers.set(stage, waiters);
    });
  }

  _waitForStepComplete(step) {
    return new Promise((resolve, reject) => {
      const waiters = this._stepCompleteResolvers.get(step) || [];
      waiters.push({ resolve, reject });
      this._stepCompleteResolvers.set(step, waiters);
    });
  }

  _resolveStageData(stage, data) {
    const waiters = this._stageDataResolvers.get(stage);
    if (!waiters?.length) return;
    this._stageDataResolvers.delete(stage);
    for (const waiter of waiters) waiter.resolve(data);
  }

  _resolveStepComplete(step) {
    const waiters = this._stepCompleteResolvers.get(step);
    if (!waiters?.length) return;
    this._stepCompleteResolvers.delete(step);
    for (const waiter of waiters) waiter.resolve(step);
  }

  _rejectPendingWorkerWaits(message) {
    const err = message instanceof Error ? message : new Error(String(message || 'Worker failed'));
    for (const waiters of this._stageDataResolvers.values()) {
      for (const waiter of waiters) waiter.reject(err);
    }
    for (const waiters of this._stepCompleteResolvers.values()) {
      for (const waiter of waiters) waiter.reject(err);
    }
    this._stageDataResolvers.clear();
    this._stepCompleteResolvers.clear();
    if (this._mniLesionResolver) {
      const resolver = this._mniLesionResolver;
      this._mniLesionResolver = null;
      resolver.reject(err);
    }
  }

  handleStepComplete(step) {
    this.updateOutput(`Worker step '${step}' complete.`);
    // Phase 14: a completed step ends the cancellable window.
    const cancelBtn = document.getElementById('cancelButton');
    if (cancelBtn) cancelBtn.disabled = true;
    this._resolveStepComplete(step);
  }

  handleStageData(data) {
    if (!data || !data.stage) return;
    if (data.stage === 'brainmask' && data.niftiData) {
      const file = arrayBufferToFile(data.niftiData, 'brainmask.nii');
      this.tagFileSpace(file, {
        space: this.structuralSpace() || VOLUME_SPACES.NATIVE_T1,
        role: 'brainmask',
        sourceStage: 'brainmask'
      });
      this.brainmaskFile = file;
      if (this.structuralFile === this.nativeStructuralFile) {
        this.nativeBrainmaskFile = file;
      }
      // Render as a translucent overlay over the structural; if the user
      // dropped a lesion manually before the structural, the lesion stage
      // re-renders normally on its next setLesion() call.
      if (this.structuralFile) {
        this.assertViewerOverlaySpace(file, 'Brain mask overlay');
        this.viewerController
          .loadOverlay(file, 'green', 0.4, {
            stage: 'brainmask',
            visible: this.layerVisible('brainmask')
          })
          .catch(err => this.updateOutput(`Brain mask render error: ${err.message}`));
      }
      const btn = document.getElementById('downloadBrainMaskButton');
      if (btn) btn.disabled = false;
      this.refreshViewerLayerControls();
      this.updateOutput('Brain mask ready.');
      this._resolveStageData(data.stage, data);
      return;
    }
    if (data.stage === 'segmentation' && data.niftiData) {
      const isDeepIslesSeed = data.taskId === 'lnm-deepisles-seed';
      const file = arrayBufferToFile(data.niftiData, isDeepIslesSeed ? 'deepisles-lesion-seed.nii' : 'lesion.nii');
      this.tagFileSpace(file, {
        space: isDeepIslesSeed && !this.deepIslesSeedCompatibleWithNativeT1
          ? VOLUME_SPACES.NATIVE_DWI
          : (isDeepIslesSeed ? VOLUME_SPACES.NATIVE_T1 : (this.structuralSpace() || VOLUME_SPACES.MNI160)),
        role: 'lesion-seed',
        sourceStage: isDeepIslesSeed ? 'deepisles-segmentation' : 'segmentation'
      });
      if (isDeepIslesSeed) this.deepIslesSeedFile = file;
      this.autoLesionSeedFile = file;
      this.lesionMaskFile = null;
      this.lesionMaskConfirmed = false;
      const btn = document.getElementById('downloadLesionMaskButton');
      if (btn) btn.disabled = false;
      this.refreshViewerLayerControls();
      this.refreshMaskDrawingControls();
      this.updateOutput(isDeepIslesSeed
        ? 'DeepISLES lesion seed ready.'
        : 'Automatic lesion seed ready for manual review.');
      this._resolveStageData(data.stage, data);
      return;
    }
    // Phase 6.2: warp-mask emits the lesion warped onto MNI160 1mm. The
    // stage data is the NIfTI ArrayBuffer; applyRegistrationToLesion()
    // awaits it via a one-shot resolver before resampling onto the selected atlas grid.
    if (data.stage === 'mni-lesion' && data.niftiData) {
      this.mniLesionFile = arrayBufferToFile(data.niftiData, 'lesion-mni1mm.nii', {
        space: VOLUME_SPACES.MNI160,
        role: 'lesion',
        sourceStage: 'mni-lesion'
      });
      this.updateOutput('Lesion warped to MNI160 1mm.');
      if (this._mniLesionResolver) {
        const r = this._mniLesionResolver;
        this._mniLesionResolver = null;
        r.resolve(data.niftiData);
      }
      this._resolveStageData(data.stage, data);
      return;
    }
    if (data.stage === 'registered-t1-mni160' && data.niftiData) {
      this.registeredT1MniFile = arrayBufferToFile(data.niftiData, 'lnm-registered-t1-mni160.nii', {
        space: VOLUME_SPACES.MNI160,
        role: 'structural',
        sourceStage: 'registered-t1-mni160'
      });
      this.registrationCheckerboardFile = null;
      this.updateOutput('Registered T1 QC volume ready on the MNI160 grid.');
      this._resolveStageData(data.stage, data);
      return;
    }
    if (data.stage === 'registration-displacement-mag' && data.niftiData) {
      this.displacementMagnitudeFile = arrayBufferToFile(data.niftiData, 'lnm-registration-displacement-mag.nii', {
        space: VOLUME_SPACES.MNI160,
        role: 'registration-displacement',
        sourceStage: 'registration-displacement-mag'
      });
      this.updateOutput('Registration displacement QC map ready.');
      this._resolveStageData(data.stage, data);
      return;
    }
    if (data.stage === 'threshold-patient' && data.niftiData) {
      this.patientThresholdedMaskFile = arrayBufferToFile(data.niftiData, 'lnm-network-map-thresh-patient.nii', {
        space: this.structuralSpace() || VOLUME_SPACES.MNI160,
        role: 'threshold-map',
        sourceStage: 'threshold-patient'
      });
      this.refreshViewerLayerControls();
      this.updateOutput('Threshold map projected to patient T1 space.');
      this._resolveStageData(data.stage, data);
      return;
    }
    if (data.stage === 'atlas-patient' && data.niftiData) {
      const atlasOption = this.getAtlasOption();
      this.patientAtlasFile = arrayBufferToFile(data.niftiData, `lnm-${atlasOption.id}-atlas-patient.nii`, {
        space: this.structuralSpace() || VOLUME_SPACES.MNI160,
        role: 'atlas-qc',
        sourceStage: 'atlas-patient'
      });
      this.refreshViewerLayerControls();
      this.updateOutput(`${atlasSpaceName(atlasOption)} atlas projected to patient T1 space.`);
      this._resolveStageData(data.stage, data);
    }
  }

  downloadBrainMask() {
    if (!this.brainmaskFile) {
      this.updateOutput('No brain mask available yet.');
      return;
    }
    const url = URL.createObjectURL(this.brainmaskFile);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'lnm-brainmask.nii';
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  }

  // Phase 2a.2.3: lesion-segmentation entry point. Reads the manifest
  // entry for 'lnm-stroke-lesion', dispatches the SCT-derived
  // run-inference op (see web/js/inference-worker.js stepInference). The
  // worker fetches + runs the SynthStroke baseline ONNX, applies the
  // sliding-window pipeline, and emits a 'segmentation' stageData NIfTI.
  async runLesionSegmentation() {
    if (!this.structuralFile) {
      this.updateOutput('Drop a structural image first.');
      return;
    }
    const manifest = await this.ensureManifest();
    const entry = manifest.modelAssets?.find(a => a.id === 'lnm-stroke-lesion');
    if (!entry) throw new Error("Manifest is missing the 'lnm-stroke-lesion' model asset.");
    if (entry.supportStatus !== 'supported') {
      throw new Error(`'lnm-stroke-lesion' is ${entry.supportStatus}; cannot run lesion segmentation.`);
    }
    const { base, name } = splitModelUrl(entry.sourceUrl);

    this.updateOutput('Starting lesion segmentation...');
    await this.prepareViewerForLesionSegmentation();
    const segmentationReady = this._waitForStageData('segmentation');
    const segmentationStepDone = this._waitForStepComplete('inference');
    const inputBuffer = await this.structuralFile.arrayBuffer();
    await this.executor.loadVolume(inputBuffer);
    await this.executor.runInference({
      taskId: 'lnm-segment-only',
      modelAssetId: entry.id,
      modelName: name || 'lnm-stroke-lesion.onnx',
      modelBaseUrl: base,
      cacheKey: entry.cacheKey,
      supportStatus: entry.supportStatus,
      patchSize: entry.patchSize || [128, 128, 128],
      threshold: entry.probabilityThreshold ?? 0.4,
      minComponentSize: entry.minComponentSize ?? 30,
      preprocessing: entry.preprocessing || {},
      // Test-time augmentation (8-axis flip averaging) is enabled to suppress
      // spurious activations that are not robust to reflection — notably the
      // in-brain cerebellum/posterior-fossa false positives SynthStroke can
      // emit. On the prealigned MNI160 input, TTA at overlap 0.25 removes the
      // cerebellar FP cluster while preserving ~95% of the true lesion (vs the
      // no-TTA baseline that kept the FP); raising overlap further only costs
      // recall. TTA is ~8x the patch inference cost but bounded, and uses the
      // existing static-128 ONNX (no 192^3 re-export). Overlap stays at 0.25;
      // both are read from the manifest so they can be tuned without code.
      overlap: entry.overlap ?? 0.25,
      testTimeAugmentation: entry.testTimeAugmentation ?? true
    });
    await Promise.all([segmentationReady, segmentationStepDone]);
  }

  async runDeepIslesSegmentation() {
    if (!this.structuralFile && !this.nativeStructuralFile) {
      this.updateOutput('Drop a structural T1 before running a DeepISLES seed.');
      return;
    }
    if (!this.deepIslesDwiFile || !this.deepIslesAdcFile) {
      throw new Error('DeepISLES requires DWI/TRACE and ADC inputs.');
    }
    const manifest = await this.ensureManifest();
    const entry = manifest.modelAssets?.find(a => a.id === 'lnm-deepisles-nvauto-browser-seed');
    if (!entry) throw new Error("Manifest is missing the 'lnm-deepisles-nvauto-browser-seed' model asset.");
    if (entry.supportStatus !== 'supported') {
      throw new Error(
        `'lnm-deepisles-nvauto-browser-seed' is ${entry.supportStatus || 'unvalidated'}; ` +
        'benchmark-only DeepISLES assets must pass the Dice gap analysis and browser budget before app inference is enabled.'
      );
    }
    const { base, name } = splitModelUrl(entry.sourceUrl);
    this.deepIslesSeedCompatibleWithNativeT1 = await this.deepIslesSeedCanReviewOnNativeT1();

    this.updateOutput('Starting DeepISLES DWI/ADC lesion seed...');
    await this.prepareViewerForLesionSegmentation();
    const segmentationReady = this._waitForStageData('segmentation');
    const segmentationStepDone = this._waitForStepComplete('inference');
    await this.executor.runDeepIslesInference({
      taskId: 'lnm-deepisles-seed',
      modelAssetId: entry.id,
      modelName: name || 'lnm-deepisles-nvauto-browser-seed.onnx',
      modelBaseUrl: base,
      cacheKey: entry.cacheKey,
      supportStatus: entry.supportStatus,
      patchSize: entry.patchSize || [192, 192, 128],
      threshold: entry.probabilityThreshold ?? 0.5,
      minComponentSize: entry.minComponentSize ?? 30,
      overlap: entry.overlap ?? 0.625,
      channelOrder: entry.preprocessing?.channelOrder || ['ADC', 'TRACE'],
      preprocessing: entry.preprocessing || {},
      dwiBuffer: await this.deepIslesDwiFile.arrayBuffer(),
      adcBuffer: await this.deepIslesAdcFile.arrayBuffer()
    });
    await Promise.all([segmentationReady, segmentationStepDone]);
    if (!this.deepIslesSeedCompatibleWithNativeT1) {
      this.updateOutput(
        'DeepISLES seed is in DWI space and does not match the native T1 grid; ' +
        'not starting T1 mask review or downstream CALMaR mapping automatically.'
      );
    }
  }

  async prepareViewerForLesionSegmentation() {
    this.viewerLayerVisibility.brainmask = false;
    this.setMaskReview3DRenderEnabled(false);

    const displayFile = this.nativeStructuralFile || this.structuralFile;
    if (displayFile && displayFile !== this.getActiveViewerBaseFile()) {
      this.viewerController?.clearVolumes?.();
      await this.loadViewerBaseVolume(displayFile, {
        stage: 'structural',
        visible: this.layerVisible('structural')
      });
    } else {
      this.applyViewerLayerVisibility('brainmask');
    }
    this.refreshViewerLayerControls();
  }

  async downloadLesionMask() {
    const file = this.confirmedNativeLesionFile || this.lesionMaskFile || this.autoLesionSeedFile;
    if (!file) {
      this.updateOutput('No lesion mask available yet.');
      return;
    }
    const filename = this.confirmedNativeLesionFile ? 'lnm-lesion-edited-native.nii' : 'lnm-lesion-seed.nii';
    await this.triggerBrowserDownload(file, filename);
  }

  async downloadEditedLesionMask() {
    const file = this.confirmedNativeLesionFile ||
      this.exportActiveNativeDrawingFile('lnm-lesion-edited-native.nii');
    if (!file) return;
    const filename = 'lnm-lesion-edited-native.nii';
    await this.triggerBrowserDownload(file, filename);
  }

  async fileBytesForDownload(file, filename) {
    const buffer = await file.arrayBuffer();
    const bytes = new Uint8Array(buffer);
    if (!bytes.byteLength) {
      throw new Error(`${filename} export is empty`);
    }
    return bytes;
  }

  async triggerBrowserDownload(file, filename) {
    const bytes = await this.fileBytesForDownload(file, filename);
    this.updateOutput(`Prepared mask download: ${filename} (${bytes.byteLength} bytes).`);
    const serverDownload = await this.createServerDownload(bytes, filename);
    if (serverDownload?.saved) return;
    const url = serverDownload?.url ||
      await this.createCachedDownloadUrl(bytes, filename) ||
      this.createDataDownloadUrl(bytes);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
  }

  async createServerDownload(bytes, filename) {
    const fetchFn = globalThis.fetch;
    if (typeof fetchFn !== 'function') return null;
    let url;
    try {
      url = new URL(globalThis.location?.href || 'http://localhost/');
    } catch (_) {
      return null;
    }
    const localHosts = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);
    if (!localHosts.has(url.hostname)) return null;
    try {
      const safeName = downloadSafeFilename(filename);
      const token = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
      const downloadUrl = new URL(`${MASK_DOWNLOAD_PATH}/${token}/${encodeURIComponent(safeName)}`, url.href);
      const response = await fetchFn(downloadUrl.href, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/octet-stream',
          'X-LNM-Filename': safeName,
          'X-LNM-Stage-Only': '1'
        },
        body: bytes
      });
      if (!response?.ok) {
        throw new Error(`HTTP ${response?.status || 'error'}`);
      }
      const payload = await response.json().catch(() => null);
      return { url: payload?.url ? new URL(payload.url, url.href).href : downloadUrl.href };
    } catch (err) {
      this.updateOutput(`Local download route unavailable: ${err.message || err}. Trying browser download.`);
      return null;
    }
  }

  async createCachedDownloadUrl(bytes, filename) {
    if (typeof caches === 'undefined' || !globalThis.navigator?.serviceWorker?.controller) {
      return null;
    }
    try {
      const safeName = downloadSafeFilename(filename);
      const token = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
      const url = new URL(`${MASK_DOWNLOAD_PATH}/${token}/${encodeURIComponent(safeName)}`, globalThis.location?.href || 'http://localhost/');
      const cache = await caches.open(MASK_DOWNLOAD_CACHE);
      await cache.put(url.href, new Response(bytes, {
        headers: {
          'Content-Type': 'application/octet-stream',
          'Content-Disposition': `attachment; filename="${safeName}"`,
          'Content-Length': String(bytes.byteLength),
          'Cache-Control': 'no-store'
        }
      }));
      if (typeof setTimeout === 'function') {
        setTimeout(() => { cache.delete(url.href).catch(() => {}); }, 10 * 60 * 1000);
      }
      return url.href;
    } catch (err) {
      this.updateOutput(`Cached download unavailable: ${err.message || err}. Trying inline download.`);
      return null;
    }
  }

  createDataDownloadUrl(bytes) {
    return `data:application/octet-stream;base64,${bytesToBase64(bytes)}`;
  }

  exportActiveNativeDrawingFile(name = 'lnm-lesion-edited-native.nii') {
    if (!this.maskDrawingController?.hasDrawing) {
      this.updateOutput('No edited lesion mask available yet.');
      return null;
    }
    const native = this.nativeStructuralInfo;
    if (!native?.dims || !native?.affine) {
      throw new Error('Native structural geometry is not available for mask download.');
    }
    const drawing = this.maskDrawingController.copyDrawingBitmap?.();
    if (!(drawing instanceof Uint8Array)) {
      throw new Error('No editable lesion drawing is available.');
    }
    const expected = native.dims[0] * native.dims[1] * native.dims[2];
    if (drawing.length !== expected) {
      throw new Error(
        `Edited lesion mask dimensions do not match the native T1 ` +
        `(${drawing.length} voxels vs ${native.dims.join('x')}).`
      );
    }
    const nativeNifti = writeBinaryMaskNifti(drawing, {
      dims: native.dims,
      affine: native.affine,
      spacing: native.spacing || [1, 1, 1],
      description: 'LNM edited lesion mask on native T1 grid'
    });
    return arrayBufferToFile(nativeNifti, name, {
      space: VOLUME_SPACES.NATIVE_T1,
      role: 'lesion',
      sourceStage: 'mask-download-native',
      dims: native.dims,
      affine: native.affine
    });
  }

  async resampleSeedMaskToNative(seedFile) {
    if (!seedFile) return null;
    const seedMeta = getSpatialMetadata(seedFile);
    const seedSpace = seedMeta?.space;
    if (seedSpace && ![VOLUME_SPACES.MNI160, VOLUME_SPACES.NATIVE_T1].includes(seedSpace)) {
      throw new Error(`Editable lesion seed source: expected ${VOLUME_SPACES.MNI160} or ${VOLUME_SPACES.NATIVE_T1}, got ${seedSpace}.`);
    }
    const native = await this.ensureNativeStructuralInfo();
    const seed = await decodeNiftiBuffer(await seedFile.arrayBuffer());
    const headerAffine = affineFromHeader(seed.header);
    let seedAffine = seedMeta?.affine || headerAffine;
    if (seedSpace === VOLUME_SPACES.MNI160) {
      seedAffine = this.prealignSamplingAffine || seedAffine;
    } else if (!seedSpace && this.prealignSamplingAffine && this.fixedMni160Info && dimsEqual(seed.dims, this.fixedMni160Info.dims)) {
      seedAffine = this.prealignSamplingAffine;
    }
    const nativeMask = resampleBinaryMask({
      data: seed.data,
      srcDims: seed.dims,
      srcAffine: seedAffine,
      dstDims: native.dims,
      dstAffine: native.affine
    });
    const nativeNifti = writeBinaryMaskNifti(nativeMask, {
      dims: native.dims,
      affine: native.affine,
      spacing: [1, 1, 1],
      description: 'LNM editable lesion seed projected to native T1 grid'
    });
    this.nativeLesionSeedFile = arrayBufferToFile(nativeNifti, 'lnm-lesion-seed-native.nii', {
      space: VOLUME_SPACES.NATIVE_T1,
      role: 'lesion-seed',
      sourceStage: 'mask-review'
    });
    return this.nativeLesionSeedFile;
  }

  async startUploadedLesionMaskReview(file) {
    if (!file) return null;
    const baseFile = this.nativeStructuralFile || this.structuralFile;
    if (!baseFile) {
      this.updateOutput('Drop a structural T1 before loading a manual lesion mask.');
      return null;
    }
    const decoded = await decodeNiftiBuffer(await file.arrayBuffer());
    this.tagDecodedFileSpace(file, decoded, {
      space: VOLUME_SPACES.NATIVE_T1,
      role: 'lesion-seed',
      sourceStage: 'mask-upload'
    });
    const seed = await this.startLesionMaskReview({ seedFile: file });
    this.updateOutput(`Manual lesion mask ready for editing: ${file.name}`);
    return seed;
  }

  async startLesionMaskReview({ seedFile = null, blank = false } = {}) {
    const baseFile = this.nativeStructuralFile || this.structuralFile;
    if (!baseFile) {
      this.updateOutput('Drop a structural T1 before editing a lesion mask.');
      return null;
    }
    this.nativeStructuralFile = baseFile;
    this.tagFileSpace(baseFile, {
      space: VOLUME_SPACES.NATIVE_T1,
      role: 'structural',
      sourceStage: 'mask-review'
    });
    await this.ensureNativeStructuralInfo();
    this.maskReviewActive = true;
    this.lesionMaskConfirmed = false;
    this.lesionMaskFile = null;
    this.viewerLayerVisibility.brainmask = false;
    if (this.viewerController?.clearVolumes) {
      this.viewerController.clearVolumes();
    } else {
      this.viewerController?.removeVolumeForStage?.('brainmask');
    }
    this.setMaskReview3DRenderEnabled(false);
    await this.loadViewerBaseVolume(baseFile, {
      stage: 'structural',
      visible: this.layerVisible('structural')
    });
    const brainmaskFile = this.getBrainmaskFileForActiveViewer();
    if (brainmaskFile && this.layerVisible('brainmask')) {
      try {
        this.assertViewerOverlaySpace(brainmaskFile, 'Mask-review brain-mask overlay');
        await this.viewerController.loadOverlay(brainmaskFile, 'green', 0.4, {
          stage: 'brainmask',
          visible: true
        });
      } catch (err) {
        this.updateOutput(`Mask-review brain mask render warning: ${err.message}`);
      }
    }

    const seed = blank ? null : await this.resampleSeedMaskToNative(seedFile || this.autoLesionSeedFile);
    if (seed) await this.maskDrawingController.loadSeedFile(seed);
    else this.maskDrawingController.startBlank();

    this.setMaskDrawingTool('paint');
    this.applyMaskDrawingVisibility();
    this.refreshViewerLayerControls();
    this.refreshMaskDrawingControls();
    this.updateOutput('Review/edit the lesion mask, then confirm it to continue analysis.');
    return seed;
  }

  async confirmLesionDrawing({ resumePipeline = false } = {}) {
    if (!this.maskDrawingController?.hasDrawing) {
      await this.startLesionMaskReview({ seedFile: this.autoLesionSeedFile, blank: !this.autoLesionSeedFile });
    }
    const nativeFile = this.exportActiveNativeDrawingFile('lnm-lesion-edited-native.nii');
    if (!nativeFile) throw new Error('No editable lesion drawing is available.');

    if (!this.prealignSamplingAffine || !this.fixedMni160Info) {
      await this.prealignToMni160({ skipIfAligned: true });
    }
    const fixed = await this.ensureFixedMni160Info();
    const native = await decodeNiftiBuffer(await nativeFile.arrayBuffer());
    this.confirmedNativeLesionFile = this.tagDecodedFileSpace(nativeFile, native, {
      space: VOLUME_SPACES.NATIVE_T1,
      role: 'lesion',
      sourceStage: 'mask-confirm-native'
    });
    const nativeAffine = affineFromHeader(native.header);
    const mniMask = resampleBinaryMask({
      data: native.data,
      srcDims: native.dims,
      srcAffine: nativeAffine,
      dstDims: fixed.dims,
      dstAffine: this.prealignSamplingAffine || fixed.affine
    });
    const mniNifti = writeBinaryMaskNifti(mniMask, {
      dims: fixed.dims,
      affine: fixed.affine,
      spacing: fixed.spacing || [1, 1, 1],
      description: 'LNM confirmed edited lesion mask on fixed lnm-mni160 grid'
    });

    this.lesionMaskFile = arrayBufferToFile(mniNifti, 'lnm-lesion-confirmed-mni160.nii', {
      space: VOLUME_SPACES.MNI160,
      role: 'lesion',
      sourceStage: 'mask-confirm-mni160',
      dims: fixed.dims,
      affine: fixed.affine
    });
    this.lesionMaskConfirmed = true;
    this.maskReviewActive = false;
    this.setMaskReview3DRenderEnabled(true);
    this.maskDrawingController.close({ clearDrawing: true });
    await this.renderConfirmedNativeLesionOverlay();
    const btn = document.getElementById('downloadLesionMaskButton');
    if (btn) btn.disabled = false;
    this.refreshViewerLayerControls();
    this.refreshMaskDrawingControls();
    this.updateOutput('Edited lesion mask confirmed on the fixed MNI160 grid.');

    if (resumePipeline) await this.resumePipelineAfterMaskConfirmation();
    return this.lesionMaskFile;
  }

  async resumePipelineAfterMaskConfirmation() {
    if (!this._pendingMaskResume) return;
    const pending = this._pendingMaskResume;
    this._pendingMaskResume = null;
    this.updateOutput('Resuming analysis with confirmed lesion mask...');
    const status = await this._runPipelineStages(pending.pipeline, pending.nextStageIndex);
    if (status === 'complete') this.logPipelineComplete();
  }

  decodeLoadedConnectome(loadResult, requestedLabels = null) {
    if (loadResult.arrayBuffer) {
      const pack = decodeFcPack(loadResult.arrayBuffer, {
        voxelOrder: loadResult.manifestEntry.voxelOrder,
        ...loadResult.index
      });
      if (!requestedLabels || requestedLabels.length === 0) return pack;
      const channelLabels = loadResult.index.channelLabels || loadResult.index.parcelLabels || {};
      const orderedKeys = Object.keys(channelLabels).sort((a, b) => Number(a) - Number(b));
      const wanted = new Set(requestedLabels.map(String));
      const tMaps = [];
      const selectedLabels = {};
      for (let i = 0; i < orderedKeys.length; i++) {
        const label = orderedKeys[i];
        if (!wanted.has(label)) continue;
        selectedLabels[label] = channelLabels[label];
        tMaps.push(pack.tMaps[i]);
      }
      return { ...pack, tMaps, channelLabels: selectedLabels };
    }

    const tMaps = [];
    const selectedLabels = {};
    const dims = loadResult.index.shape?.slice(1);
    for (const { shard, arrayBuffer, neededLabels } of loadResult.shards || []) {
      const shardLabels = (shard.channelLabels || []).map(String);
      const shardIndex = {
        ...loadResult.index,
        ...shard,
        shape: [shardLabels.length, ...dims],
        channelLabels: Object.fromEntries(shardLabels.map(label => [
          label,
          loadResult.index.channelLabels?.[label] || `Parcel ${label}`
        ])),
        voxelsPerMap: dims[0] * dims[1] * dims[2]
      };
      const pack = decodeFcPack(arrayBuffer, shardIndex);
      for (const label of neededLabels) {
        const i = shardLabels.indexOf(String(label));
        if (i < 0) continue;
        selectedLabels[label] = shardIndex.channelLabels[label];
        tMaps.push(pack.tMaps[i]);
      }
    }
    return {
      tMaps,
      channelLabels: selectedLabels,
      voxelsPerMap: dims[0] * dims[1] * dims[2]
    };
  }

  // Phase 4.4+: atlas-aware lesion network map. Pure main-thread math: a
  // per-voxel linear combination of precomputed FC maps. Yeo weights by
  // seven network overlaps; Schaefer weights by parcel overlaps and can
  // lazy-load only the hit parcel channels.
  async runFcNetworkMap() {
    if (!this.overlapResult) {
      this.updateOutput('Run "Compute overlap" first to get atlas weights.');
      return;
    }
    const atlasOption = this.overlapResult.atlasOption || this.getAtlasOption();
    const manifest = await this.ensureManifest();
    const connectomeEntry = manifest.connectomeAssets?.find(
      asset => asset.id === atlasOption.connectomeAssetId
    );
    if (!connectomeEntry) {
      throw new Error(`Connectome asset not found: ${atlasOption.connectomeAssetId}`);
    }
    if (connectomeEntry.supportStatus !== 'supported') {
      this.updateOutput(
        `${atlasSpaceName(atlasOption)} group-FC pack is not supported yet; ` +
        'direct lesion overlap is ready, but network-map and threshold stages were skipped.'
      );
      return { stopPipeline: true };
    }
    this.updateOutput(`Loading ${atlasSpaceName(atlasOption)} group-FC pack...`);
    // Phase 37: surface download progress for the heavy FC pack
    // (~30 MB cold; cache hit is instant). The callback is throttled
    // to one progress message per ~512 KB to avoid spamming the
    // console + status bar.
    let lastTick = 0;
    let requestedLabels = null;
    let weights = null;
    if (atlasOption.weightSource === 'parcel') {
      requestedLabels = this.overlapResult.parcelResult.parcels.map(parcel => String(parcel.label));
      if (requestedLabels.length === 0) {
        this.updateOutput(`No labelled ${atlasSpaceName(atlasOption)} parcels overlap the lesion; network map skipped.`);
        return;
      }
    }
    const progressOptions = {
      onProgress: ({ received, total, label }) => {
        if (received - lastTick < 512 * 1024 && received !== total) return;
        lastTick = received;
        const mb = (received / 1048576).toFixed(1);
        if (total) {
          const totalMb = (total / 1048576).toFixed(0);
          const pct = Math.round((received / total) * 100);
          this.handleWorkerProgress(pct / 100, `Downloading ${label} (${mb}/${totalMb} MB)`);
        } else {
          this.updateOutput(`Downloading ${label}: ${mb} MB`);
        }
      }
    };
    const loadResult = requestedLabels?.length
      ? await loadConnectomeChannelsFromManifest(
        atlasOption.connectomeAssetId,
        requestedLabels,
        { ...progressOptions, manifest }
      )
      : await loadConnectomeFromManifest(atlasOption.connectomeAssetId, { ...progressOptions, manifest });
    const { index, manifestEntry } = loadResult;
    const pack = this.decodeLoadedConnectome(loadResult, requestedLabels);
    if (atlasOption.weightSource === 'parcel') {
      const channelLabels = pack.channelLabels || index.channelLabels || index.parcelLabels || {};
      weights = parcelResultToChannelWeights(this.overlapResult.parcelResult, channelLabels).weights;
    } else {
      const channelLabels = index.networkLabels || manifestEntry.networkLabels || {};
      const networkOrder = Object.keys(channelLabels)
        .sort((a, b) => Number(a) - Number(b))
        .map(key => channelLabels[key]);
      weights = summaryToNetworkWeights(this.overlapResult.summary, networkOrder);
    }
    const dims = index.shape.slice(1);
    const atlasAssetId =
      index.atlasAssetId ||
      manifestEntry.atlasAssetId ||
      atlasOption.affectedAtlasAssetId ||
      atlasOption.overlapAtlasAssetId;
    const networkMapSpace = atlasVolumeSpace(atlasAssetId);
    const atlas = await loadAtlasFromManifest(atlasAssetId);
    if (!dimsEqual(dims, atlas.dims)) {
      throw new Error(
        `FC pack grid ${dims.join('x')} does not match ${atlasAssetId} atlas ` +
        `${atlas.dims.join('x')}`
      );
    }
    const atlasAffine = affineFromHeader(atlas.header);
    const flatAffine = flattenAffine3Rows(atlasAffine);
    this.updateOutput(
      `Computing network map: weights=[${
        Array.from(weights).slice(0, 12).map(w => w.toFixed(2)).join(', ')
      }${
        weights.length > 12 ? ', ...' : ''
      }]`
    );
    const fcMap = fcWeightedSum(weights, pack.tMaps, dims);

    // Stash for Phase 5 re-thresholding without recomputing the FC sum.
    this.networkMapData = fcMap;
    this.networkMapDims = dims;
    this.networkMapLabelAtlas = atlas;
    const spacingMm = manifestEntry.atlasResolutionMm || atlas.manifestEntry?.resolutionMm || 2;
    this.networkMapSpacing = [spacingMm, spacingMm, spacingMm];
    this.networkMapAffine = flatAffine;

    // Wrap as a NIfTI for download / overlay. The selected connectome
    // declares the atlas-space grid used for the FC pack.
    const niftiBuffer = writeNifti1(fcMap, {
      dims,
      spacing: this.networkMapSpacing,
      affine: this.networkMapAffine,
      description: `LNM ${atlasSpaceName(atlasOption)} FC weighted sum`
    });
    this.networkMapFile = arrayBufferToFile(niftiBuffer, 'lnm-network-map.nii', {
      space: networkMapSpace,
      role: 'network-map',
      sourceStage: 'fc-weighted-sum',
      dims,
      affine: atlasAffine
    });

    await this.displayNetworkMapOnAtlasTemplate(atlas, flatAffine);
    const dlBtn = document.getElementById('downloadNetworkMapButton');
    if (dlBtn) dlBtn.disabled = false;

    // Quick stats: range + voxels above |t| > 5 (rough significance bar).
    let mn = Infinity, mx = -Infinity, above = 0;
    for (let i = 0; i < fcMap.length; i++) {
      const v = fcMap[i];
      if (v < mn) mn = v;
      if (v > mx) mx = v;
      if (Math.abs(v) > 5) above += 1;
    }
    this.updateOutput(
      `Network map ready: t-range [${mn.toFixed(1)}, ${mx.toFixed(1)}], ` +
      `${above.toLocaleString()} voxels with |t|>5.`
    );
  }

  downloadNetworkMap() {
    if (!this.networkMapFile) {
      this.updateOutput('No network map available yet.');
      return;
    }
    const url = URL.createObjectURL(this.networkMapFile);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'lnm-network-map.nii';
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  }

  buildAtlasBrainMaskBaseFile(atlas, flatAffine) {
    const base = new Float32Array(atlas.data.length);
    for (let i = 0; i < atlas.data.length; i++) {
      base[i] = atlas.data[i] > 0 ? 1 : 0;
    }
    const atlasAffine = atlas.header ? affineFromHeader(atlas.header) : flatAffine;
    const niftiBuffer = writeNifti1(base, {
      dims: atlas.dims,
      spacing: this.networkMapSpacing,
      affine: flatAffine,
      description: 'LNM atlas brain mask display base'
    });
    return arrayBufferToFile(niftiBuffer, 'lnm-atlas-brain-mask.nii', {
      space: atlasVolumeSpace(atlas.manifestEntry?.id || this.getAtlasOption().affectedAtlasAssetId || this.getAtlasOption().overlapAtlasAssetId),
      role: 'atlas-brain-mask',
      sourceStage: 'network-map-display',
      dims: atlas.dims,
      affine: atlasAffine
    });
  }

  buildYeoBrainMaskBaseFile(atlas, flatAffine) {
    return this.buildAtlasBrainMaskBaseFile(atlas, flatAffine);
  }

  async displayNetworkMapOnAtlasTemplate(atlas, flatAffine) {
    if (!this.networkMapFile) return;
    try {
      this.networkMapBaseFile = this.buildAtlasBrainMaskBaseFile(atlas, flatAffine);
      const entries = [
        { file: this.networkMapBaseFile, stage: 'atlas-brain-mask' }
      ];
      if (this.lesionFile) {
        try {
          assertSameSpace(this.networkMapBaseFile, this.lesionFile, 'Network-map lesion overlay');
          entries.push({
            file: this.lesionFile,
            colormap: LESION_MASK_COLORMAP_ID,
            opacity: 0.35,
            stage: 'lesion',
            visible: this.layerVisible('lesion')
          });
        } catch (err) {
          this.updateOutput(`Lesion overlay skipped on network map: ${err.message}`);
        }
      }
      entries.push({
        file: this.networkMapFile,
        colormap: 'blue2red',
        opacity: 0.5,
        stage: 'network-map',
        scalar: true,
        symmetricCal: true
      });
      this.assertViewerStackSpaces(entries, 'Network-map atlas-space stack');
      await this.loadViewerVolumeStack(entries);
      this.applyViewerLayerVisibility();
      this.refreshViewerLayerControls();
      this.updateOutput('Network map displayed on the selected atlas grid.');
    } catch (err) {
      this.updateOutput(`Network-map render error: ${err.message}`);
    }
  }

  async displayNetworkMapOnYeoTemplate(atlas, flatAffine) {
    return this.displayNetworkMapOnAtlasTemplate(atlas, flatAffine);
  }

  configureTopPercentThresholdSlider({ resetValue = false } = {}) {
    const valueEl = document.getElementById('networkThresholdValue');
    if (!valueEl) return;
    valueEl.min = '0';
    valueEl.max = String(NETWORK_TOP_PERCENT_MAX);
    valueEl.step = String(NETWORK_TOP_PERCENT_STEP);
    if (resetValue) valueEl.value = '5';
  }

  updateThresholdValueLabel() {
    const valueEl = document.getElementById('networkThresholdValue');
    const labelEl = document.getElementById('networkThresholdValueLabel');
    if (!valueEl || !labelEl) return;
    const v = Number(valueEl.value);
    labelEl.textContent = `${v.toFixed(Number.isInteger(v) ? 0 : 1)}%`;
  }

  // Phase 5: re-threshold the cached network map, update the
  // thresholded-mask download, and schedule a live binary preview overlay.
  // The scalar FC t-map stays visible as context; the red preview overlay
  // is replaced as the top-percent slider / cluster controls change.
  //
  // Reads the threshold UI controls:
  //   #networkThresholdValue   range slider, 0..10 top % of voxels.
  //   #networkThresholdSymmetric  checkbox: rank by |t| magnitude.
  //   #networkThresholdMinCluster number input.
  applyNetworkThreshold() {
    if (!this.networkMapData) {
      this.clearAffectedNetworkTable();
      this.updateOutput('Compute the network map first.');
      return null;
    }
    const valueEl = document.getElementById('networkThresholdValue');
    const symEl = document.getElementById('networkThresholdSymmetric');
    const rawValue = valueEl ? Number(valueEl.value) : 5;
    const symmetric = symEl ? !!symEl.checked : true;
    const minClusterVoxels = this.getResultsMinClusterVoxels();
    // The UI label is "Top voxels": 5 means keep the strongest 5%.
    // The pure threshold engine takes a percentile cutoff q where q=0.95
    // keeps roughly the top 5%, so invert the UI value here.
    const topPercent = Math.max(0, Math.min(NETWORK_TOP_PERCENT_MAX, rawValue));
    const value = 1 - (topPercent / 100);
    const thresholdResult = applyThresholdDetailed(this.networkMapData, this.networkMapDims, {
      mode: 'percentile', value, symmetric, minClusterVoxels
    });
    const mask = thresholdResult.mask;
    const count = thresholdResult.count;
    const cutoff = thresholdResult.threshold;
    const niftiBuffer = writeNifti1(mask, {
      dims: this.networkMapDims,
      spacing: this.networkMapSpacing,
      affine: this.networkMapAffine,
      description: `LNM thresholded topPercent=${topPercent} q=${value} magnitude=${symmetric} cluster>=${minClusterVoxels}`
    });
    const networkMapMeta = getSpatialMetadata(this.networkMapFile);
    this.thresholdedMaskFile = arrayBufferToFile(niftiBuffer, 'lnm-network-map-thresh.nii', {
      space: networkMapMeta?.space || atlasOptionSpace(this.overlapResult?.atlasOption || this.getAtlasOption(), 'affected'),
      role: 'threshold-map',
      sourceStage: 'threshold',
      dims: this.networkMapDims,
      affine: this.networkMapAffine
    });
    this.patientThresholdedMaskFile = null;
    const dlBtn = document.getElementById('downloadThresholdedNetworkMapButton');
    if (dlBtn) dlBtn.disabled = false;
    const summaryEl = document.getElementById('networkThresholdSummary');
    if (summaryEl) {
      const clusterText = minClusterVoxels > 1
        ? `; cluster≥${minClusterVoxels} removed ${thresholdResult.removedByCluster.toLocaleString()} voxels`
        : '';
      const topLabel = topPercent.toFixed(Number.isInteger(topPercent) ? 0 : 1);
      summaryEl.textContent =
        `${count.toLocaleString()} voxels survive top ${topLabel}%` +
        (symmetric ? ' (|t|)' : ' (t)') +
        `; cutoff ${cutoff.toPrecision(3)}` +
        clusterText;
    }
    this.updateAffectedNetworkTable(mask);
    this.refreshViewerLayerControls();
    this.scheduleThresholdPreviewOverlay();
    return mask;
  }

  updateAffectedNetworkTable(mask) {
    this.affectedNetworkResult = null;
    const atlasOption = this.overlapResult?.atlasOption || this.getAtlasOption();
    const atlas = this.networkMapLabelAtlas || this.overlapResult?.atlas;

    if (!mask || !atlas) {
      this.clearAffectedNetworkTable();
      return null;
    }
    if (this.thresholdedMaskFile && atlas.manifestEntry?.id) {
      assertSpace(this.thresholdedMaskFile, atlasVolumeSpace(atlas.manifestEntry.id), 'Affected-map labeling');
    }
    if (!dimsEqual(this.networkMapDims, atlas.dims)) {
      this.clearAffectedNetworkTable();
      this.updateOutput(
        `Affected-network labels unavailable: threshold map dims ` +
        `${this.networkMapDims?.join('x') || 'unknown'} do not match atlas ` +
        `${atlas.dims.join('x')}.`
      );
      return null;
    }

    const parcelResult = computeParcelOverlap({
      lesion: mask,
      atlas: atlas.data,
      dims: atlas.dims
    });
    const summary = summarizeAtlasOverlap(parcelResult, atlas, atlasOption);
    this.affectedNetworkResult = { parcelResult, summary, atlas, atlasOption };
    this.renderAffectedNetworkTable();
    this.updateAffectedFunctionProfile();
    return this.affectedNetworkResult;
  }

  clearAffectedNetworkTable() {
    this.affectedNetworkResult = null;
    const resultEl = document.getElementById('affectedNetworkResults');
    if (resultEl) resultEl.classList.add('hidden');
    const tableEl = document.getElementById('affectedNetworkTable');
    if (tableEl) tableEl.innerHTML = '';
    this.clearFunctionProfileTable('mapFunctionProfileResults', 'mapFunctionProfileTable');
  }

  cancelThresholdPreviewOverlay({ removeOverlay = false } = {}) {
    this._thresholdPreviewVersion += 1;
    if (this._thresholdPreviewTimer !== null) {
      clearTimeout(this._thresholdPreviewTimer);
      this._thresholdPreviewTimer = null;
    }
    if (removeOverlay) {
      try { this.viewerController?.removeVolumeForStage?.('threshold-preview'); }
      catch (e) { /* non-fatal: stale viewer state is cosmetic */ }
    }
  }

  scheduleThresholdPreviewOverlay() {
    if (!this.thresholdedMaskFile) return;
    this.cancelThresholdPreviewOverlay();
    const version = this._thresholdPreviewVersion;
    this._thresholdPreviewTimer = setTimeout(() => {
      this._thresholdPreviewTimer = null;
      this._thresholdPreviewRenderPromise = this._thresholdPreviewRenderPromise
        .catch(() => {})
        .then(() => this.renderThresholdPreviewOverlay(version));
    }, 75);
  }

  async renderThresholdPreviewOverlay(version = this._thresholdPreviewVersion) {
    const file = this.thresholdedMaskFile;
    if (version !== this._thresholdPreviewVersion || !file) return;
    if (!this.viewerController) return;
    if (this.canProjectThresholdToPatientSpace()) {
      try {
        await this.projectThresholdToPatientSpace(version);
        if (version !== this._thresholdPreviewVersion || !this.patientThresholdedMaskFile) return;
        await this.renderPatientLayerStack();
        return;
      } catch (err) {
        this.patientThresholdedMaskFile = null;
        this.refreshViewerLayerControls();
        this.updateOutput(`Patient-space threshold projection failed: ${err.message}`);
      }
    } else {
      this.noteThresholdProjectionUnavailable();
    }
    await this.renderAtlasThresholdPreviewOverlay(version);
  }

  canProjectThresholdToPatientSpace() {
    return !!(
      this.structuralFile &&
      this.thresholdedMaskFile &&
      this.networkMapAffine &&
      this.hasRegistrationDisplacement &&
      this.executor?.runInverseWarpMask
    );
  }

  noteThresholdProjectionUnavailable() {
    this.patientThresholdedMaskFile = null;
    this.refreshViewerLayerControls();
    if (!this.thresholdedMaskFile || this._thresholdProjectionWarningShown) return;
    if (!this.structuralFile) {
      this.updateOutput('Patient-space threshold map unavailable: no structural T1 is loaded; showing atlas-space threshold preview.');
    } else if (!this.hasRegistrationDisplacement) {
      this.updateOutput('Patient-space threshold map unavailable: run registration first; showing atlas-space threshold preview.');
    }
    this._thresholdProjectionWarningShown = true;
  }

  async projectThresholdToPatientSpace(version) {
    const { mask, dims } = await this.resampleThresholdMaskToStructuralGrid();
    if (version !== this._thresholdPreviewVersion) return null;

    const maskBuffer = mask.buffer.slice(mask.byteOffset, mask.byteOffset + mask.byteLength);
    await this.runInverseWarpStage({
      maskBuffer,
      maskDims: dims,
      stage: 'threshold-patient',
      description: 'Threshold map projected to patient T1 space'
    }, 'threshold-patient');
    return this.patientThresholdedMaskFile;
  }

  async runInverseWarpStage(settings, stage) {
    const run = this._inverseWarpQueue.catch(() => {}).then(async () => {
      const stageReady = this._waitForStageData(stage);
      const inverseWarpDone = this._waitForStepComplete('inverse-warp-mask');
      await this.executor.runInverseWarpMask(settings);
      await Promise.all([stageReady, inverseWarpDone]);
    });
    this._inverseWarpQueue = run.catch(() => {});
    await run;
  }

  async resampleThresholdMaskToStructuralGrid() {
    if (!this.thresholdedMaskFile) {
      throw new Error('No thresholded network map is available.');
    }
    if (!this.structuralFile) {
      throw new Error('No structural T1 is available.');
    }
    assertSpace(this.thresholdedMaskFile, getSpatialMetadata(this.networkMapFile)?.space || atlasOptionSpace(this.overlapResult?.atlasOption || this.getAtlasOption(), 'affected'), 'Patient threshold projection source');
    assertSpace(this.structuralFile, VOLUME_SPACES.MNI160, 'Patient threshold projection structural reference');
    const [thresholdBuf, structuralBuf, mni160] = await Promise.all([
      this.thresholdedMaskFile.arrayBuffer(),
      this.structuralFile.arrayBuffer(),
      loadAtlasFromManifest('lnm-mni160')
    ]);
    const threshold = await decodeNiftiBuffer(thresholdBuf);
    const structural = await decodeNiftiBuffer(structuralBuf);
    if (!dimsEqual(structural.dims, mni160.dims)) {
      throw new Error(
        `Patient-space threshold projection requires structural dims to match ` +
        `the lnm-mni160 registration grid (${mni160.dims.join('x')}); ` +
        `got ${structural.dims.join('x')}.`
      );
    }
    const thresholdMask = threshold.data instanceof Uint8Array
      ? threshold.data
      : binarise(threshold.data);
    const thresholdAffine = affineFromHeader(threshold.header);
    const mni160Affine = affineFromHeader(mni160.header);
    const resampled = resampleAffine(
      thresholdMask,
      threshold.dims, thresholdAffine,
      mni160.dims, mni160Affine,
      'nearest'
    );
    const mask = resampled instanceof Uint8Array ? resampled : binarise(resampled);
    return { mask, dims: mni160.dims };
  }

  async projectAtlasToMni160Grid() {
    const atlasOption = this.getAtlasOption();
    const [atlas, mni160] = await Promise.all([
      loadAtlasFromManifest(atlasOption.overlapAtlasAssetId),
      loadAtlasFromManifest('lnm-mni160')
    ]);
    const atlasAffine = affineFromHeader(atlas.header);
    const mni160Affine = affineFromHeader(mni160.header);
    const OutputCtor = atlasOption.id === 'schaefer400' ? Uint16Array : Uint8Array;
    const atlasLabels = new OutputCtor(atlas.data.length);
    for (let i = 0; i < atlas.data.length; i++) {
      const label = Math.round(Number(atlas.data[i]) || 0);
      atlasLabels[i] = label > 0 ? label : 0;
    }
    const resampled = resampleAffine(
      atlasLabels,
      atlas.dims, atlasAffine,
      mni160.dims, mni160Affine,
      'nearest'
    );
    return {
      labels: resampled instanceof OutputCtor ? resampled : new OutputCtor(resampled),
      dims: mni160.dims,
      affine: mni160Affine,
      atlasOption
    };
  }

  async projectYeoAtlasToMni160Grid() {
    return this.projectAtlasToMni160Grid();
  }

  async projectAtlasToPatientSpace() {
    if (!this.structuralFile) {
      throw new Error('No structural T1 is available.');
    }
    if (!this.hasRegistrationDisplacement) {
      throw new Error('Run MNI registration first.');
    }
    const { labels, dims, atlasOption } = await this.projectAtlasToMni160Grid();
    const maskBuffer = labels.buffer.slice(labels.byteOffset, labels.byteOffset + labels.byteLength);
    await this.runInverseWarpStage({
      maskBuffer,
      maskDims: dims,
      stage: 'atlas-patient',
      description: `${atlasSpaceName(atlasOption)} atlas projected to patient T1 space`,
      labelMap: true,
      labelDataType: labels instanceof Uint16Array ? 'uint16' : 'uint8'
    }, 'atlas-patient');
    return this.patientAtlasFile;
  }

  async showSubjectSpaceAtlas() {
    if (!this.patientAtlasFile) {
      this.updateOutput(`Projecting ${atlasSpaceName(this.getAtlasOption())} atlas to patient T1 space for visual alignment QC...`);
      await this.projectAtlasToPatientSpace();
    }
    this.viewerLayerVisibility.atlasQc = true;
    await this.renderPatientLayerStack({ includeAtlas: true, includeThreshold: false });
    this.refreshViewerLayerControls();
    this.updateOutput('Atlas alignment QC overlay displayed. This is a visual check, not an automated pass/fail score.');
    return this.patientAtlasFile;
  }

  getRegistrationBlendValue() {
    const el = document.getElementById('registrationBlendValue');
    const raw = el?.value ?? this.registrationBlendValue ?? 0.5;
    const value = Number(raw);
    if (!Number.isFinite(value)) return 0.5;
    return Math.max(0, Math.min(1, value));
  }

  formatRegistrationBlendLabel(value = this.registrationBlendValue) {
    const numeric = Number(value);
    const blend = Number.isFinite(numeric) ? Math.max(0, Math.min(1, numeric)) : 0.5;
    if (blend <= 0) return 'MNI template';
    if (blend >= 1) return 'Registered patient';
    return `${Math.round(blend * 100)}% patient`;
  }

  updateRegistrationBlendLabel(value = this.registrationBlendValue) {
    const el = document.getElementById('registrationBlendLabel');
    if (el) el.textContent = this.formatRegistrationBlendLabel(value);
  }

  applyRegistrationBlend(value = this.getRegistrationBlendValue()) {
    const numeric = Number(value);
    const blend = Number.isFinite(numeric) ? Math.max(0, Math.min(1, numeric)) : 0.5;
    this.registrationBlendValue = blend;
    this.updateRegistrationBlendLabel(blend);
    if (!this.viewerController?.setStageOpacity) return false;
    const applied = this.viewerController.setStageOpacity('registered-t1-mni160', blend, {
      apply: true,
      redraw: true
    });
    return !!applied;
  }

  async handleRegistrationBlendInput() {
    const blend = this.getRegistrationBlendValue();
    if (this.applyRegistrationBlend(blend)) return;
    if (!this.hasRegistrationDisplacement || !this.registeredT1MniFile) return;
    const modeEl = document.getElementById('registrationQcMode');
    if (modeEl) modeEl.value = 'mni';
    this.registrationQcMode = 'mni';
    await this.renderMniRegistrationQc();
  }

  getRegistrationQcMode() {
    const el = document.getElementById('registrationQcMode');
    const mode = el?.value || this.registrationQcMode || 'mni';
    return ['patient', 'mni', 'checkerboard', 'displacement'].includes(mode) ? mode : 'mni';
  }

  async showRegistrationQc(mode = this.getRegistrationQcMode()) {
    this.registrationQcMode = mode;
    if (mode === 'patient') {
      return this.showSubjectSpaceAtlas();
    }
    if (!this.hasRegistrationDisplacement) {
      throw new Error('Run MNI registration first.');
    }
    if (mode === 'mni') return this.renderMniRegistrationQc();
    if (mode === 'checkerboard') return this.renderCheckerboardRegistrationQc();
    if (mode === 'displacement') return this.renderDisplacementRegistrationQc();
    return this.showSubjectSpaceAtlas();
  }

  async ensureRegistrationTemplateFile() {
    if (this.registrationTemplateFile) return this.registrationTemplateFile;
    const mni160 = await loadAtlasFromManifest('lnm-mni160');
    const affine = flattenAffine3Rows(affineFromHeader(mni160.header));
    const data = mni160.data instanceof Float32Array
      ? Float32Array.from(mni160.data)
      : Float32Array.from(mni160.data, Number);
    const niftiBuffer = writeNifti1(data, {
      dims: mni160.dims,
      spacing: [1, 1, 1],
      affine,
      description: 'LNM fixed MNI160 registration QC template'
    });
    this.registrationTemplateFile = arrayBufferToFile(niftiBuffer, 'lnm-mni160-template.nii', {
      space: VOLUME_SPACES.MNI160,
      role: 'registration-template',
      sourceStage: 'registration-template',
      dims: mni160.dims,
      affine: affineFromHeader(mni160.header)
    });
    return this.registrationTemplateFile;
  }

  async ensureYeoAtlasMni160File() {
    if (this.yeoAtlasMni160File) return this.yeoAtlasMni160File;
    const { labels, dims, affine } = await this.projectYeoAtlasToMni160Grid();
    const niftiBuffer = writeNifti1(labels, {
      dims,
      spacing: [1, 1, 1],
      affine: flattenAffine3Rows(affine),
      description: 'LNM Yeo7 label atlas resampled to fixed MNI160 grid'
    });
    this.yeoAtlasMni160File = arrayBufferToFile(niftiBuffer, 'lnm-yeo7-atlas-mni160.nii', {
      space: VOLUME_SPACES.MNI160,
      role: 'atlas-qc',
      sourceStage: 'atlas-mni160',
      dims,
      affine
    });
    return this.yeoAtlasMni160File;
  }

  async ensureRegistrationCheckerboardFile(blockSize = 8) {
    if (this.registrationCheckerboardFile) return this.registrationCheckerboardFile;
    if (!this.registeredT1MniFile) {
      throw new Error('Registered T1 QC volume is not available; rerun MNI registration.');
    }
    await this.ensureRegistrationTemplateFile();
    const [templateBuf, registeredBuf] = await Promise.all([
      this.registrationTemplateFile.arrayBuffer(),
      this.registeredT1MniFile.arrayBuffer()
    ]);
    const template = await decodeNiftiBuffer(templateBuf);
    const registered = await decodeNiftiBuffer(registeredBuf);
    if (!dimsEqual(template.dims, registered.dims)) {
      throw new Error(
        `Registration checkerboard requires matching dims; ` +
        `template=${template.dims.join('x')} registered=${registered.dims.join('x')}`
      );
    }
    const [X, Y, Z] = template.dims;
    const out = new Float32Array(template.data.length);
    for (let z = 0; z < Z; z++) {
      for (let y = 0; y < Y; y++) {
        for (let x = 0; x < X; x++) {
          const i = x + y * X + z * X * Y;
          const useRegistered = (
            Math.floor(x / blockSize) +
            Math.floor(y / blockSize) +
            Math.floor(z / blockSize)
          ) % 2 === 0;
          out[i] = Number(useRegistered ? registered.data[i] : template.data[i]) || 0;
        }
      }
    }
    const niftiBuffer = writeNifti1(out, {
      dims: template.dims,
      spacing: [1, 1, 1],
      affine: flattenAffine3Rows(affineFromHeader(template.header)),
      description: 'LNM registration QC checkerboard: fixed MNI template and registered T1'
    });
    this.registrationCheckerboardFile = arrayBufferToFile(niftiBuffer, 'lnm-registration-checkerboard.nii', {
      space: VOLUME_SPACES.MNI160,
      role: 'registration-checkerboard',
      sourceStage: 'registration-checkerboard',
      dims: template.dims,
      affine: affineFromHeader(template.header)
    });
    return this.registrationCheckerboardFile;
  }

  async renderMniRegistrationQc() {
    if (!this.registeredT1MniFile) {
      throw new Error('Registered T1 QC volume is not available; rerun MNI registration.');
    }
    const templateFile = await this.ensureRegistrationTemplateFile();
    const blend = this.getRegistrationBlendValue();
    this.registrationBlendValue = blend;
    this.updateRegistrationBlendLabel(blend);
    const entries = [
      { file: templateFile, stage: 'registration-template' },
      {
        file: this.registeredT1MniFile,
        colormap: 'gray',
        opacity: blend,
        scalar: true,
        stage: 'registered-t1-mni160'
      }
    ];
    this.assertViewerStackSpaces(entries, 'MNI registration QC stack');
    await this.loadViewerVolumeStack(entries);
    this.applyViewerLayerVisibility();
    this.applyRegistrationBlend(blend);
    this.refreshViewerLayerControls();
    this.updateOutput('Registration QC: MNI-space registered T1 and fixed template displayed. Use the Patient/MNI blend slider for visual QC.');
  }

  async renderCheckerboardRegistrationQc() {
    const checkerboardFile = await this.ensureRegistrationCheckerboardFile();
    const entries = [
      { file: checkerboardFile, stage: 'registration-checkerboard' }
    ];
    this.assertViewerStackSpaces(entries, 'Registration checkerboard stack');
    await this.loadViewerVolumeStack(entries);
    this.applyViewerLayerVisibility();
    this.refreshViewerLayerControls();
    this.updateOutput('Registration QC: checkerboard of fixed MNI template and registered T1 displayed.');
  }

  async renderDisplacementRegistrationQc() {
    if (!this.displacementMagnitudeFile) {
      throw new Error('Displacement magnitude QC map is not available; rerun MNI registration.');
    }
    const entries = [
      { file: await this.ensureRegistrationTemplateFile(), stage: 'registration-template' }
    ];
    if (this.registeredT1MniFile) {
      const blend = this.getRegistrationBlendValue();
      this.registrationBlendValue = blend;
      this.updateRegistrationBlendLabel(blend);
      entries.push({
        file: this.registeredT1MniFile,
        colormap: 'gray',
        opacity: blend,
        scalar: true,
        stage: 'registered-t1-mni160'
      });
    }
    entries.push({
      file: this.displacementMagnitudeFile,
      colormap: 'blue2red',
      opacity: 0.65,
      scalar: true,
      stage: 'registration-displacement'
    });
    this.assertViewerStackSpaces(entries, 'Registration displacement QC stack');
    await this.loadViewerVolumeStack(entries);
    this.applyRegistrationBlend(this.registrationBlendValue);
    this.refreshViewerLayerControls();
    this.updateOutput('Registration QC: SynthMorph displacement magnitude displayed on the fixed MNI template.');
  }

  async renderPatientLayerStack({ includeAtlas = false, includeThreshold = true } = {}) {
    if (!this.structuralFile) return;
    const entries = [{
      file: this.structuralFile,
      stage: 'structural',
      visible: this.layerVisible('structural')
    }];
    if (includeAtlas && this.patientAtlasFile) {
      entries.push({
        file: this.patientAtlasFile,
        colormap: this.getAtlasOption().colormap,
        opacity: 0.45,
        stage: 'atlas-qc',
        visible: this.layerVisible('atlasQc')
      });
    }
    if (includeThreshold && this.patientThresholdedMaskFile) {
      entries.push({
        file: this.patientThresholdedMaskFile,
        colormap: 'red',
        opacity: 0.65,
        stage: 'threshold-preview',
        visible: this.layerVisible('threshold')
      });
    }
    this.assertViewerStackSpaces(entries, 'Patient-space viewer stack');
    await this.loadViewerVolumeStack(entries);
    this.applyViewerLayerVisibility();
    this.refreshViewerLayerControls();
    this.updateOutput(includeAtlas
      ? 'Patient-space atlas QC stack displayed.'
      : 'Final patient-space view displayed: structural T1 with threshold map.');
  }

  async renderAtlasThresholdPreviewOverlay(version) {
    const file = this.thresholdedMaskFile;
    if (version !== this._thresholdPreviewVersion || !file) return;
    if (!this.viewerController?.replaceOverlayForStage) return;
    try {
      await this.viewerController.replaceOverlayForStage(
        'threshold-preview',
        file,
        'red',
        0.65,
        { visible: this.layerVisible('threshold') }
      );
      if (version !== this._thresholdPreviewVersion) {
        this.viewerController?.removeVolumeForStage?.('threshold-preview');
      }
      this.refreshViewerLayerControls();
    } catch (err) {
      this.updateOutput(`Threshold preview render error: ${err.message}`);
    }
  }

  downloadThresholdedNetworkMap() {
    if (!this.thresholdedMaskFile) {
      // Try to (re)compute first.
      this.applyNetworkThreshold();
      if (!this.thresholdedMaskFile) return;
    }
    const url = URL.createObjectURL(this.thresholdedMaskFile);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'lnm-network-map-thresh.nii';
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  }

  downloadSubjectSpaceAtlas() {
    if (!this.patientAtlasFile) {
      this.updateOutput('No patient-space atlas available yet.');
      return;
    }
    const url = URL.createObjectURL(this.patientAtlasFile);
    const a = document.createElement('a');
    a.href = url;
    a.download = `lnm-${this.getAtlasOption().id}-atlas-patient.nii`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  }

  // Phase 3.4: SynthMorph MNI registration. Looks up the model + reference
  // in the manifest, posts to the worker. The worker stashes the integrated
  // displacement field on its state for the lnm-yeo-auto bridge (Phase 3.5)
  // to apply via runWarpMask.
  async runRegistration() {
    if (!this.structuralFile) {
      this.updateOutput('Drop a structural image first.');
      return;
    }
    const manifest = await this.ensureManifest();
    const model = manifest.modelAssets?.find(a => a.id === 'lnm-synthmorph-mni');
    const ref = manifest.atlasAssets?.find(a => a.id === 'lnm-mni160');
    if (!model || model.supportStatus !== 'supported') {
      throw new Error("Manifest entry 'lnm-synthmorph-mni' is not supported.");
    }
    if (!ref || ref.supportStatus !== 'supported') {
      throw new Error("Manifest entry 'lnm-mni160' is not supported.");
    }
    const m = splitModelUrl(model.sourceUrl);
    const modelFileName = (model.filename || m.name || 'lnm-synthmorph-mni.onnx').split('/').pop();
    const modelLocalUrl = new URL(`models/_dev_cache/${modelFileName}`, window.location.href).href;

    this.updateOutput('Starting MNI registration (SynthMorph deformable)...');
    this.patientAtlasFile = null;
    this.registeredT1MniFile = null;
    this.displacementMagnitudeFile = null;
    this.registrationCheckerboardFile = null;
    this.refreshViewerLayerControls();
    const registrationReady = this._waitForStepComplete('register');
    const inputBuffer = await this.structuralFile.arrayBuffer();
    assertSpace(this.structuralFile, VOLUME_SPACES.MNI160, 'MNI registration structural input');
    await this.executor.loadVolume(inputBuffer);
    let brainMaskBuffer = null;
    let brainMaskDims = null;
    if (this.brainmaskFile) {
      assertSpace(this.brainmaskFile, VOLUME_SPACES.MNI160, 'MNI registration brain-mask input');
      const brainmask = await decodeNiftiBuffer(await this.brainmaskFile.arrayBuffer());
      const mask = binarise(brainmask.data);
      brainMaskBuffer = mask.buffer.slice(mask.byteOffset, mask.byteOffset + mask.byteLength);
      brainMaskDims = brainmask.dims;
    }
    await this.executor.runRegistration({
      modelAssetId: model.id,
      modelName: m.name || modelFileName,
      modelBaseUrl: m.base,
      modelCacheKey: model.cacheKey,
      modelLocalUrl,
      modelInputDims: model.browserRuntime?.inputDims || model.inputShape?.slice(1, 4),
      svfDims: model.browserRuntime?.svfDims || model.svfShape?.slice(1, 4),
      executionProviders: model.browserRuntime?.executionProviders,
      referenceAssetId: ref.id,
      referenceUrl: ref.sourceUrl,
      referenceCacheKey: ref.cacheKey,
      brainMaskBuffer,
      brainMaskDims,
      nbSteps: 7
    });
    await registrationReady;
    this.hasRegistrationDisplacement = true;
    this._thresholdProjectionWarningShown = false;
    this.refreshViewerLayerControls();
  }

  // Phase 16.2: in-browser affine pre-registration (centroid match) so
  // arbitrary clinical T1s can flow into the SynthMorph deformable
  // stage, which hard-requires 160x160x192 1mm input. Runs SynthStrip
  // first if no brainmask is present, computes the brain centroid in
  // source world coords, then resamples the T1 + brainmask onto the
  // MNI160 1mm grid with the centroid placed at MNI voxel (80, 80, 96).
  // The lesion seg + lesion file are cleared because they were
  // computed in the old space; user re-runs them on the aligned grid.
  async prealignToMni160({ skipIfAligned = false } = {}) {
    if (!this.structuralFile) {
      this.updateOutput('Drop a structural T1 first.');
      return;
    }
    let mni160Ref = null;
    const getMni160Ref = async () => {
      if (!mni160Ref) mni160Ref = await loadAtlasFromManifest('lnm-mni160');
      return mni160Ref;
    };

    // Phase 34: idempotent fast-path. If the structural is already at
    // exactly the SynthMorph-required fixed lnm-mni160 pose, prealign
    // has nothing to do — used by runFullPipeline's auto chain so users
    // with already-aligned T1s don't pay the cost. Dims alone are not
    // sufficient: an oblique 160x160x192 prealign output must still be
    // canonicalised onto the fixed template affine.
    if (skipIfAligned) {
      const [probeBuf, mni160] = await Promise.all([
        this.structuralFile.arrayBuffer(),
        getMni160Ref()
      ]);
      const probe = await decodeNiftiBuffer(probeBuf);
      const probeAffine = affineFromHeader(probe.header);
      const mni160Affine = affineFromHeader(mni160.header);
      const isAligned = dimsEqual(probe.dims, mni160.dims) &&
        affineNearlyEqual(probeAffine, mni160Affine);
      if (isAligned) {
        this.tagDecodedFileSpace(this.structuralFile, probe, {
          space: VOLUME_SPACES.MNI160,
          role: 'structural',
          sourceStage: 'prealign-skip'
        });
        if (!this.nativeStructuralFile) this.nativeStructuralFile = this.structuralFile;
        if (!this.nativeStructuralInfo) {
          this.nativeStructuralInfo = { dims: probe.dims, affine: probeAffine };
        }
        this.fixedMni160Info = { dims: mni160.dims, affine: mni160Affine, spacing: [1, 1, 1] };
        this.prealignSamplingAffine = mni160Affine;
        this.updateOutput('Structural already matches lnm-mni160, skipping prealign.');
        return;
      }
    }

    if (!this.brainmaskFile) {
      this.updateOutput('Running brain extraction (prealign needs the brain mask)...');
      await this.runBrainExtraction();
      if (!this.brainmaskFile) {
        throw new Error('Brain extraction did not produce a mask; prealign aborted.');
      }
    }

    this.updateOutput('Decoding T1 + brainmask for prealign...');
    const t1Buf = await this.structuralFile.arrayBuffer();
    const t1 = await decodeNiftiBuffer(t1Buf);
    const t1Affine = affineFromHeader(t1.header);
    this.tagDecodedFileSpace(this.structuralFile, t1, {
      space: this.structuralSpace() || VOLUME_SPACES.NATIVE_T1,
      role: 'structural',
      sourceStage: 'prealign-input'
    });
    if (!this.nativeStructuralFile) this.nativeStructuralFile = this.structuralFile;
    if (!this.nativeStructuralInfo) {
      this.nativeStructuralInfo = { dims: t1.dims, affine: t1Affine };
    }

    const maskBuf = await this.brainmaskFile.arrayBuffer();
    const mask = await decodeNiftiBuffer(maskBuf);
    this.tagDecodedFileSpace(this.brainmaskFile, mask, {
      space: this.structuralSpace() || VOLUME_SPACES.NATIVE_T1,
      role: 'brainmask',
      sourceStage: 'prealign-input'
    });
    if (!dimsEqual(mask.dims, t1.dims)) {
      throw new Error(
        `prealign: brain mask dims ${mask.dims.join('x')} != T1 dims ${t1.dims.join('x')}`
      );
    }

    // PCA principal-axis alignment (Phase 26): rotates the brain so its
    // principal axes line up with MNI canonical axes, plus the centroid
    // translation. For nearly-isotropic brains the rotation is small;
    // for clinical T1s acquired off-axis it can be substantial.
    const mni160 = await getMni160Ref();
    const mni160Affine = affineFromHeader(mni160.header);
    this.fixedMni160Info = { dims: mni160.dims, affine: mni160Affine, spacing: [1, 1, 1] };
    const mniForegroundMask = foregroundMaskFromIntensity(mni160.data, mni160.dims, 0.05);
    const mniCenterVox = centroidOfMask(mniForegroundMask, mni160.dims);
    const { dstAffine, mniDims, eigenvalues } = principalAxisAlign(
      mask.data, t1.dims, t1Affine,
      { mniDims: mni160.dims, mniCenterVox, mniAffine: mni160Affine }
    );
    this.prealignSamplingAffine = dstAffine;
    const cVox = centroidOfMask(mask.data, t1.dims);
    const cWorld = applyAffineToVoxel(t1Affine, cVox);
    this.updateOutput(
      `Prealign (PCA): centroid src voxel (${cVox.map(v => v.toFixed(1)).join(', ')}) ` +
      `-> world (${cWorld.map(v => v.toFixed(1)).join(', ')}) mm; ` +
      `eigenvalues=[${eigenvalues.map(e => e.toFixed(1)).join(', ')}].`
    );

    // Resample T1 (trilinear) and brainmask (nearest, binary).
    const t1Resampled = resampleAffine(
      t1.data, t1.dims, t1Affine, mniDims, dstAffine, 'trilinear'
    );
    const maskResampled = resampleAffine(
      mask.data, t1.dims, t1Affine, mniDims, dstAffine, 'nearest'
    );
    const maskBin = new Uint8Array(maskResampled.length);
    for (let i = 0; i < maskResampled.length; i++) maskBin[i] = maskResampled[i] > 0.5 ? 1 : 0;

    const flatAff = flattenAffine3Rows(mni160Affine);
    const t1Nifti = writeNifti1(t1Resampled, {
      dims: mniDims, spacing: [1, 1, 1], affine: flatAff,
      description: 'LNM prealign: resampled to fixed lnm-mni160 1mm'
    });
    const maskNifti = writeNifti1(maskBin, {
      dims: mniDims, spacing: [1, 1, 1], affine: flatAff,
      description: 'LNM prealign brainmask resampled to fixed lnm-mni160 1mm'
    });

    this.structuralFile = arrayBufferToFile(t1Nifti, 'lnm-prealign-t1.nii', {
      space: VOLUME_SPACES.MNI160,
      role: 'structural',
      sourceStage: 'prealign',
      dims: mniDims,
      affine: mni160Affine
    });
    if (!this.nativeBrainmaskFile) this.nativeBrainmaskFile = this.brainmaskFile;
    this.brainmaskFile = arrayBufferToFile(maskNifti, 'lnm-prealign-brainmask.nii', {
      space: VOLUME_SPACES.MNI160,
      role: 'brainmask',
      sourceStage: 'prealign',
      dims: mniDims,
      affine: mni160Affine
    });
    this.hasRegistrationDisplacement = false;
    this._thresholdProjectionWarningShown = false;
    // Stale results from the pre-prealign space.
    this.lesionMaskFile = null;
    this.lesionMaskConfirmed = false;
    this.autoLesionSeedFile = null;
    this.nativeLesionSeedFile = null;
    this.confirmedNativeLesionFile = null;
    this.maskReviewActive = false;
    this.setMaskReview3DRenderEnabled(true);
    this.lesionFile = null;
    this.mniLesionFile = null;
    this.overlapResult = null;
    this.affectedNetworkResult = null;
    this.networkMapFile = null;
    this.networkMapData = null;
    this.thresholdedMaskFile = null;
    this.patientThresholdedMaskFile = null;
    this.patientAtlasFile = null;
    this.registeredT1MniFile = null;
    this.displacementMagnitudeFile = null;
    this.registrationCheckerboardFile = null;
    this.networkMapBaseFile = null;
    this.networkMapLabelAtlas = null;
    this.cancelThresholdPreviewOverlay({ removeOverlay: true });
    this.clearAffectedNetworkTable();

    // Refresh viewer with the aligned T1 + brainmask overlay.
    await this.loadViewerBaseVolume(this.structuralFile, {
      stage: 'structural',
      visible: this.layerVisible('structural')
    });
    try {
      this.assertViewerOverlaySpace(this.brainmaskFile, 'Prealign brain-mask overlay');
      await this.viewerController.loadOverlay(this.brainmaskFile, 'green', 0.4, {
        stage: 'brainmask',
        visible: this.layerVisible('brainmask')
      });
    } catch (err) {
      // Non-fatal: the overlay is cosmetic.
      this.updateOutput(`Brainmask overlay re-render warning: ${err.message}`);
    }
    this.refreshViewerLayerControls();
    this.updateOutput('Prealign complete: T1 + brainmask resampled to 160x160x192 1mm.');
    return this.structuralFile;
  }

  // Phase 6.2: bridge Register -> selected-atlas overlap. Decodes the segmentation NIfTI
  // produced by runLesionSegmentation, hands the F-order Uint8 voxels to the
  // worker (which applies the integrated displacement field stashed by
  // runRegistration), then resamples the warped 1mm output onto the selected
  // atlas grid via affine resample. Sets `this.lesionFile` so a follow-up
  // runAtlasOverlap()/runFcNetworkMap()/applyNetworkThreshold() chain runs
  // unmodified.
  async applyRegistrationToLesion() {
    if (!this.lesionMaskFile) {
      this.updateOutput('Confirm the edited lesion mask first.');
      return null;
    }
    if (!this.lesionMaskConfirmed) {
      this.updateOutput('Review and confirm the lesion mask before warping it.');
      return null;
    }
    assertSpace(this.lesionMaskFile, VOLUME_SPACES.MNI160, 'Warp lesion source');
    this.updateOutput('Decoding lesion mask for warp...');
    const lesionBuf = await this.lesionMaskFile.arrayBuffer();
    const decoded = await decodeNiftiBuffer(lesionBuf);
    if (decoded.dims[0] !== 160 || decoded.dims[1] !== 160 || decoded.dims[2] !== 192) {
      throw new Error(
        `applyRegistrationToLesion: expected 160x160x192 lesion mask; got ${decoded.dims.join('x')}. ` +
        `Run registration on a 160x160x192 1mm structural first.`
      );
    }
    const maskU8 = new Uint8Array(decoded.data.length);
    for (let i = 0; i < decoded.data.length; i++) maskU8[i] = decoded.data[i] > 0 ? 1 : 0;
    // Copy to a transferable ArrayBuffer (worker takes ownership).
    const transferBuf = maskU8.buffer.slice(0);

    this.mniLesionFile = null;
    const mniLesionPromise = new Promise((resolve, reject) => {
      this._mniLesionResolver = { resolve, reject };
    });
    await this.executor.runWarpMask({
      maskBuffer: transferBuf,
      maskDims: [160, 160, 192]
    });
    const mniLesionBuf = await mniLesionPromise;

    const atlasOption = this.getAtlasOption();
    // Resample the 1mm warped lesion onto the selected atlas grid.
    this.updateOutput(`Resampling warped lesion onto ${atlasSpaceName(atlasOption)} grid...`);
    const warped = await decodeNiftiBuffer(mniLesionBuf);
    if (this.mniLesionFile) {
      this.tagDecodedFileSpace(this.mniLesionFile, warped, {
        space: VOLUME_SPACES.MNI160,
        role: 'lesion',
        sourceStage: 'mni-lesion'
      });
    }
    const warpedAffine = affineFromHeader(warped.header);
    const atlas = await loadAtlasFromManifest(atlasOption.overlapAtlasAssetId);
    const atlasAffine = affineFromHeader(atlas.header);
    const warpedU8 = warped.data instanceof Uint8Array
      ? warped.data
      : binarise(warped.data);
    const atlasMask = resampleAffine(
      warpedU8,
      warped.dims, warpedAffine,
      atlas.dims, atlasAffine,
      'nearest'
    );

    // Wrap the atlas-grid mask as a NIfTI and adopt it as the lesion file.
    const flatAffine = flattenAffine3Rows(atlasAffine);
    const atlasNifti = writeNifti1(atlasMask, {
      dims: atlas.dims,
      spacing: [atlas.manifestEntry?.resolutionMm || 2, atlas.manifestEntry?.resolutionMm || 2, atlas.manifestEntry?.resolutionMm || 2],
      affine: flatAffine,
      description: `LNM lesion warped + resampled to ${atlasSpaceName(atlasOption)} grid`
    });
    const atlasFile = arrayBufferToFile(atlasNifti, `lnm-lesion-${atlasOption.id}.nii`, {
      space: atlasOptionSpace(atlasOption, 'overlap'),
      role: 'lesion',
      sourceStage: 'atlas-lesion',
      dims: atlas.dims,
      affine: atlasAffine
    });
    this.lesionFile = atlasFile;
    this.refreshViewerLayerControls();
    this.updateOutput(
      `Lesion ready on ${atlasSpaceName(atlasOption)} grid for overlap. ` +
      'Patient-space lesion overlay left unchanged.'
    );
    return atlasFile;
  }

  // Phase 15: pipeline-driven runFullPipeline. Iterates the selected
  // pipeline's stages and dispatches each via _runStage. The auto-detect
  // shortcut for manually-dropped Yeo-grid lesion masks survives as a
  // precondition gate when the pipeline starts with parcel-overlap.
  //
  // Stages declared as required:false are still run when their module is
  // implemented (e.g. threshold runs with the pipeline's `defaults` if
  // present, falling back to whatever the UI has set).
  async runFullPipeline() {
    const pipeline = this.selectedPipeline;
    if (!pipeline || !Array.isArray(pipeline.stages) || pipeline.stages.length === 0) {
      this.updateOutput('No pipeline selected.');
      return;
    }
    this.updateOutput(`=== Running ${pipeline.displayName} ===`);

    // Precondition gate based on the first stage's input expectation.
    const firstModule = pipeline.stages[0]?.module;
    if (firstModule === 'parcel-overlap') {
      // Manual-mask path — needs a lesion already aligned to the selected atlas.
      if (!this.lesionFile) {
        this.updateOutput('Drop an atlas-grid lesion mask first.');
        return;
      }
      const onAtlasGrid = await this._lesionFileMatchesAtlasGrid();
      if (!onAtlasGrid) {
        const atlasOption = this.getAtlasOption();
        this.updateOutput(
          `Lesion mask is not on the ${atlasSpaceName(atlasOption)} grid. Use a pipeline ` +
          'that includes registration, or pre-register the mask externally.'
        );
        return;
      }
    } else if (firstModule === 'brain-extraction' || firstModule === 'inference-pipeline') {
      // Auto path — needs a structural T1.
      if (!this.structuralFile) {
        this.updateOutput('Drop a structural T1 first.');
        return;
      }
    }

    this._perfStats = [];
    this._perfRunStart = this._now();
    const status = await this._runPipelineStages(pipeline, 0);
    if (status === 'complete') this.logPipelineComplete();
  }

  async _runPipelineStages(pipeline, startIndex = 0) {
    let stageIndex = -1;
    for (const stage of pipeline.stages) {
      stageIndex += 1;
      if (stageIndex < startIndex) continue;
      const stageStart = this._now();
      try {
        const result = await this._runStage(stage);
        if (result?.pausedForMaskReview) {
          this._pendingMaskResume = { pipeline, nextStageIndex: stageIndex + 1 };
          this.updateOutput('Pipeline paused for manual lesion-mask review.');
          return 'paused';
        }
        if (result?.stopPipeline) {
          return 'stopped';
        }
      } catch (err) {
        this.updateOutput(`Stage '${stage.id}' (${stage.module}) failed: ${err.message}`);
        return 'failed';
      }
      const elapsedMs = this._now() - stageStart;
      this._perfStats.push({ id: stage.id, module: stage.module, ms: elapsedMs });
      this.updateOutput(`[perf] ${stage.id} (${stage.module}): ${this._formatMs(elapsedMs)}`);
    }
    return 'complete';
  }

  logPipelineComplete() {
    const totalMs = this._now() - this._perfRunStart;
    this.updateOutput(
      `=== Pipeline complete in ${this._formatMs(totalMs)} ` +
      `(${this._perfStats.length} stage${this._perfStats.length === 1 ? '' : 's'}) ===`
    );
  }

  // Phase 19: monotonic clock; falls back to Date.now in non-browser
  // environments (the contract test imports the module under Node, so
  // performance.now is always defined there too — but we keep the guard
  // for older runtimes / shims).
  _now() {
    if (typeof performance !== 'undefined' && typeof performance.now === 'function') {
      return performance.now();
    }
    return Date.now();
  }

  _formatMs(ms) {
    if (ms < 1000) return `${ms.toFixed(0)} ms`;
    if (ms < 60_000) return `${(ms / 1000).toFixed(2)} s`;
    return `${(ms / 60_000).toFixed(2)} min`;
  }

  // Phase 15: stage dispatch. Maps a pipeline stage's `module` to the
  // existing orchestrator method. Unknown modules throw so a manifest
  // typo surfaces immediately rather than silently skipping.
  async _runStage(stage) {
    if (!stage || !stage.module) {
      throw new Error('_runStage: stage must declare a module');
    }
    switch (stage.module) {
      case 'brain-extraction':
        if (this.brainmaskFile) {
          this.updateOutput('Brain mask already present, skipping brain-extraction.');
          return;
        }
        return this.runBrainExtraction();
      case 'prealign':
        // Phase 34: idempotent prealign. Skip if the structural is
        // already at the SynthMorph-required pose (160x160x192 1mm).
        // prealignToMni160() handles the dim probe + early return.
        return this.prealignToMni160({ skipIfAligned: true });
      case 'inference-pipeline':
        if (this.lesionMaskFile && this.lesionMaskConfirmed) {
          this.updateOutput('Confirmed lesion mask already present, skipping segmentation.');
          return;
        }
        if (this.maskReviewActive || this.autoLesionSeedFile) {
          await this.startLesionMaskReview({ seedFile: this.autoLesionSeedFile });
          return { pausedForMaskReview: true };
        }
        await this.runLesionSegmentation();
        await this.startLesionMaskReview({ seedFile: this.autoLesionSeedFile });
        return { pausedForMaskReview: true };
      case 'registration':
        // The bridge (apply-warp + selected-atlas resample) is the natural
        // companion of the SynthMorph registration step. We chain them
        // here so a pipeline doesn't have to declare the bridge as a
        // separate stage.
        await this.runRegistration();
        return this.applyRegistrationToLesion();
      case 'parcel-overlap':
        return this.runAtlasOverlap();
      case 'fc-weighted-sum':
        return this.runFcNetworkMap();
      case 'threshold':
        // applyNetworkThreshold is sync and reads UI controls. If the
        // stage carries `defaults`, push them into the controls before
        // computing so the selected pipeline's defaults are honoured when the
        // user hasn't touched the threshold UI.
        this._applyThresholdDefaults(stage.defaults);
        this.applyNetworkThreshold();
        return;
      default:
        throw new Error(`_runStage: unknown module '${stage.module}'`);
    }
  }

  // Phase 15: copy the pipeline stage's threshold defaults into the live
  // UI controls so applyNetworkThreshold (which reads from the DOM) honours
  // them.  No-op if the controls are missing.
  _applyThresholdDefaults(defaults) {
    if (!defaults || typeof defaults !== 'object') return;
    const valueEl = document.getElementById('networkThresholdValue');
    const symEl = document.getElementById('networkThresholdSymmetric');
    const minClEl = document.getElementById('networkThresholdMinCluster');
    this.configureTopPercentThresholdSlider();
    if (valueEl && typeof defaults.value === 'number') {
      // Slider stores the raw top-percent UI value (5 = strongest 5%).
      valueEl.value = String(defaults.value);
    }
    if (symEl && typeof defaults.symmetric === 'boolean') symEl.checked = defaults.symmetric;
    if (minClEl && typeof defaults.minClusterVoxels === 'number') {
      minClEl.value = String(normalizeMinClusterVoxels(defaults.minClusterVoxels));
    }
    this.updateThresholdValueLabel();
  }

  // Phase 21: clear all intermediate pipeline state so the user can start
  // a fresh run without reloading the page. Resets every result slot, the
  // viewer, and the threshold UI surface; preserves the structural file
  // (the user usually wants to re-run on the same input) unless `full`
  // is set.
  clearResults({ full = false } = {}) {
    this.overlapResult = null;
    this.affectedNetworkResult = null;
    this.brainmaskFile = null;
    this.nativeBrainmaskFile = null;
    this.lesionMaskFile = null;
    this.lesionMaskConfirmed = false;
    this.autoLesionSeedFile = null;
    this.nativeLesionSeedFile = null;
    this.confirmedNativeLesionFile = null;
    this.maskReviewActive = false;
    this.setMaskReview3DRenderEnabled(true);
    this._pendingMaskResume = null;
    this.networkMapFile = null;
    this.networkMapData = null;
    this.networkMapDims = null;
    this.networkMapSpacing = null;
    this.networkMapAffine = null;
    this.networkMapBaseFile = null;
    this.networkMapLabelAtlas = null;
    this.thresholdedMaskFile = null;
    this.patientThresholdedMaskFile = null;
    this.patientAtlasFile = null;
    this.registeredT1MniFile = null;
    this.displacementMagnitudeFile = null;
    this.registrationCheckerboardFile = null;
    this.hasRegistrationDisplacement = false;
    this._thresholdProjectionWarningShown = false;
    this.cancelThresholdPreviewOverlay({ removeOverlay: true });
    this.mniLesionFile = null;
    if (full) {
      this.structuralFile = null;
      this.viewerBaseFile = null;
      this.nativeStructuralFile = null;
      this.nativeStructuralInfo = null;
      this.fixedMni160Info = null;
      this.prealignSamplingAffine = null;
      this.lesionFile = null;
    }

    // Re-disable every download / threshold-output button so the UI matches
    // the cleared state.
    const buttonIds = [
      'downloadOverlapCsv',
      'downloadBrainMaskButton',
      'downloadLesionMaskButton',
      'downloadNetworkMapButton',
      'downloadThresholdedNetworkMapButton',
      'downloadEditedLesionMaskButton',
      'checkAtlasAlignmentButton',
      'showSubjectAtlasButton',
      'downloadSubjectAtlasButton'
    ];
    for (const id of buttonIds) {
      const el = document.getElementById(id);
      if (el) el.disabled = true;
    }
    // Wipe the overlap table body if present.
    const tbody = document.querySelector('#networkOverlapTable tbody');
    if (tbody) tbody.innerHTML = '';
    this.clearFunctionProfileTable('directFunctionProfileResults', 'directFunctionProfileTable');
    // Reset the threshold summary.
    const summaryEl = document.getElementById('networkThresholdSummary');
    if (summaryEl) summaryEl.textContent = 'Compute a network map first to enable thresholding.';
    this.clearAffectedNetworkTable();
    // Hide atlas-label coverage note.
    this.showAtlasCoverageNote(0, 0);

    if (this.executor && typeof this.executor.clearResults === 'function') {
      this.executor.clearResults();
    }

    // Restore the structural file in the viewer (or clear entirely on full reset).
    if (full || !this.structuralFile) {
      try { this.viewerController.clearAll?.(); } catch (e) { /* non-fatal */ }
    } else if (this.structuralFile) {
      this.loadViewerBaseVolume(this.structuralFile, {
        stage: 'structural',
        visible: this.layerVisible('structural')
      })
        .catch(err => this.updateOutput(`Viewer reload after reset failed: ${err.message}`));
    }
    this.refreshViewerLayerControls();
    this.refreshMaskDrawingControls();
    this.updateOutput(full ? 'All state cleared.' : 'Results cleared (structural retained).');
  }

  async _lesionFileMatchesYeoGrid() {
    return this._lesionFileMatchesAtlasGrid();
  }

  async _lesionFileMatchesAtlasGrid() {
    if (!this.lesionFile) return false;
    try {
      const buf = await this.lesionFile.arrayBuffer();
      const decoded = await decodeNiftiBuffer(buf);
      const atlas = await loadAtlasFromManifest(this.getAtlasOption().overlapAtlasAssetId);
      return dimsEqual(decoded.dims, atlas.dims);
    } catch (err) {
      this.updateOutput(`Could not inspect lesion file: ${err.message}`);
      return false;
    }
  }

  showYeoLabelCoverageNote(outside, total) {
    return this.showAtlasCoverageNote(outside, total);
  }

  showAtlasCoverageNote(outside, total) {
    const el = document.getElementById('outsideAtlasWarning');
    if (!el) return;
    if (outside > 0 && total > 0) {
      const assigned = total - outside;
      el.textContent = `${assigned} of ${total} lesion voxels are assigned to ${atlasSpaceName(this.getAtlasOption())} labels; ${outside} are unlabeled by this atlas.`;
      el.classList.remove('hidden');
    } else {
      el.textContent = '';
      el.classList.add('hidden');
    }
  }

  exportCsv() {
    if (!this.overlapResult) return;
    const csv = serializeOverlapCsv(this.getDisplayOverlapSummary(), {
      networkSizes: this.overlapResult.networkSizes
    });
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'lnm-overlap.csv';
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  }

  updateOutput(message, options = {}) {
    const level = this.logLevelForMessage(message, options);
    this.updateDebugOutput(message, { source: options.source || 'app', level });
    const clinicalMessage = this.clinicalLogMessage(message, { ...options, level });
    if (clinicalMessage && clinicalMessage !== this._lastClinicalLogMessage) {
      this._lastClinicalLogMessage = clinicalMessage;
      this.console.log(clinicalMessage, { level });
    }
  }

  updateDebugOutput(message, options = {}) {
    this.technicalConsole?.log(message, {
      level: options.level || this.logLevelForMessage(message, options),
      source: options.source || 'app'
    });
  }

  logLevelForMessage(message, options = {}) {
    if (options.level) return options.level;
    const text = String(message || '');
    if (/\b(failed|failure|error|cannot|could not|rejected|mismatch|does not match)\b/i.test(text)) {
      return 'error';
    }
    if (/\b(warning|unavailable|cancelled|aborted)\b/i.test(text)) {
      return 'warning';
    }
    return 'info';
  }

  shouldShowClinicalLog(message, options = {}) {
    return !!this.clinicalLogMessage(message, options);
  }

  clinicalLogMessage(message, options = {}) {
    if (options.audience === 'technical') return null;
    const text = String(message || '');
    if (!text) return null;
    if (options.level === 'error' || options.level === 'warning') return text;
    if (/^No labelled .+ parcels overlap the lesion\b/.test(text)) {
      return 'Network map skipped: no labelled atlas parcels overlap the lesion.';
    }

    const directPatterns = [
      /^Ready\.$/,
      /^Atlas set to\b/,
      /^Drop\b/,
      /^No\b/,
      /^Run "Compute overlap" first\b/,
      /^Compute the network map first\.$/,
      /^Confirm\b/,
      /^Review and confirm\b/,
      /^Review\/edit the lesion mask\b/,
      /^3D render view is hidden\b/,
      /^Smooth mask needs\b/,
      /^Interpolate needs\b/,
      /^All state cleared\.$/,
      /^Results cleared\b/,
      /^Overlap computed for\b/,
      /^Network map ready\b/,
      /^Registration QC:/,
      /^Atlas alignment QC overlay displayed\b/
    ];
    if (directPatterns.some(pattern => pattern.test(text))) return text;

    const condensedPatterns = [
      [/^Structural image ready:/, 'Structural image ready.'],
      [/^Lesion mask ready:/, 'Lesion mask ready.'],
      [/^=== Running\b/, 'Analysis started.'],
      [/^=== Pipeline complete\b/, 'Analysis complete.'],
      [/^Starting SynthStrip brain extraction\b/, 'Brain extraction started.'],
      [/^Running brain extraction\b/, 'Brain extraction started.'],
      [/^Brain mask ready\.$/, 'Brain extraction complete.'],
      [/^Starting lesion segmentation\b/, 'Lesion segmentation started.'],
      [/^Automatic lesion seed ready for manual review\.$/, 'Lesion mask ready for review.'],
      [/^Blank editable lesion mask ready\.$/, 'Lesion mask ready for review.'],
      [/^Editable lesion seed loaded:/, 'Lesion mask ready for review.'],
      [/^Manual lesion mask ready for editing:/, 'Lesion mask ready for review.'],
      [/^Edited lesion mask confirmed\b/, 'Lesion mask confirmed.'],
      [/^Resuming analysis with confirmed lesion mask\b/, 'Analysis resumed.'],
      [/^Starting MNI registration\b/, 'MNI registration started.'],
      [/^Registered T1 QC volume ready\b/, 'MNI registration complete.'],
      [/^Prealign complete\b/, 'Pre-align complete.'],
      [/^Loading .+ atlas\.\.\.$/, 'Atlas overlap started.'],
      [/^Loading .+ group-FC pack\.\.\.$/, 'Connectivity map started.'],
      [/^Lesion ready on .+ grid for overlap\b/, 'Lesion warped to atlas grid.'],
      [/^Threshold map projected to patient T1 space\.$/, 'Threshold map projected to patient space.']
    ];
    const match = condensedPatterns.find(([pattern]) => pattern.test(text));
    return match ? match[1] : null;
  }

  isTechnicalLogMessage(message) {
    const text = String(message || '');
    return (
      /^\[perf\]/.test(text) ||
      /^Worker step\b/.test(text) ||
      /^(Initializing ONNX Runtime|ONNX Runtime ready|Inference worker ready)\b/.test(text) ||
      /^Decoding\b/.test(text) ||
      /^Downloading .+:\s+\d/.test(text) ||
      /^Computing network map: weights=/.test(text) ||
      /^Prepared mask download:/.test(text) ||
      /download route unavailable|Cached download unavailable/.test(text) ||
      /^Resampling warped lesion onto\b/.test(text) ||
      /^Structural already matches lnm-mni160\b/.test(text) ||
      /already present, skipping\b/.test(text)
    );
  }

  updateViewerInfo(data) {
    const primary = document.getElementById('viewerInfoPrimary');
    if (primary) primary.textContent = data?.string || '';
    const label = document.getElementById('viewerInfoLabel');
    if (label) label.textContent = '';
  }
}

const app = new LesionNetworkMappingApp();
if (typeof window !== 'undefined') window.app = app;
document.addEventListener('DOMContentLoaded', () => app.init());
