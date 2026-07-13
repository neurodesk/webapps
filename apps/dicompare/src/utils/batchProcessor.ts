/**
 * Generic batch processor for processing large file sets in memory-controlled batches.
 * Releases memory between batches to avoid browser memory limits.
 */

import { FileObject } from './fileUploadUtils';
import { ManagedFileHandle, BatchConfig, DEFAULT_BATCH_CONFIG } from './fileHandleManager';
import { readFileHandle } from './fileSystemAccessUtils';

export interface BatchProgress {
  totalFiles: number;
  processedFiles: number;
  currentBatchIndex: number;
  totalBatches: number;
  currentBatchProgress: number; // 0-100 within current batch
  currentOperation: string;
  currentFile?: string;
}

export interface BatchError {
  path: string;
  error: string;
}

export interface BatchResult<T> {
  results: T[];
  errors: BatchError[];
}

export interface BatchProcessorOptions<T> {
  config?: BatchConfig;
  processor: (files: FileObject[], batchIndex: number, totalBatches: number) => Promise<T[]>;
  onProgress?: (progress: BatchProgress) => void;
  onBatchComplete?: (batchIndex: number, results: T[]) => void;
}

/**
 * Process file handles in batches to stay under memory limits.
 * Each batch is loaded, processed, then released before the next batch.
 *
 * @param handles - Array of file handles to process
 * @param options - Processing options including the processor function
 * @returns Combined results from all batches and any errors
 */
export async function processBatches<T>(
  handles: ManagedFileHandle[],
  options: BatchProcessorOptions<T>
): Promise<BatchResult<T>> {
  const { config = DEFAULT_BATCH_CONFIG, processor, onProgress, onBatchComplete } = options;

  const allResults: T[] = [];
  const allErrors: BatchError[] = [];

  // Pre-calculate batches
  const batches = createBatches(handles, config);
  const totalBatches = batches.length;
  let processedFiles = 0;

  console.log(`Processing ${handles.length} files in ${totalBatches} batches`);

  for (let batchIndex = 0; batchIndex < totalBatches; batchIndex++) {
    const batch = batches[batchIndex];

    onProgress?.({
      totalFiles: handles.length,
      processedFiles,
      currentBatchIndex: batchIndex,
      totalBatches,
      currentBatchProgress: 0,
      currentOperation: `Loading batch ${batchIndex + 1}/${totalBatches}...`,
    });

    try {
      // Load batch content into memory
      const { files, errors: loadErrors } = await loadBatchContent(batch, (loaded, total, fileName) => {
        onProgress?.({
          totalFiles: handles.length,
          processedFiles: processedFiles + loaded,
          currentBatchIndex: batchIndex,
          totalBatches,
          currentBatchProgress: (loaded / total) * 50, // First 50% is loading
          currentOperation: `Loading files...`,
          currentFile: fileName,
        });
      });

      // Add any load errors
      allErrors.push(...loadErrors);

      if (files.length > 0) {
        onProgress?.({
          totalFiles: handles.length,
          processedFiles,
          currentBatchIndex: batchIndex,
          totalBatches,
          currentBatchProgress: 50,
          currentOperation: `Processing batch ${batchIndex + 1}/${totalBatches}...`,
        });

        // Process the batch
        const results = await processor(files, batchIndex, totalBatches);
        allResults.push(...results);
        onBatchComplete?.(batchIndex, results);
      }

      processedFiles += batch.length;

      onProgress?.({
        totalFiles: handles.length,
        processedFiles,
        currentBatchIndex: batchIndex,
        totalBatches,
        currentBatchProgress: 100,
        currentOperation: `Batch ${batchIndex + 1}/${totalBatches} complete`,
      });

      // Explicitly release batch memory
      // The files array and its contents will be garbage collected
      // after this iteration since we don't hold references
    } catch (error) {
      console.error(`Batch ${batchIndex} failed:`, error);

      // Record error for all files in the batch
      for (const handle of batch) {
        allErrors.push({
          path: handle.path,
          error: error instanceof Error ? error.message : 'Unknown batch error',
        });
      }

      processedFiles += batch.length;
    }

    // Give the garbage collector a chance to run between batches
    await new Promise(resolve => setTimeout(resolve, 10));
  }

  return {
    results: allResults,
    errors: allErrors,
  };
}

/**
 * Create batches from handles based on size and count limits
 */
function createBatches(handles: ManagedFileHandle[], config: BatchConfig): ManagedFileHandle[][] {
  const { maxBatchSizeBytes, maxBatchFileCount } = config;
  const batches: ManagedFileHandle[][] = [];

  let currentBatch: ManagedFileHandle[] = [];
  let currentSize = 0;

  for (const handle of handles) {
    const wouldExceedSize = currentSize + handle.size > maxBatchSizeBytes && currentBatch.length > 0;
    const wouldExceedCount = currentBatch.length >= maxBatchFileCount;

    if (wouldExceedSize || wouldExceedCount) {
      if (currentBatch.length > 0) {
        batches.push(currentBatch);
      }
      currentBatch = [];
      currentSize = 0;
    }

    currentBatch.push(handle);
    currentSize += handle.size;
  }

  if (currentBatch.length > 0) {
    batches.push(currentBatch);
  }

  return batches;
}

/**
 * Load file content for a batch of handles
 */
async function loadBatchContent(
  handles: ManagedFileHandle[],
  onProgress?: (loaded: number, total: number, fileName: string) => void
): Promise<{ files: FileObject[]; errors: BatchError[] }> {
  const files: FileObject[] = [];
  const errors: BatchError[] = [];

  for (let i = 0; i < handles.length; i++) {
    const handle = handles[i];

    try {
      const content = await readFileHandle(handle.handle);

      files.push({
        name: handle.path,
        content,
      });

      onProgress?.(i + 1, handles.length, handle.name);
    } catch (error) {
      console.warn(`Failed to read ${handle.path}:`, error);
      errors.push({
        path: handle.path,
        error: error instanceof Error ? error.message : 'Unknown read error',
      });
    }
  }

  return { files, errors };
}

/**
 * Estimate memory usage for a batch (rough estimate)
 */
export function estimateBatchMemory(handles: ManagedFileHandle[]): number {
  // Content stored twice during transfer (main thread + worker)
  // Plus some overhead for metadata
  const totalSize = handles.reduce((sum, h) => sum + h.size, 0);
  return totalSize * 2.5; // 2.5x for safety margin
}

/**
 * Calculate optimal batch config based on available memory
 * Note: This is a heuristic since actual memory limits vary by browser/device
 */
export function calculateOptimalBatchConfig(
  totalSize: number,
  fileCount: number,
  targetMemoryMB: number = 500
): BatchConfig {
  const targetMemoryBytes = targetMemoryMB * 1024 * 1024;

  // Account for memory multiplication during processing (2.5x safety factor)
  const effectiveMaxBatchSize = targetMemoryBytes / 2.5;

  // Calculate average file size
  const avgFileSize = fileCount > 0 ? totalSize / fileCount : 0;

  // Calculate max files that fit in the effective batch size
  const maxFilesBySize = avgFileSize > 0 ? Math.floor(effectiveMaxBatchSize / avgFileSize) : 100;

  return {
    maxBatchSizeBytes: Math.min(effectiveMaxBatchSize, DEFAULT_BATCH_CONFIG.maxBatchSizeBytes),
    maxBatchFileCount: Math.min(maxFilesBySize, DEFAULT_BATCH_CONFIG.maxBatchFileCount, 200),
  };
}
