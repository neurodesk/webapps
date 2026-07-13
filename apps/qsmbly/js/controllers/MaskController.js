/**
 * Mask Controller
 *
 * Manages mask state, preparation, morphological operations, drawing mode,
 * threshold detection, and BET integration.
 */

import { erodeMask3D, dilateMask3D, fillHoles3D } from '../modules/mask/MorphologyOps.js';
import { computeOtsuThreshold } from '../modules/mask/ThresholdUtils.js';
import { createMaskNifti, createNiftiHeaderFromVolume } from '../modules/file-io/NiftiUtils.js';

export class MaskController {
  /**
   * @param {Object} options
   * @param {Object} options.nv - NiiVue instance
   * @param {Function} options.getWorker - Function that returns the worker
   * @param {Function} options.updateOutput - Logging callback
   * @param {Function} options.setProgress - Progress callback
   * @param {Function} options.initializeWorker - Worker initialization function
   * @param {Object} options.config - Reference to QSMConfig
   */
  constructor(options) {
    this.nv = options.nv;
    this.getWorker = options.getWorker;
    this.updateOutput = options.updateOutput;
    this.setProgress = options.setProgress;
    this.initializeWorker = options.initializeWorker;
    this.config = options.config;

    // Mask state
    this.currentMaskData = null;
    this.originalMaskData = null;
    this.maskDims = null;
    this.voxelSize = null;

    // Magnitude state
    this.magnitudeData = null;
    this.magnitudeMax = 0;
    this.magnitudeFileBytes = null;
    this.magnitudeVolume = null;
    this.preparedMagnitudeData = null;
    this.preparedMagnitudeMax = 0;

    // Threshold state
    this.maskThreshold = this.config?.MASK_CONFIG?.defaultThreshold || 75;
    this.maskUpdating = false;

    // Drawing state
    this.drawingEnabled = false;
    this.brushMode = 'add';
    this.brushSize = this.config?.MASK_CONFIG?.defaultBrushSize || 3;
    this.savedCrosshairWidth = this.config?.VIEWER_CONFIG?.crosshairWidth || 1;
  }

  // ==================== State Accessors ====================

  hasMask() {
    return this.currentMaskData !== null;
  }

  hasPreparedMagnitude() {
    return this.preparedMagnitudeData !== null;
  }

  getMaskDims() {
    return this.maskDims;
  }

  getVoxelSize() {
    return this.voxelSize;
  }

  getMaskThreshold() {
    return this.maskThreshold;
  }

  setMaskThreshold(value) {
    this.maskThreshold = value;
  }

  // ==================== Mask Preparation ====================

  /**
   * Prepare mask input by combining echoes and/or applying bias correction
   * @param {Object} options
   * @param {Array} options.magnitudeFiles - Array of magnitude file objects
   * @param {Object} options.maskPrepSettings - Preparation settings
   * @param {Function} options.onComplete - Callback when preparation is complete
   */
  async prepareMaskInput(options) {
    const { magnitudeFiles, phaseFiles, echoTimes, maskPrepSettings, onComplete } = options;

    if (maskPrepSettings.source === 'phase_quality') {
      if (!phaseFiles || phaseFiles.length === 0 || !phaseFiles[0]?.file) {
        this.updateOutput("No phase files uploaded - required for phase quality map");
        return;
      }
    } else if (magnitudeFiles.length === 0) {
      this.updateOutput("No magnitude files uploaded");
      return;
    }

    const btn = document.getElementById('prepareMaskInput');
    const originalBtnHtml = btn?.innerHTML;

    if (btn) {
      btn.disabled = true;
      btn.innerHTML = '<span class="spinner"></span> Preparing...';
    }

    try {
      // Debug: show current settings
      console.log('Prepare settings:', maskPrepSettings);
      this.setProgress(0.05, 'Preparing...');
      const sourceLabel = maskPrepSettings.source === 'phase_quality' ? 'phase quality' : maskPrepSettings.source.replace('_', ' ');
      this.updateOutput(`Preparing mask input (${sourceLabel}${maskPrepSettings.biasCorrection ? ' + bias correction' : ''})`);

      let magnitudeData;
      let headerSourceFile;

      if (maskPrepSettings.source === 'phase_quality') {
        // Compute ROMEO voxel quality map from phase data
        this.setProgress(0.15, 'Computing phase quality map...');
        this.updateOutput("Computing ROMEO voxel quality map...");
        magnitudeData = await this.computeVoxelQualityMap(phaseFiles, magnitudeFiles, echoTimes);
        headerSourceFile = phaseFiles[0].file;
      } else if (maskPrepSettings.source === 'combined') {
        // Combine all echoes with RSS (reads files directly, no display)
        this.setProgress(0.15, 'Combining echoes...');
        this.updateOutput("Combining magnitude echoes (RSS)...");
        magnitudeData = await this.combineMagnitudeRSS(magnitudeFiles);
        headerSourceFile = magnitudeFiles[0].file;
      } else if (maskPrepSettings.source === 'last_echo') {
        // Read last echo only (no display)
        this.setProgress(0.15, 'Loading last echo...');
        this.updateOutput("Loading last echo magnitude...");
        const lastFile = magnitudeFiles[magnitudeFiles.length - 1].file;
        magnitudeData = await this.readNiftiData(lastFile);
        headerSourceFile = lastFile;
      } else {
        // Read first echo only (no display)
        this.setProgress(0.15, 'Loading first echo...');
        this.updateOutput("Loading first echo magnitude...");
        const firstFile = magnitudeFiles[0].file;
        magnitudeData = await this.readNiftiData(firstFile);
        headerSourceFile = firstFile;
      }

      // Get header from source file (no display)
      this.setProgress(0.35, 'Reading header...');
      this.magnitudeFileBytes = await this.readNiftiHeader(headerSourceFile);

      // Apply bias correction if enabled (not applicable for phase quality)
      if (maskPrepSettings.biasCorrection && maskPrepSettings.source !== 'phase_quality') {
        this.setProgress(0.45, 'Bias correction...');
        this.updateOutput("Applying bias correction...");
        const beforeSum = magnitudeData.reduce((a, b) => a + b, 0);
        magnitudeData = await this.applyBiasCorrection(magnitudeData);
        const afterSum = magnitudeData.reduce((a, b) => a + b, 0);
        console.log(`Bias correction: before sum=${beforeSum.toExponential(3)}, after sum=${afterSum.toExponential(3)}`);
        this.updateOutput(`Bias correction applied (sum changed: ${(beforeSum !== afterSum)})`);
      }

      // Cache the prepared data
      this.setProgress(0.7, 'Caching data...');
      this.preparedMagnitudeData = magnitudeData;
      this.magnitudeData = magnitudeData;

      // Calculate max
      let max = -Infinity;
      for (let i = 0; i < magnitudeData.length; i++) {
        if (magnitudeData[i] > max) max = magnitudeData[i];
      }
      this.preparedMagnitudeMax = max;
      this.magnitudeMax = max;

      // Display the prepared magnitude as the base volume (no mask yet)
      this.setProgress(0.85, 'Displaying...');
      await this.displayPreparedMagnitude();

      // Set threshold to Otsu-detected value by default
      this.setProgress(0.95, 'Auto-detecting threshold...');
      const otsuResult = this.computeOtsuThreshold();

      this.setProgress(1.0, 'Prepare Complete');
      this.updateOutput("Magnitude prepared");

      // Call completion callback
      if (onComplete) {
        onComplete({ otsuResult });
      }

    } catch (error) {
      this.setProgress(0, 'Prepare Failed');
      this.updateOutput(`Error: ${error.message}`);
      console.error(error);
    } finally {
      if (btn) {
        btn.disabled = false;
        btn.innerHTML = originalBtnHtml || 'Prepare';
      }
    }
  }

  /**
   * Display the prepared magnitude data as the base volume
   */
  async displayPreparedMagnitude() {
    if (!this.preparedMagnitudeData || !this.magnitudeFileBytes) return;

    // Create NIfTI from prepared data (similar to createMaskNifti but with float64 data)
    const srcView = new DataView(this.magnitudeFileBytes);
    const voxOffset = srcView.getFloat32(108, true);
    const headerSize = Math.ceil(voxOffset);

    // Create buffer: header + data as float64
    const dataSize = this.preparedMagnitudeData.length * 8; // 8 bytes per float64
    const buffer = new ArrayBuffer(headerSize + dataSize);
    const destBytes = new Uint8Array(buffer);
    const destView = new DataView(buffer);

    // Copy header
    destBytes.set(new Uint8Array(this.magnitudeFileBytes).slice(0, headerSize));

    // Update datatype to FLOAT64 (64) at offset 70
    destView.setInt16(70, 64, true);
    // Update bitpix to 64 at offset 72
    destView.setInt16(72, 64, true);

    // Make it 3D
    destView.setInt16(40, 3, true);
    destView.setInt16(48, 1, true);

    // Copy data
    const dataView = new Float64Array(buffer, headerSize);
    dataView.set(this.preparedMagnitudeData);

    // Load into NiiVue
    const blob = new Blob([buffer], { type: 'application/octet-stream' });
    const url = URL.createObjectURL(blob);

    await this.nv.loadVolumes([{ url: url, name: 'prepared_magnitude.nii' }]);
    URL.revokeObjectURL(url);

    // Store reference to the volume for header info
    this.magnitudeVolume = this.nv.volumes[0];

    // Enable download button
    this.updateDownloadVolumeButton();
  }

  // ==================== File I/O ====================

  /**
   * Read NIfTI header from a file without displaying it
   * @param {File} file - The NIfTI file to read
   * @returns {Promise<ArrayBuffer>} Header buffer (352 bytes)
   */
  async readNiftiHeader(file) {
    // Read file as ArrayBuffer
    const arrayBuffer = await file.arrayBuffer();
    let data = new Uint8Array(arrayBuffer);

    // Check if gzipped (magic bytes 0x1f, 0x8b)
    if (data[0] === 0x1f && data[1] === 0x8b) {
      // Use fflate for decompression (bundled in niivue)
      const fflate = await import('../../niivue/index.js').then(m => m.fflate || window.fflate);
      if (fflate && fflate.gunzipSync) {
        data = fflate.gunzipSync(data);
      } else {
        // Fallback: load into NiiVue and extract header
        const url = URL.createObjectURL(file);
        await this.nv.loadVolumes([{ url, name: file.name }]);
        URL.revokeObjectURL(url);
        return createNiftiHeaderFromVolume(this.nv.volumes[0]);
      }
    }

    // Return the first 352 bytes (NIfTI-1 header)
    return data.slice(0, 352).buffer;
  }

  /**
   * Read NIfTI image data from a file without displaying it
   * @param {File} file - The NIfTI file to read
   * @returns {Promise<Float64Array>} Image data as Float64Array
   */
  async readNiftiData(file) {
    // Read file as ArrayBuffer
    const arrayBuffer = await file.arrayBuffer();
    let data = new Uint8Array(arrayBuffer);

    // Check if gzipped (magic bytes 0x1f, 0x8b)
    if (data[0] === 0x1f && data[1] === 0x8b) {
      // Use fflate for decompression (bundled in niivue)
      const fflate = await import('../../niivue/index.js').then(m => m.fflate || window.fflate);
      if (fflate && fflate.gunzipSync) {
        data = fflate.gunzipSync(data);
      } else {
        // Fallback: use NiiVue's decompression
        const blob = new Blob([data]);
        const url = URL.createObjectURL(blob);
        await this.nv.loadVolumes([{ url, name: file.name }]);
        URL.revokeObjectURL(url);
        return new Float64Array(this.nv.volumes[0].img);
      }
    }

    // Parse NIfTI header
    const view = new DataView(data.buffer, data.byteOffset, data.byteLength);

    // Check magic number at offset 344 for NIfTI-1
    const magic = String.fromCharCode(data[344], data[345], data[346]);
    const isNifti1 = (magic === 'n+1' || magic === 'ni1');

    if (!isNifti1) {
      throw new Error('Not a valid NIfTI-1 file');
    }

    // Get dimensions from header
    const dims = [];
    for (let i = 0; i < 8; i++) {
      dims.push(view.getInt16(40 + i * 2, true));
    }
    const nTotal = dims[1] * dims[2] * dims[3];

    // Get datatype and vox_offset
    const datatype = view.getInt16(70, true);
    const voxOffset = view.getFloat32(108, true);

    // Get scaling factors
    const sclSlope = view.getFloat32(112, true) || 1;
    const sclInter = view.getFloat32(116, true) || 0;

    // Read image data starting at vox_offset
    const dataStart = Math.ceil(voxOffset);
    const result = new Float64Array(nTotal);

    // Parse based on datatype
    switch (datatype) {
      case 2: // UINT8
        for (let i = 0; i < nTotal; i++) {
          result[i] = data[dataStart + i] * sclSlope + sclInter;
        }
        break;
      case 4: // INT16
        for (let i = 0; i < nTotal; i++) {
          result[i] = view.getInt16(dataStart + i * 2, true) * sclSlope + sclInter;
        }
        break;
      case 8: // INT32
        for (let i = 0; i < nTotal; i++) {
          result[i] = view.getInt32(dataStart + i * 4, true) * sclSlope + sclInter;
        }
        break;
      case 16: // FLOAT32
        for (let i = 0; i < nTotal; i++) {
          result[i] = view.getFloat32(dataStart + i * 4, true) * sclSlope + sclInter;
        }
        break;
      case 64: // FLOAT64
        for (let i = 0; i < nTotal; i++) {
          result[i] = view.getFloat64(dataStart + i * 8, true) * sclSlope + sclInter;
        }
        break;
      case 512: // UINT16
        for (let i = 0; i < nTotal; i++) {
          result[i] = view.getUint16(dataStart + i * 2, true) * sclSlope + sclInter;
        }
        break;
      default:
        throw new Error(`Unsupported NIfTI datatype: ${datatype}`);
    }

    return result;
  }

  /**
   * Combine multiple magnitude echoes using Root Sum of Squares (RSS)
   * Reads files directly without displaying in NiiVue
   * @param {Array} magnitudeFiles - Array of {file, name} objects
   * @returns {Float64Array} RSS-combined magnitude
   */
  async combineMagnitudeRSS(magnitudeFiles) {
    const nEchoes = magnitudeFiles.length;
    if (nEchoes === 0) throw new Error("No magnitude files");

    // Read first echo to get dimensions and initialize RSS
    const firstFile = magnitudeFiles[0].file;
    const firstData = await this.readNiftiData(firstFile);
    const nTotal = firstData.length;

    if (nEchoes === 1) {
      return firstData;
    }

    // Initialize sum of squares with first echo
    const rssData = new Float64Array(nTotal);
    for (let i = 0; i < nTotal; i++) {
      rssData[i] = firstData[i] * firstData[i];
    }

    // Read and add remaining echoes (no display)
    for (let e = 1; e < nEchoes; e++) {
      this.updateOutput(`Combining echo ${e + 1}/${nEchoes}...`);
      const file = magnitudeFiles[e].file;
      const echoData = await this.readNiftiData(file);
      for (let i = 0; i < nTotal; i++) {
        rssData[i] += echoData[i] * echoData[i];
      }
    }

    // Take square root
    for (let i = 0; i < nTotal; i++) {
      rssData[i] = Math.sqrt(rssData[i]);
    }

    this.updateOutput(`Combined ${nEchoes} echoes with RSS`);
    return rssData;
  }

  /**
   * Apply bias field correction to magnitude data
   * @param {Float64Array} magnitudeData - Input magnitude
   * @returns {Float64Array} Bias-corrected magnitude
   */
  async applyBiasCorrection(magnitudeData) {
    // Ensure worker is ready
    await this.initializeWorker();

    const worker = this.getWorker();

    // Get dimensions from NIfTI header
    const srcView = new DataView(this.magnitudeFileBytes);
    const nx = srcView.getInt16(42, true);
    const ny = srcView.getInt16(44, true);
    const nz = srcView.getInt16(46, true);
    const vx = srcView.getFloat32(80, true) || 1;
    const vy = srcView.getFloat32(84, true) || 1;
    const vz = srcView.getFloat32(88, true) || 1;

    // Call WASM bias correction via worker
    return new Promise((resolve, reject) => {
      const messageHandler = (event) => {
        if (event.data.type === 'biasCorrection') {
          worker.removeEventListener('message', messageHandler);
          if (event.data.error) {
            reject(new Error(event.data.error));
          } else {
            resolve(new Float64Array(event.data.result));
          }
        }
      };

      worker.addEventListener('message', messageHandler);
      worker.postMessage({
        type: 'biasCorrection',
        data: {
          magnitude: magnitudeData,
          nx, ny, nz,
          vx, vy, vz,
          sigma_mm: 7.0,
          nbox: 15
        }
      });
    });
  }

  /**
   * Compute ROMEO voxel quality map from phase data
   * @param {Array} phaseFiles - Phase file objects with .file property
   * @param {Array} magnitudeFiles - Magnitude file objects (optional, for weighting)
   * @param {Array} echoTimes - Echo times in ms
   * @returns {Float64Array} Quality map with values in [0, 100]
   */
  async computeVoxelQualityMap(phaseFiles, magnitudeFiles, echoTimes) {
    await this.initializeWorker();

    const worker = this.getWorker();

    // Read first echo phase
    const phase1 = await this.readNiftiData(phaseFiles[0].file);

    // Read second echo phase if available (for gradient coherence)
    let phase2 = null;
    if (phaseFiles.length > 1 && phaseFiles[1]?.file) {
      phase2 = await this.readNiftiData(phaseFiles[1].file);
    }

    // Read first echo magnitude if available (for magnitude weighting)
    let mag = null;
    if (magnitudeFiles && magnitudeFiles.length > 0 && magnitudeFiles[0]?.file) {
      mag = await this.readNiftiData(magnitudeFiles[0].file);
    }

    // Get dimensions from phase header
    const headerBytes = await this.readNiftiHeader(phaseFiles[0].file);
    const srcView = new DataView(headerBytes);
    const nx = srcView.getInt16(42, true);
    const ny = srcView.getInt16(44, true);
    const nz = srcView.getInt16(46, true);
    const nVoxels = nx * ny * nz;

    // Create all-ones mask (process entire volume)
    const mask = new Uint8Array(nVoxels);
    mask.fill(1);

    // Get echo times
    const te1 = (echoTimes && echoTimes.length > 0) ? echoTimes[0] : 1.0;
    const te2 = (echoTimes && echoTimes.length > 1) ? echoTimes[1] : 1.0;

    this.setProgress(0.25, 'Computing quality map...');

    return new Promise((resolve, reject) => {
      const messageHandler = (event) => {
        if (event.data.type === 'voxelQuality') {
          worker.removeEventListener('message', messageHandler);
          if (event.data.error) {
            reject(new Error(event.data.error));
          } else {
            resolve(new Float64Array(event.data.result));
          }
        }
      };

      worker.addEventListener('message', messageHandler);
      worker.postMessage({
        type: 'voxelQuality',
        data: {
          phase: phase1,
          mag: mag,
          phase2: phase2,
          te1, te2,
          mask: mask,
          nx, ny, nz
        }
      });
    });
  }

  // ==================== Mask Preview ====================

  async previewMask(maskPrepSettings) {
    if (!maskPrepSettings.prepared) {
      this.updateOutput("Please click 'Prepare' first");
      return;
    }

    if (!this.preparedMagnitudeData) {
      this.updateOutput("No prepared magnitude data available");
      return;
    }

    try {
      // Use the prepared data
      this.magnitudeData = this.preparedMagnitudeData;
      this.magnitudeMax = this.preparedMagnitudeMax;

      // Enable threshold slider since user chose threshold-based masking
      this.setThresholdSliderEnabled(true);

      await this.updateMaskPreview();
      this.updateOutput("Adjust threshold slider to refine mask");
    } catch (error) {
      this.updateOutput(`Error: ${error.message}`);
      console.error(error);
    }
  }

  async updateMaskPreview() {
    if (!this.magnitudeData || !this.nv.volumes.length || !this.magnitudeFileBytes) return;
    if (this.maskUpdating) return;  // Prevent concurrent updates

    this.maskUpdating = true;

    try {
      const threshold = (this.maskThreshold / 100) * this.magnitudeMax;
      const totalVoxels = this.magnitudeData.length;

      // Extract dimensions from NIfTI header
      const srcView = new DataView(this.magnitudeFileBytes);
      const nx = srcView.getInt16(42, true);  // dim[1]
      const ny = srcView.getInt16(44, true);  // dim[2]
      const nz = srcView.getInt16(46, true);  // dim[3]
      this.maskDims = [nx, ny, nz];

      // Extract voxel size from NIfTI header (pixdim[1-3] at offsets 80, 84, 88)
      const dx = srcView.getFloat32(80, true) || 1;
      const dy = srcView.getFloat32(84, true) || 1;
      const dz = srcView.getFloat32(88, true) || 1;
      this.voxelSize = [dx, dy, dz];

      // Create mask data from threshold
      const maskData = new Float32Array(totalVoxels);
      for (let i = 0; i < totalVoxels; i++) {
        maskData[i] = this.magnitudeData[i] > threshold ? 1 : 0;
      }

      // Store as both current and original (for reset)
      this.currentMaskData = maskData;
      this.originalMaskData = new Float32Array(maskData);

      // Display the mask
      await this.displayCurrentMask();

      // Show morphological operations panel
      const opsPanel = document.getElementById('maskOperations');
      if (opsPanel) opsPanel.style.display = 'block';

    } catch (error) {
      console.error('Error updating mask preview:', error);
    } finally {
      this.maskUpdating = false;
    }
  }

  async displayCurrentMask() {
    if (!this.currentMaskData) return;

    // Close any existing drawing layer
    if (this.nv.drawBitmap) {
      this.nv.closeDrawing();
    }

    // Remove ALL existing overlays (everything except base volume)
    while (this.nv.volumes.length > 1) {
      await this.nv.removeVolumeByIndex(1);
    }

    // Create mask NIfTI by copying header from original file
    const maskNifti = createMaskNifti(this.currentMaskData, this.magnitudeFileBytes);
    const maskBlob = new Blob([maskNifti], { type: 'application/octet-stream' });
    const maskUrl = URL.createObjectURL(maskBlob);

    // Get current opacity from slider
    const opacitySlider = document.getElementById('overlayOpacity');
    const opacity = opacitySlider ? parseInt(opacitySlider.value) / 100 : 0.5;

    await this.nv.addVolumeFromUrl({
      url: maskUrl,
      name: 'mask_preview.nii',
      colormap: 'red',
      opacity: opacity
    });

    URL.revokeObjectURL(maskUrl);

    // Force overlay display range to [0, 1] for binary mask
    if (this.nv.volumes.length > 1) {
      const overlay = this.nv.volumes[this.nv.volumes.length - 1];
      overlay.cal_min = 0;
      overlay.cal_max = 1;
      this.nv.updateGLVolume();
    }

    // Show overlay opacity control when overlay exists
    this.showOverlayControl(true);
  }

  // ==================== Threshold ====================

  /**
   * Auto-detect optimal threshold using Otsu's method
   * @returns {Object} Result with thresholdPercent and thresholdValue
   */
  computeOtsuThreshold() {
    if (!this.preparedMagnitudeData) {
      this.updateOutput("Please click Prepare first");
      return null;
    }

    this.updateOutput("Computing optimal threshold (Otsu)...");

    const result = computeOtsuThreshold(this.preparedMagnitudeData);

    if (result.error) {
      this.updateOutput(`Cannot compute threshold: ${result.error}`);
      return null;
    }

    const clampedPercent = result.thresholdPercent;

    // Update slider and display
    const slider = document.getElementById('maskThreshold');
    if (slider) {
      slider.value = clampedPercent;
      this.maskThreshold = clampedPercent;
      document.getElementById('thresholdLabel').textContent = `Threshold (${clampedPercent}%)`;
    }

    this.updateOutput(`Otsu threshold: ${clampedPercent}% (${result.thresholdValue.toFixed(1)})`);

    return result;
  }

  /**
   * Update mask preview if conditions are met
   */
  async triggerMaskPreviewIfReady() {
    const thresholdSlider = document.getElementById('maskThreshold');
    if (thresholdSlider && !thresholdSlider.disabled && this.magnitudeData && !this.maskUpdating) {
      await this.updateMaskPreview();
    }
  }

  // ==================== Morphological Operations ====================

  // 3D morphological erosion - delegates to imported module
  erodeMask3D() {
    if (!this.currentMaskData || !this.maskDims) return;
    this.currentMaskData = erodeMask3D(this.currentMaskData, this.maskDims);
  }

  // 3D morphological dilation - delegates to imported module
  dilateMask3D() {
    if (!this.currentMaskData || !this.maskDims) return;
    this.currentMaskData = dilateMask3D(this.currentMaskData, this.maskDims);
  }

  // Fill holes in 3D mask - delegates to imported module
  fillHoles3D() {
    if (!this.currentMaskData || !this.maskDims) return;
    this.currentMaskData = fillHoles3D(this.currentMaskData, this.maskDims);
  }

  // Clear mask completely
  async clearMask() {
    this.currentMaskData = null;
    this.originalMaskData = null;

    // Close any drawing layer
    if (this.nv.drawBitmap) {
      this.nv.closeDrawing();
    }

    // Remove mask overlay (keep only base volume)
    while (this.nv.volumes.length > 1) {
      await this.nv.removeVolumeByIndex(1);
    }

    // Hide overlay control when no overlay
    this.showOverlayControl(false);
  }

  // ==================== Drawing Mode ====================

  // Toggle drawing mode on/off
  async toggleDrawingMode() {
    this.drawingEnabled = !this.drawingEnabled;

    const enableBtn = document.getElementById('enableDrawing');
    const addBtn = document.getElementById('brushAdd');
    const removeBtn = document.getElementById('brushRemove');
    const sizeControl = document.getElementById('brushSizeControl');
    const actionsDiv = document.getElementById('drawingActions');

    if (this.drawingEnabled) {
      // Need mask data and base volume
      if (!this.currentMaskData || this.nv.volumes.length === 0) {
        this.updateOutput("Please preview mask first before drawing");
        this.drawingEnabled = false;
        return;
      }

      // Enable drawing UI
      enableBtn.classList.add('active');
      addBtn.disabled = false;
      removeBtn.disabled = false;
      sizeControl.style.display = 'block';
      actionsDiv.style.display = 'grid';

      // Save current crosshair width and hide it
      this.savedCrosshairWidth = this.nv.opts.crosshairWidth;
      this.nv.opts.crosshairWidth = 0;
      this.nv.drawScene();  // Redraw to hide crosshair

      // Remove mask overlay - we'll use drawing layer instead
      while (this.nv.volumes.length > 1) {
        await this.nv.removeVolumeByIndex(1);
      }

      // Hide overlay control when in drawing mode (no overlay)
      this.showOverlayControl(false);

      // Load mask as drawing via NiiVue's pipeline (handles permRAS correctly)
      const maskNifti = createMaskNifti(this.currentMaskData, this.magnitudeFileBytes);
      const maskBlob = new Blob([maskNifti], { type: 'application/octet-stream' });
      const maskUrl = URL.createObjectURL(maskBlob);
      await this.nv.loadDrawingFromUrl(maskUrl, true);
      URL.revokeObjectURL(maskUrl);

      // Enable drawing mode
      this.nv.setDrawingEnabled(true);
      this.nv.opts.penSize = this.brushSize;
      this.nv.setDrawOpacity(0.5);

      // Set pen value for add mode (1)
      this.nv.setPenValue(1, false);
      this.brushMode = 'add';

      // Update UI to show add mode active
      addBtn.classList.add('active');
      removeBtn.classList.remove('active');

      this.updateOutput("Draw mode: DRAG to add, switch to Remove & drag to erase. Click Apply when done.");
    } else {
      // Disable drawing
      enableBtn.classList.remove('active');
      addBtn.disabled = true;
      removeBtn.disabled = true;
      addBtn.classList.remove('active');
      removeBtn.classList.remove('active');
      sizeControl.style.display = 'none';
      actionsDiv.style.display = 'none';

      // Restore crosshair
      if (this.savedCrosshairWidth !== undefined) {
        this.nv.opts.crosshairWidth = this.savedCrosshairWidth;
      }

      this.nv.setDrawingEnabled(false);
      this.nv.closeDrawing();

      // Redisplay the mask as overlay
      await this.displayCurrentMask();

      this.updateOutput("Drawing mode disabled");
    }
  }

  // Set brush mode (add or remove)
  setBrushMode(mode) {
    this.brushMode = mode;

    const addBtn = document.getElementById('brushAdd');
    const removeBtn = document.getElementById('brushRemove');

    addBtn.classList.toggle('active', mode === 'add');
    removeBtn.classList.toggle('active', mode === 'remove');

    // Pen value: 1 for adding to mask, 0 for erasing from mask
    // NiiVue uses 0 as the erase value
    const penValue = mode === 'add' ? 1 : 0;
    this.nv.setPenValue(penValue, false);

    this.updateOutput(`Brush: ${mode === 'add' ? 'Add (paint)' : 'Remove (erase)'}`);
  }

  // Set brush size
  setBrushSize(size) {
    this.brushSize = size;
    if (this.drawingEnabled) {
      this.nv.setPenValue(this.brushMode === 'add' ? 1 : 0, false);
      this.nv.opts.penSize = this.brushSize;
    }
  }

  // Apply the drawing to the current mask
  async applyDrawingToMask() {
    if (!this.currentMaskData || !this.maskDims) {
      this.updateOutput("No mask data to apply drawing to");
      return;
    }

    try {
      const drawBitmap = this.nv.drawBitmap;

      if (!drawBitmap || drawBitmap.length === 0) {
        this.updateOutput("No drawing to apply");
        return;
      }

      // Copy drawing bitmap back to mask data, accounting for permRAS reorientation
      const totalVoxels = this.currentMaskData.length;
      let maskCount = 0;

      const perm = this.nv.volumes[0].permRAS;
      if (perm[0] === 1 && perm[1] === 2 && perm[2] === 3) {
        // Identity permutation — simple linear copy
        for (let i = 0; i < Math.min(drawBitmap.length, totalVoxels); i++) {
          this.currentMaskData[i] = drawBitmap[i] > 0 ? 1 : 0;
          if (drawBitmap[i] > 0) maskCount++;
        }
      } else {
        // Non-identity permutation — apply inverse transform (from NiiVue saveImage)
        const dims = this.nv.volumes[0].hdr.dims;
        const layout = [0, 0, 0];
        for (let i = 0; i < 3; i++) {
          for (let j = 0; j < 3; j++) {
            if (Math.abs(perm[i]) - 1 !== j) continue;
            layout[j] = i * Math.sign(perm[i]);
          }
        }
        let stride = 1;
        const instride = [1, 1, 1];
        const inflip = [false, false, false];
        for (let i = 0; i < layout.length; i++) {
          for (let j = 0; j < layout.length; j++) {
            const a = Math.abs(layout[j]);
            if (a !== i) continue;
            instride[j] = stride;
            if (layout[j] < 0 || Object.is(layout[j], -0)) inflip[j] = true;
            stride *= dims[j + 1];
          }
        }
        // Build lookup tables for each axis
        const buildLut = (size, flip, st) => {
          const lut = flip
            ? Array.from({ length: size }, (_, i) => size - 1 - i)
            : Array.from({ length: size }, (_, i) => i);
          for (let i = 0; i < size; i++) lut[i] *= st;
          return lut;
        };
        const xlut = buildLut(dims[1], inflip[0], instride[0]);
        const ylut = buildLut(dims[2], inflip[1], instride[1]);
        const zlut = buildLut(dims[3], inflip[2], instride[2]);

        let j = 0;
        for (let z = 0; z < dims[3]; z++) {
          for (let y = 0; y < dims[2]; y++) {
            for (let x = 0; x < dims[1]; x++) {
              const val = drawBitmap[xlut[x] + ylut[y] + zlut[z]] > 0 ? 1 : 0;
              this.currentMaskData[j] = val;
              if (val) maskCount++;
              j++;
            }
          }
        }
      }

      // Exit drawing mode and show the mask as overlay
      this.drawingEnabled = false;

      // Update UI
      document.getElementById('enableDrawing')?.classList.remove('active');
      document.getElementById('brushAdd').disabled = true;
      document.getElementById('brushRemove').disabled = true;
      document.getElementById('brushAdd')?.classList.remove('active');
      document.getElementById('brushRemove')?.classList.remove('active');
      document.getElementById('brushSizeControl').style.display = 'none';
      document.getElementById('drawingActions').style.display = 'none';

      // Restore crosshair
      if (this.savedCrosshairWidth !== undefined) {
        this.nv.opts.crosshairWidth = this.savedCrosshairWidth;
      }

      // Close drawing and display mask as overlay
      this.nv.closeDrawing();
      this.nv.setDrawingEnabled(false);
      await this.displayCurrentMask();

      const coverage = ((maskCount / totalVoxels) * 100).toFixed(1);
      this.updateOutput(`Mask updated: ${maskCount.toLocaleString()} voxels (${coverage}%)`);

      return { maskCount, coverage };
    } catch (error) {
      this.updateOutput(`Error applying drawing: ${error.message}`);
      console.error(error);
    }
  }

  // ==================== BET Integration ====================

  /**
   * Run BET brain extraction
   * @param {Object} options
   * @param {Array} options.magnitudeFiles - Magnitude files
   * @param {Object} options.betSettings - BET settings
   * @param {Function} options.onComplete - Completion callback
   */
  async runBET(options) {
    const { magnitudeFiles, betSettings, onComplete } = options;

    if (magnitudeFiles.length === 0) {
      this.updateOutput("No magnitude files uploaded - please load magnitude data first");
      return;
    }

    // Disable threshold slider since user chose BET-based masking
    this.setThresholdSliderEnabled(false);

    try {
      this.updateOutput("Starting BET brain extraction...");
      this.setProgress(0.05, 'Initializing BET...');

      // Initialize worker if needed (must await to ensure WASM is loaded)
      await this.initializeWorker();

      // Load magnitude into NiiVue to get dimensions (handles gzip decompression)
      if (!this.magnitudeVolume || this.nv.volumes.length === 0) {
        const file = magnitudeFiles[0].file;
        const url = URL.createObjectURL(file);
        await this.nv.loadVolumes([{ url: url, name: file.name }]);
        URL.revokeObjectURL(url);

        if (this.nv.volumes.length > 0) {
          this.magnitudeVolume = this.nv.volumes[0];
          this.magnitudeData = this.magnitudeVolume.img;
          let max = -Infinity;
          for (let i = 0; i < this.magnitudeData.length; i++) {
            if (this.magnitudeData[i] > max) max = this.magnitudeData[i];
          }
          this.magnitudeMax = max;
        }
      }

      // Create header from volume if not already done (handles gzipped files)
      if (!this.magnitudeFileBytes || this.magnitudeFileBytes.byteLength < 348) {
        this.magnitudeFileBytes = createNiftiHeaderFromVolume(this.magnitudeVolume);
      }

      // Extract dimensions from NIfTI header
      const srcView = new DataView(this.magnitudeFileBytes);
      const nx = srcView.getInt16(42, true);
      const ny = srcView.getInt16(44, true);
      const nz = srcView.getInt16(46, true);
      this.maskDims = [nx, ny, nz];

      // Get voxel size
      const dx = srcView.getFloat32(80, true);
      const dy = srcView.getFloat32(84, true);
      const dz = srcView.getFloat32(88, true);
      const voxelSize = [dz || 1, dy || 1, dx || 1]; // z, y, x order for Python

      this.updateOutput(`Image dimensions: ${nx}x${ny}x${nz}, voxel size: ${dx.toFixed(2)}x${dy.toFixed(2)}x${dz.toFixed(2)}mm`);

      // Create full NIfTI buffer with header + data for BET
      // Use prepared data if available, otherwise use raw magnitude data
      const magData = this.preparedMagnitudeData || this.magnitudeData;
      if (!magData) {
        throw new Error("No magnitude data available - run Prepare first");
      }

      // Create NIfTI from prepared/magnitude data (not raw volume)
      const voxOffset = srcView.getFloat32(108, true);
      const headerSize = Math.ceil(voxOffset);

      const dataSize = magData.length * 8; // 8 bytes per float64
      const buffer = new ArrayBuffer(headerSize + dataSize);
      const destBytes = new Uint8Array(buffer);
      const destView = new DataView(buffer);

      // Copy header
      destBytes.set(new Uint8Array(this.magnitudeFileBytes).slice(0, headerSize));

      // Update datatype to FLOAT64 (64) at offset 70
      destView.setInt16(70, 64, true);
      // Update bitpix to 64 at offset 72
      destView.setInt16(72, 64, true);

      // Make it 3D
      destView.setInt16(40, 3, true);
      destView.setInt16(48, 1, true);

      // Copy prepared magnitude data
      const dataView = new Float64Array(buffer, headerSize);
      dataView.set(magData);

      const magnitudeNifti = buffer;

      const worker = this.getWorker();

      // Set up handler for BET messages
      const betHandler = (e) => {
        const { type, ...data } = e.data;

        switch (type) {
          case 'betProgress':
            this.setProgress(data.value, data.text);
            break;
          case 'betLog':
            this.updateOutput(data.message);
            break;
          case 'betComplete':
            worker.removeEventListener('message', betHandler);
            this.handleBETComplete(data, onComplete);
            break;
          case 'betError':
            worker.removeEventListener('message', betHandler);
            this.updateOutput(`BET Error: ${data.message}`);
            this.setProgress(0, 'BET Failed');
            if (onComplete) onComplete({ error: data.message });
            break;
        }
      };
      worker.addEventListener('message', betHandler);

      // Send BET request to worker (pure WASM, no Python code needed)
      worker.postMessage({
        type: 'runBET',
        data: {
          magnitudeBuffer: magnitudeNifti,
          voxelSize: voxelSize,
          fractionalIntensity: betSettings.fractionalIntensity,
          iterations: betSettings.iterations,
          subdivisions: betSettings.subdivisions
        }
      });

    } catch (error) {
      this.updateOutput(`BET Error: ${error.message}`);
      this.setProgress(0, 'Failed');
      if (onComplete) onComplete({ error: error.message });
      console.error(error);
    }
  }

  async handleBETComplete(data, onComplete) {
    try {
      this.updateOutput("BET completed, loading mask...");

      // Convert the mask data to Float32Array
      const maskData = new Float32Array(data.maskData);

      // Store as both current and original mask
      this.currentMaskData = maskData;
      this.originalMaskData = new Float32Array(maskData);

      // Display the mask
      await this.displayCurrentMask();

      // Show morphological operations panel
      const opsPanel = document.getElementById('maskOperations');
      if (opsPanel) opsPanel.style.display = 'block';

      this.setProgress(1.0, 'BET Complete');
      this.updateOutput(`BET brain extraction complete. Coverage: ${data.coverage}`);

      if (onComplete) {
        onComplete({ success: true, coverage: data.coverage });
      }
    } catch (error) {
      this.updateOutput(`Error displaying BET mask: ${error.message}`);
      console.error(error);
      if (onComplete) onComplete({ error: error.message });
    }
  }

  // ==================== Utility Methods ====================

  /**
   * Create mask NIfTI using source header as template
   */
  createMaskNifti(maskData) {
    return createMaskNifti(maskData, this.magnitudeFileBytes);
  }

  /**
   * Get prepared magnitude as array for pipeline
   */
  getPreparedMagnitudeArray() {
    return this.preparedMagnitudeData ? Array.from(this.preparedMagnitudeData) : null;
  }

  /**
   * Update the opacity of all overlay volumes
   */
  updateOverlayOpacity(opacity) {
    if (this.nv.volumes.length <= 1) return;

    // Update all overlays (volumes after the first one)
    for (let i = 1; i < this.nv.volumes.length; i++) {
      this.nv.setOpacity(i, opacity);
    }
    this.nv.updateGLVolume();
  }

  /**
   * Show or hide the overlay opacity control
   */
  showOverlayControl(show) {
    const control = document.getElementById('overlayOpacityControl');
    if (control) {
      control.style.display = show ? 'flex' : 'none';
    }
  }

  /**
   * Update the download volume button state
   */
  updateDownloadVolumeButton() {
    const btn = document.getElementById('downloadCurrentVolume');
    if (btn) {
      btn.disabled = !this.nv.volumes || this.nv.volumes.length === 0;
    }
  }

  /**
   * Enable or disable the threshold slider and auto-threshold button
   */
  setThresholdSliderEnabled(enabled) {
    const thresholdSlider = document.getElementById('maskThreshold');
    if (thresholdSlider) thresholdSlider.disabled = !enabled;

    const autoThresholdBtn = document.getElementById('autoThreshold');
    if (autoThresholdBtn) autoThresholdBtn.disabled = !enabled;
  }

  /**
   * Clear all prepared data (for reset)
   */
  clearPreparedData() {
    this.preparedMagnitudeData = null;
    this.preparedMagnitudeMax = 0;
    this.currentMaskData = null;
    this.originalMaskData = null;
  }
}
