/**
 * Manages a collection of file handles without loading content into memory.
 * Provides batching by size/count for memory-efficient processing.
 */

import {
  iterateDirectoryFiles,
  getFileSize,
  isDicomFile,
  isZipFile,
  FileHandleWithPath,
} from './fileSystemAccessUtils';

export interface ManagedFileHandle {
  handle: FileSystemFileHandle;
  path: string;
  name: string;
  size: number;
  fileType: 'dicom' | 'zip' | 'protocol' | 'unknown';
}

export interface BatchConfig {
  maxBatchSizeBytes: number;
  maxBatchFileCount: number;
}

export const DEFAULT_BATCH_CONFIG: BatchConfig = {
  maxBatchSizeBytes: 800 * 1024 * 1024, // 800MB per batch
  maxBatchFileCount: 5000, // Max 5000 files per batch
};

// Threshold below which we skip batching entirely
export const NO_BATCH_THRESHOLD_BYTES = 1.5 * 1024 * 1024 * 1024; // 1.5GB

export class FileHandleManager {
  private handles: ManagedFileHandle[] = [];
  private _totalSize: number = 0;

  /**
   * Add files from a directory handle.
   * Scans the directory recursively and stores handles with metadata.
   *
   * @param dirHandle - The directory handle to scan
   * @param onProgress - Optional callback for scan progress
   */
  async addFromDirectory(
    dirHandle: FileSystemDirectoryHandle,
    onProgress?: (scanned: number, path: string) => void
  ): Promise<void> {
    let scanned = 0;

    for await (const fileWithPath of iterateDirectoryFiles(dirHandle)) {
      // Skip non-DICOM files (but allow ZIPs)
      if (!isDicomFile(fileWithPath.name) && !isZipFile(fileWithPath.name)) {
        continue;
      }

      try {
        const size = await getFileSize(fileWithPath.handle);

        // Skip empty files
        if (size === 0) {
          continue;
        }

        this.handles.push({
          handle: fileWithPath.handle,
          path: fileWithPath.path,
          name: fileWithPath.name,
          size,
          fileType: this.detectFileType(fileWithPath.name),
        });

        this._totalSize += size;
        scanned++;
        onProgress?.(scanned, fileWithPath.path);
      } catch (error) {
        console.warn(`Failed to get size for ${fileWithPath.path}:`, error);
      }
    }
  }

  /**
   * Add files from an array of file handles (from showOpenFilePicker).
   */
  async addFromHandles(fileHandles: FileSystemFileHandle[]): Promise<void> {
    for (const handle of fileHandles) {
      const name = handle.name;

      // Skip non-DICOM files (but allow ZIPs)
      if (!isDicomFile(name) && !isZipFile(name)) {
        continue;
      }

      try {
        const size = await getFileSize(handle);

        // Skip empty files
        if (size === 0) {
          continue;
        }

        this.handles.push({
          handle,
          path: name,
          name,
          size,
          fileType: this.detectFileType(name),
        });

        this._totalSize += size;
      } catch (error) {
        console.warn(`Failed to get size for ${name}:`, error);
      }
    }
  }

  /**
   * Detect file type from filename
   */
  private detectFileType(name: string): ManagedFileHandle['fileType'] {
    const lowerName = name.toLowerCase();

    if (lowerName.endsWith('.zip')) {
      return 'zip';
    }

    if (
      lowerName.endsWith('.pro') ||
      lowerName.endsWith('.exar1') ||
      lowerName.endsWith('.examcard') ||
      lowerName === 'lxprotocol'
    ) {
      return 'protocol';
    }

    // Assume DICOM for everything else that passed the filter
    return 'dicom';
  }

  /**
   * Get total size of all files in bytes
   */
  get totalSize(): number {
    return this._totalSize;
  }

  /**
   * Get total size in GB (formatted)
   */
  get totalSizeGB(): number {
    return this._totalSize / (1024 * 1024 * 1024);
  }

  /**
   * Get total file count
   */
  get fileCount(): number {
    return this.handles.length;
  }

  /**
   * Get all handles
   */
  getHandles(): ManagedFileHandle[] {
    return [...this.handles];
  }

  /**
   * Get only DICOM file handles (excluding ZIPs and protocols)
   */
  getDicomHandles(): ManagedFileHandle[] {
    return this.handles.filter(h => h.fileType === 'dicom');
  }

  /**
   * Get only ZIP file handles
   */
  getZipHandles(): ManagedFileHandle[] {
    return this.handles.filter(h => h.fileType === 'zip');
  }

  /**
   * Check if there are any ZIP files that need extraction
   */
  hasZipFiles(): boolean {
    return this.handles.some(h => h.fileType === 'zip');
  }

  /**
   * Generator that yields batches of files based on size and count limits.
   * Batches are created to stay under both limits.
   *
   * @param config - Batch configuration (size and count limits)
   */
  *getBatches(config: BatchConfig = DEFAULT_BATCH_CONFIG): Generator<ManagedFileHandle[]> {
    const { maxBatchSizeBytes, maxBatchFileCount } = config;

    let currentBatch: ManagedFileHandle[] = [];
    let currentSize = 0;

    for (const handle of this.handles) {
      // Check if adding this file would exceed limits
      const wouldExceedSize = currentSize + handle.size > maxBatchSizeBytes && currentBatch.length > 0;
      const wouldExceedCount = currentBatch.length >= maxBatchFileCount;

      // Start new batch if either limit would be exceeded
      if (wouldExceedSize || wouldExceedCount) {
        if (currentBatch.length > 0) {
          yield currentBatch;
        }
        currentBatch = [];
        currentSize = 0;
      }

      currentBatch.push(handle);
      currentSize += handle.size;
    }

    // Yield the last batch
    if (currentBatch.length > 0) {
      yield currentBatch;
    }
  }

  /**
   * Get the number of batches that will be created with given config
   */
  getBatchCount(config: BatchConfig = DEFAULT_BATCH_CONFIG): number {
    let count = 0;
    for (const _ of this.getBatches(config)) {
      count++;
    }
    return count;
  }

  /**
   * Clear all handles
   */
  clear(): void {
    this.handles = [];
    this._totalSize = 0;
  }
}
