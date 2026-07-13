import { categorizeNeuroFile, filesFromDataTransferItems, isNiftiFile } from './detectFiles.js';
import { DicomController } from './DicomController.js';

const DEFAULT_BUCKETS = ['magnitude', 'phase', 'totalField', 'localField', 'json', 'mask', 'extra'];
const EXCLUSIVE_BUCKETS = ['phase', 'totalField', 'localField'];
const SINGLE_FILE_BUCKETS = ['totalField', 'localField', 'mask'];

export class FileIOController {
  constructor(options = {}) {
    this.mode = options.mode || 'simple';
    this.updateOutput = options.updateOutput || (() => {});
    this.onFileLoaded = options.onFileLoaded || (() => {});
    this.onFilesChanged = options.onFilesChanged || (() => {});
    this.onBucketChanged = options.onBucketChanged || (() => {});
    this.file = null;
    this.buckets = Object.fromEntries((options.buckets || DEFAULT_BUCKETS).map(bucket => [bucket, []]));
    this.dicomController = options.dicomController || new DicomController({
      moduleUrl: options.dcm2niixModuleUrl,
      updateOutput: this.updateOutput,
      onDicomFiles: options.onDicomFiles,
      onConversionComplete: niftiFile => {
        if (this.mode === 'simple') this.setFile(niftiFile);
        else this.addFiles([niftiFile]);
      }
    });
  }

  getActiveFile() {
    return this.file;
  }

  hasValidData() {
    return this.mode === 'simple'
      ? this.file !== null
      : Object.values(this.buckets).some(bucket => bucket.length > 0);
  }

  getInputMode() {
    if (this.buckets.localField?.length) return 'localField';
    if (this.buckets.totalField?.length) return 'totalField';
    return 'raw';
  }

  getBuckets() {
    return this.buckets;
  }

  getBucket(bucket) {
    return this.buckets[bucket] || [];
  }

  async handleFiles(files) {
    const list = Array.from(files || []);
    if (!list.length) return;
    if (this.mode === 'simple') {
      const nifti = list.find(isNiftiFile);
      if (nifti) {
        this.setFile(nifti);
        return;
      }
      await this.dicomController.convertFiles(list);
      return;
    }
    const dicom = list.filter(file => categorizeNeuroFile(file) === 'dicom');
    const nonDicom = list.filter(file => categorizeNeuroFile(file) !== 'dicom');
    if (nonDicom.length) this.addFiles(nonDicom);
    if (dicom.length) await this.dicomController.convertFiles(dicom);
  }

  async handleDropItems(items) {
    const files = await filesFromDataTransferItems(items);
    return this.handleFiles(files);
  }

  setFile(file) {
    this.file = file;
    this.updateOutput(`Loaded: ${file.name}`);
    this.onFileLoaded(file);
    this.onFilesChanged({ mode: this.mode, file });
    return file;
  }

  clearFile() {
    this.file = null;
    this.onFilesChanged({ mode: this.mode, file: null });
  }

  addFiles(files) {
    const added = [];
    for (const file of Array.from(files || [])) {
      const bucket = this.normalizeBucket(categorizeNeuroFile(file));
      const entry = { file, name: file.name };
      this.addEntry(bucket, entry);
      added.push({ bucket, entry });
    }
    this.sortAllBuckets();
    this.fireBucketCallbacks();
    return { added };
  }

  addEntry(bucket, entry) {
    const target = this.normalizeBucket(bucket);
    if (SINGLE_FILE_BUCKETS.includes(target) && this.buckets[target]?.length) {
      this.buckets.extra.push(...this.buckets[target]);
      this.buckets[target] = [];
    }
    this.buckets[target].push(entry);
    this.enforceExclusivity(target);
  }

  moveFile(sourceBucket, index, targetBucket) {
    const source = this.normalizeBucket(sourceBucket);
    const target = this.normalizeBucket(targetBucket);
    const sourceItems = this.buckets[source];
    if (!sourceItems || index < 0 || index >= sourceItems.length) return null;
    const [entry] = sourceItems.splice(index, 1);
    this.addEntry(target, entry);
    this.sortBucket(target);
    this.fireBucketCallbacks();
    return entry;
  }

  reorderFile(bucket, fromIndex, toIndex) {
    const items = this.buckets[this.normalizeBucket(bucket)];
    if (!items || fromIndex < 0 || fromIndex >= items.length) return false;
    const nextIndex = Math.max(0, Math.min(toIndex, items.length - 1));
    if (nextIndex === fromIndex) return false;
    const [entry] = items.splice(fromIndex, 1);
    items.splice(nextIndex, 0, entry);
    this.fireBucketCallbacks();
    return true;
  }

  removeFile(bucket, index) {
    const target = this.normalizeBucket(bucket);
    const items = this.buckets[target];
    if (!items || index < 0 || index >= items.length) return null;
    const [removed] = items.splice(index, 1);
    this.fireBucketCallbacks();
    return removed;
  }

  clearAllFiles() {
    for (const bucket of Object.keys(this.buckets)) this.buckets[bucket] = [];
    this.file = null;
    this.fireBucketCallbacks();
  }

  normalizeBucket(bucket) {
    return this.buckets[bucket] ? bucket : 'extra';
  }

  enforceExclusivity(changedBucket) {
    if (!EXCLUSIVE_BUCKETS.includes(changedBucket)) return;
    for (const bucket of EXCLUSIVE_BUCKETS) {
      if (bucket === changedBucket || !this.buckets[bucket]?.length) continue;
      this.buckets.extra.push(...this.buckets[bucket]);
      this.buckets[bucket] = [];
    }
  }

  sortBucket(bucket) {
    this.buckets[bucket]?.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
  }

  sortAllBuckets() {
    for (const bucket of Object.keys(this.buckets)) this.sortBucket(bucket);
  }

  fireBucketCallbacks() {
    this.onFilesChanged({ mode: this.mode, buckets: this.buckets, inputMode: this.getInputMode() });
    for (const [bucket, entries] of Object.entries(this.buckets)) this.onBucketChanged(bucket, entries);
  }
}
