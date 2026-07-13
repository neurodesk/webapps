/**
 * FileIOController
 *
 * Handles file input management, echo time extraction, and auto-categorization.
 * Uses unified bucket storage with auto-detection and drag-between-bucket support.
 */

export class FileIOController {
  constructor(options) {
    this.updateOutput = options.updateOutput || (() => {});
    this.onFilesChanged = options.onFilesChanged || (() => {});
    this.onMagnitudeFilesChanged = options.onMagnitudeFilesChanged || (() => {});
    this.onPhaseFilesChanged = options.onPhaseFilesChanged || (() => {});

    // Unified bucket storage
    // Each bucket: array of {file: File, name: string, echoTime?: number, echoNumber?: number}
    this.buckets = {
      magnitude: [],    // optional, multi-file (multi-echo)
      phase: [],        // multi-file, mutually exclusive with totalField/localField
      totalField: [],   // single-file, mutually exclusive with phase/localField
      localField: [],   // single-file, mutually exclusive with phase/totalField
      json: [],         // multi-file (BIDS sidecar JSONs)
      extra: []         // uncategorized files
    };

    // Centralized mask file storage (used by all modes, managed in Masking section)
    this.maskFile = [];

    // Combined data cache
    this.combinedMagnitude = null;
    this.combinedPhase = null;

    // Tagify instance for echo times
    this.echoTagify = null;
  }

  // ==================== Input Mode (Derived) ====================

  /**
   * Derive input mode from bucket contents.
   * Returns 'raw', 'totalField', or 'localField'.
   */
  getInputMode() {
    if (this.buckets.localField.length > 0) return 'localField';
    if (this.buckets.totalField.length > 0) return 'totalField';
    return 'raw';
  }

  // setInputMode is intentionally removed — mode is always derived from bucket contents

  // ==================== Auto-Categorization ====================

  /**
   * Determine which bucket a file belongs to based on filename.
   * @param {File} file
   * @returns {string} bucket key
   */
  categorizeFile(file) {
    const name = file.name.toLowerCase();

    // JSON sidecar files
    if (name.endsWith('.json')) return 'json';

    // NIfTI files: apply filename heuristics
    if (name.endsWith('.nii') || name.endsWith('.nii.gz')) {
      if (/phase|_ph[\._]/.test(name)) return 'phase';
      if (/total|b0|fieldmap|field_map/.test(name)) return 'totalField';
      if (/local|chi/.test(name)) return 'localField';
      if (/mag/.test(name)) return 'magnitude';
      return 'extra';
    }

    // Everything else goes to extra
    return 'extra';
  }

  // ==================== File Management ====================

  /**
   * Add files to buckets via auto-categorization.
   * Enforces single-file and mutual exclusivity constraints.
   * @param {File[]} files - Array of File objects
   * @returns {Object} categorization results {added: [{entry, bucket}]}
   */
  addFiles(files) {
    const results = { added: [] };

    for (const file of files) {
      const bucket = this.categorizeFile(file);
      const entry = { file, name: file.name };

      this._addToBucket(bucket, entry);
      results.added.push({ entry, bucket });
    }

    // Sort all buckets alphabetically
    this._sortAllBuckets();

    // Fire callbacks
    this._fireCallbacks();

    return results;
  }

  /**
   * Add a pre-categorized entry to a specific bucket.
   * @param {string} bucket - Target bucket key
   * @param {Object} entry - {file, name, echoTime?, echoNumber?}
   */
  _addToBucket(bucket, entry) {
    // Enforce single-file for totalField/localField
    if (bucket === 'totalField' || bucket === 'localField') {
      if (this.buckets[bucket].length > 0) {
        this.buckets.extra.push(...this.buckets[bucket]);
        this.buckets[bucket] = [];
      }
    }

    this.buckets[bucket].push(entry);

    // Enforce mutual exclusivity among primary buckets
    this._enforceExclusivity(bucket);
  }

  /**
   * Sort a bucket's contents alphabetically by filename.
   */
  _sortBucket(bucket) {
    if (!this.buckets[bucket] || this.buckets[bucket].length <= 1) return;
    this.buckets[bucket].sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
  }

  /**
   * Sort all buckets alphabetically.
   */
  _sortAllBuckets() {
    for (const key of Object.keys(this.buckets)) {
      this._sortBucket(key);
    }
  }

  /**
   * Reorder a file within the same bucket (drag to new position).
   * @param {string} bucket - Bucket key
   * @param {number} fromIndex - Current index
   * @param {number} toIndex - Target index
   */
  reorderFile(bucket, fromIndex, toIndex) {
    const arr = this.buckets[bucket];
    if (!arr || fromIndex < 0 || fromIndex >= arr.length) return;
    toIndex = Math.max(0, Math.min(toIndex, arr.length - 1));
    if (fromIndex === toIndex) return;

    const [item] = arr.splice(fromIndex, 1);
    arr.splice(toIndex, 0, item);

    // Clear combined data cache
    this.combinedMagnitude = null;
    this.combinedPhase = null;

    this._fireCallbacks();
  }

  /**
   * Enforce mutual exclusivity: phase, totalField, localField are exclusive.
   * When one receives files, the others are moved to extra.
   */
  _enforceExclusivity(justAddedTo) {
    const exclusiveGroup = ['phase', 'totalField', 'localField'];
    if (!exclusiveGroup.includes(justAddedTo)) return;

    for (const bucket of exclusiveGroup) {
      if (bucket !== justAddedTo && this.buckets[bucket].length > 0) {
        this.buckets.extra.push(...this.buckets[bucket]);
        this.buckets[bucket] = [];
      }
    }
  }

  /**
   * Move a file from one bucket to another.
   * Enforces constraints and fires callbacks.
   */
  moveFile(sourceBucket, index, targetBucket) {
    if (!this.buckets[sourceBucket] || index < 0 || index >= this.buckets[sourceBucket].length) return;

    const [item] = this.buckets[sourceBucket].splice(index, 1);

    // Enforce single-file for totalField/localField
    if (targetBucket === 'totalField' || targetBucket === 'localField') {
      if (this.buckets[targetBucket].length > 0) {
        this.buckets.extra.push(...this.buckets[targetBucket]);
        this.buckets[targetBucket] = [];
      }
    }

    this.buckets[targetBucket].push(item);

    // Enforce mutual exclusivity
    this._enforceExclusivity(targetBucket);

    // Sort the target bucket alphabetically
    this._sortBucket(targetBucket);

    // Clear combined data cache (files changed)
    this.combinedMagnitude = null;
    this.combinedPhase = null;

    // Fire callbacks
    this._fireCallbacks();
  }

  /**
   * Remove a file from a bucket by index.
   */
  removeFile(bucket, index) {
    if (bucket === 'mask') {
      this.maskFile.splice(index, 1);
      this.updateFileList('mask', this.maskFile);
      this.onFilesChanged('mask', []);
      return;
    }

    if (!this.buckets[bucket] || index < 0 || index >= this.buckets[bucket].length) return;
    this.buckets[bucket].splice(index, 1);

    // Clear combined data cache
    this.combinedMagnitude = null;
    this.combinedPhase = null;

    this._fireCallbacks();
  }

  /**
   * Clear all files from all buckets.
   */
  clearAllFiles() {
    for (const key of Object.keys(this.buckets)) {
      this.buckets[key] = [];
    }
    this.combinedMagnitude = null;
    this.combinedPhase = null;
    this.maskFile = [];
    this.updateFileList('mask', []);
    this._fireCallbacks();
  }

  /**
   * Fire all file-change callbacks.
   */
  _fireCallbacks() {
    this.onMagnitudeFilesChanged(this.buckets.magnitude);
    this.onPhaseFilesChanged(this.buckets.phase);
    this.onFilesChanged('buckets', null);
  }

  // ==================== State Accessors ====================

  getMagnitudeFiles() {
    return this.buckets.magnitude;
  }

  getPhaseFiles() {
    return this.buckets.phase;
  }

  getJsonFiles() {
    return this.buckets.json;
  }

  getEchoCount() {
    return Math.max(this.buckets.magnitude.length, this.buckets.phase.length);
  }

  /**
   * Check if we have valid data for the current (derived) input mode.
   */
  hasValidData() {
    const mode = this.getInputMode();
    switch (mode) {
      case 'raw': {
        const magCount = this.buckets.magnitude.length;
        const phaseCount = this.buckets.phase.length;
        return magCount === phaseCount && magCount > 0;
      }
      case 'totalField':
        return this.buckets.totalField.length > 0;
      case 'localField':
        return this.buckets.localField.length > 0;
      default:
        return false;
    }
  }

  hasEchoTimes() {
    return this.getEchoTimesFromInputs().length > 0;
  }

  getMultiEchoFiles() {
    return {
      magnitude: this.buckets.magnitude,
      phase: this.buckets.phase,
      json: this.buckets.json,
      combinedMagnitude: this.combinedMagnitude,
      combinedPhase: this.combinedPhase
    };
  }

  // Field map mode accessors (unified — magnitude bucket serves all modes)

  getTotalFieldFile() {
    return this.buckets.totalField[0]?.file || null;
  }

  getLocalFieldFile() {
    return this.buckets.localField[0]?.file || null;
  }

  getFieldMapMagnitudeFile() {
    return this.buckets.magnitude[0]?.file || null;
  }

  getFieldMapMagnitudeFiles() {
    return this.buckets.magnitude;
  }

  getFieldMapMagnitudeCount() {
    return this.buckets.magnitude.length;
  }

  hasFieldMapMagnitude() {
    return this.buckets.magnitude.length > 0;
  }

  // Mask accessors (unchanged — mask is managed in Masking section)

  getMaskFile() {
    return this.maskFile[0]?.file || null;
  }

  hasMask() {
    return this.getMaskFile() !== null;
  }

  getFieldMapUnits() {
    const select = document.getElementById('fieldMapUnits');
    return select ? select.value : 'hz';
  }

  getFieldStrength() {
    const fieldInput = document.getElementById('magField');
    return fieldInput ? parseFloat(fieldInput.value) : null;
  }

  // ==================== Mask File Handling ====================

  /**
   * Handle mask file input (kept separate from unified buckets).
   */
  async handleMaskInput(event) {
    const files = Array.from(event.target.files);
    this.maskFile = files.slice(0, 1).map(file => ({
      file: file,
      name: file.name
    }));
    this.updateFileList('mask', this.maskFile);
    this.onFilesChanged('mask', files);
  }

  // ==================== File List UI (mask only) ====================

  updateFileList(type, fileList) {
    const listElement = document.getElementById(`${type}List`);
    const fileDrop = listElement?.closest('.upload-group')?.querySelector('.file-drop');

    if (!listElement) return;

    listElement.innerHTML = '';

    if (fileList.length > 0) {
      fileDrop?.classList.add('has-files');
      fileList.forEach((fileData, index) => {
        const fileItem = document.createElement('div');
        fileItem.className = 'file-item';
        fileItem.innerHTML = `
          <span>${fileData.name}</span>
          <button class="file-remove" onclick="app.removeFile('${type}', ${index})">×</button>
        `;
        listElement.appendChild(fileItem);
      });

      const label = fileDrop?.querySelector('.file-drop-label span');
      if (label) {
        label.textContent = `${fileList.length} file${fileList.length > 1 ? 's' : ''} selected`;
      }
    } else {
      fileDrop?.classList.remove('has-files');
      const label = fileDrop?.querySelector('.file-drop-label span');
      if (label) {
        label.textContent = 'Drop or click';
      }
    }
  }

  // ==================== JSON Processing ====================

  async processJsonFiles(files) {
    const echoTimes = [];
    let fieldStrength = null;

    for (const file of files) {
      try {
        const f = file instanceof File ? file : file.file || file;
        const text = await f.text();
        const json = JSON.parse(text);

        // Extract echo time (in seconds, convert to ms)
        let echoTime = null;
        if (json.EchoTime) {
          echoTime = json.EchoTime * 1000;
        } else if (json.echo_time) {
          echoTime = json.echo_time * 1000;
        } else if (json.TE) {
          echoTime = json.TE;
        }

        // Extract field strength (in Tesla)
        if (fieldStrength === null) {
          if (json.MagneticFieldStrength) {
            fieldStrength = json.MagneticFieldStrength;
          } else if (json.FieldStrength) {
            fieldStrength = json.FieldStrength;
          } else if (json.field_strength) {
            fieldStrength = json.field_strength;
          }
        }

        if (echoTime !== null) {
          echoTimes.push({
            file: f.name || file.name,
            echoTime: echoTime,
            json: json
          });
        }
      } catch (error) {
        console.error(`Error parsing JSON file ${file.name}:`, error);
      }
    }

    // Sort by echo time and populate inputs
    echoTimes.sort((a, b) => a.echoTime - b.echoTime);
    this.populateEchoTimeInputs(echoTimes.map(et => et.echoTime));

    // Populate field strength if found
    if (fieldStrength !== null) {
      const fieldInput = document.getElementById('magField');
      if (fieldInput) {
        fieldInput.value = fieldStrength;
        this.updateOutput(`Field strength: ${fieldStrength}T`);
      }
    }
  }

  // ==================== Echo Time Management ====================

  setupEchoTagify() {
    const input = document.getElementById('echoTimesTagify');
    if (!input || this.echoTagify) return;

    this.echoTagify = new Tagify(input, {
      delimiters: ',| ',
      pattern: /^[\d.]+$/,
      transformTag: (tagData) => {
        const num = parseFloat(tagData.value);
        if (!isNaN(num) && num > 0) {
          tagData.value = num.toFixed(2);
        }
      },
      validate: (tagData) => {
        const num = parseFloat(tagData.value);
        return !isNaN(num) && num > 0;
      },
      editTags: 1,
      placeholder: 'Type values...'
    });

    this.echoTagify.on('change', () => this.onFilesChanged('echoTimes', null));
  }

  populateEchoTimeInputs(echoTimes) {
    if (!this.echoTagify) return;

    const tags = echoTimes.map(t => ({ value: t.toFixed(2) }));
    this.echoTagify.removeAllTags();
    this.echoTagify.addTags(tags);
  }

  getEchoTimesFromInputs() {
    if (!this.echoTagify) return [];

    return this.echoTagify.value
      .map(tag => parseFloat(tag.value))
      .filter(n => !isNaN(n) && n > 0)
      .sort((a, b) => a - b);
  }

  // ==================== DICOM Integration ====================

  /**
   * Set files programmatically from DICOM conversion results.
   * Adds to unified buckets and triggers callbacks.
   */
  setFilesFromDicom(magnitudeFileData, phaseFileData, jsonFiles) {
    // Add DICOM results directly to buckets
    this.buckets.magnitude.push(...magnitudeFileData);
    this.buckets.phase.push(...phaseFileData);

    // DICOM always produces phase data, enforce exclusivity
    this._enforceExclusivity('phase');

    // Sort buckets alphabetically
    this._sortBucket('magnitude');
    this._sortBucket('phase');

    // Clear combined data cache
    this.combinedMagnitude = null;
    this.combinedPhase = null;

    this.onMagnitudeFilesChanged(this.buckets.magnitude);
    this.onPhaseFilesChanged(this.buckets.phase);

    if (jsonFiles && jsonFiles.length > 0) {
      // Add JSON files to bucket
      for (const f of jsonFiles) {
        this.buckets.json.push({ file: f, name: f.name });
      }
      this._sortBucket('json');
      this.processJsonFiles(jsonFiles);
    }
  }

  // ==================== Combined Data ====================

  setCombinedMagnitude(data) {
    this.combinedMagnitude = data;
  }

  setCombinedPhase(data) {
    this.combinedPhase = data;
  }

  getCombinedMagnitude() {
    return this.combinedMagnitude;
  }

  getCombinedPhase() {
    return this.combinedPhase;
  }
}
