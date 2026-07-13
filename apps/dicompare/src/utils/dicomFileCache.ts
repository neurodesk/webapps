/**
 * In-memory cache for DICOM File objects.
 * Stores lightweight File references (not raw bytes) keyed by batch ID.
 * File objects can be re-read on demand when the viewer needs them.
 */

class DicomFileCacheImpl {
  private cache = new Map<string, File[]>();

  set(batchId: string, files: File[]): void {
    this.cache.set(batchId, files);
  }

  get(batchId: string): File[] | undefined {
    return this.cache.get(batchId);
  }

  has(batchId: string): boolean {
    return this.cache.has(batchId);
  }

  delete(batchId: string): void {
    this.cache.delete(batchId);
  }

  clear(): void {
    this.cache.clear();
  }
}

export const dicomFileCache = new DicomFileCacheImpl();
