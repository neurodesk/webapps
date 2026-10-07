/**
 * DicomController - Handles DICOM to NIfTI conversion and classification.
 *
 * Conversion plumbing (dcm2niix WASM instance, drop-tree traversal) comes from
 * the shared @neurodesk/webapp-components controller; the QSM-specific batch
 * classification (magnitude/phase/extras triage, echo times, field strength)
 * stays local because the shared controller only selects a single NIfTI.
 *
 * This controller is stateless with respect to classification results — each
 * conversion produces a batch result that is passed to the onConversionComplete
 * callback. Accumulation across batches is handled by the consumer (QSMApp._triageState).
 */
import { DicomController as SharedDicomController, classifyImageComponent } from '@neurodesk/webapp-components/file-io';

export class QsmDicomInput extends SharedDicomController {
  constructor(options = {}) {
    super({
      ...options,
      moduleUrl: new URL('../../dcm2niix/index.js', import.meta.url).href,
      onDicomFiles: options.onDicomFiles || options.onFilesRetained,
      throwOnError: false,
    });
  }

  /**
   * Convert DICOM files (file input or drop traversal via the shared
   * convertDropItems). Overrides the shared flow to classify the whole batch
   * instead of selecting a single NIfTI.
   */
  async convertFiles(files) {
    if (!files || files.length === 0) return;

    this.converting = true;
    this.updateOutput(`Converting ${files.length} DICOM files...`);

    // Retain original files for dicompare validation (not awaited: runs alongside conversion)
    if (this.onDicomFiles) this.onDicomFiles(files);

    try {
      const dcm2niix = await this._createInstance();
      const result = await dcm2niix.input(files).run();
      await this._processResults(result);
    } catch (error) {
      console.error('DICOM conversion error:', error);
      this.updateOutput(`DICOM conversion failed: ${error.message}`);
    } finally {
      this.converting = false;
    }
  }

  async convertDropItems(items) {
    if (items?.length) this.updateOutput('Reading dropped files...');
    return super.convertDropItems(items);
  }

  /**
   * Process dcm2niix output: separate NIfTI and JSON files, then classify.
   */
  async _processResults(resultFiles) {
    const niftiFiles = resultFiles.filter(f =>
      f.name.endsWith('.nii') || f.name.endsWith('.nii.gz')
    );
    const jsonFiles = resultFiles.filter(f => f.name.endsWith('.json'));

    if (niftiFiles.length === 0) {
      this.updateOutput('No NIfTI files produced. Are these valid DICOM files?');
      return;
    }

    const batch = await this._classifyBatch(niftiFiles, jsonFiles);
    this.onConversionComplete(batch);
  }

  /**
   * Classify a batch of NIfTI files as magnitude, phase, or extras.
   * Returns only this batch's results (no internal accumulation).
   *
   * Strategy:
   * 1. Primary: Use component metadata, including Bruker enhanced multi-echo metadata
   * 2. Fallback: Check filename for "_ph" suffix (dcm2niix convention)
   * 3. Default: Assume magnitude
   */
  async _classifyBatch(niftiFiles, jsonFiles) {
    // Parse all JSON sidecars first
    const jsonMap = new Map();
    for (const jsonFile of jsonFiles) {
      try {
        const text = await jsonFile.text();
        const json = JSON.parse(text);
        jsonMap.set(jsonFile.name, { file: jsonFile, data: json });
      } catch (error) {
        console.error(`Error parsing JSON sidecar ${jsonFile.name}:`, error);
      }
    }

    const magnitude = [];
    const phase = [];
    const extras = [];
    const batchJsonFiles = [];
    let fieldStrength = null;

    for (const niftiFile of niftiFiles) {
      // Find matching JSON sidecar by basename
      const baseName = niftiFile.name.replace(/\.nii(\.gz)?$/, '');
      const jsonEntry = jsonMap.get(baseName + '.json');

      let echoTime = null;
      let echoNumber = null;

      if (jsonEntry) {
        const json = jsonEntry.data;

        // Extract echo info
        if (json.EchoTime != null) {
          echoTime = json.EchoTime * 1000; // seconds → ms
        }
        if (json.EchoNumber != null) {
          echoNumber = json.EchoNumber;
        }

        // Extract field strength (only need it once)
        if (fieldStrength == null) {
          fieldStrength = json.MagneticFieldStrength
            || json.FieldStrength
            || json.field_strength
            || null;
        }

        batchJsonFiles.push(jsonEntry.file);
      }
      const detected = classifyImageComponent(niftiFile.name, jsonEntry?.data);
      const category = detected === 'extra' ? 'extras' : (detected || 'magnitude');

      const entry = {
        file: niftiFile,
        name: niftiFile.name,
        echoTime,
        echoNumber
      };

      if (category === 'phase') {
        phase.push(entry);
      } else if (category === 'extras') {
        extras.push(entry);
      } else {
        magnitude.push(entry);
      }
    }

    // Sort by echo time (or echo number as tiebreaker)
    const sortByEcho = (a, b) => {
      if (a.echoTime != null && b.echoTime != null) {
        return a.echoTime - b.echoTime;
      }
      if (a.echoNumber != null && b.echoNumber != null) {
        return a.echoNumber - b.echoNumber;
      }
      return 0;
    };
    magnitude.sort(sortByEcho);
    phase.sort(sortByEcho);

    // Collect echo times from this batch
    const echoTimeSet = new Set();
    for (const entry of [...magnitude, ...phase]) {
      if (entry.echoTime != null) echoTimeSet.add(entry.echoTime);
    }
    const echoTimes = [...echoTimeSet].sort((a, b) => a - b);

    const magCount = magnitude.length;
    const phaseCount = phase.length;
    const extrasCount = extras.length;
    let msg = `Found ${magCount} magnitude and ${phaseCount} phase image${magCount + phaseCount !== 1 ? 's' : ''}`;
    if (extrasCount > 0) {
      msg += ` (${extrasCount} other)`;
    }
    this.updateOutput(msg);

    return {
      magnitude,
      phase,
      extras,
      jsonFiles: batchJsonFiles,
      fieldStrength,
      echoTimes
    };
  }
}
