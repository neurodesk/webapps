import { useState, useCallback } from 'react';
import { Acquisition, DicomField } from '../types';
import { ProcessingProgress } from '../contexts/WorkspaceContext';
import { dicompareWorkerAPI as dicompareAPI } from '../services/DicompareWorkerAPI';
import { processUploadedFiles, FileObject } from '../utils/fileUploadUtils';
import { filesToFileList } from '../utils/workspaceHelpers';
import { FileHandleManager, ManagedFileHandle } from '../utils/fileHandleManager';
import { readFileHandle } from '../utils/fileSystemAccessUtils';
import { dicomFileCache } from '../utils/dicomFileCache';

// Batch config - based on Pyodide's buffer size limits (~2GB safe limit)
const BATCH_SIZE_BYTES = 1 * 1024 * 1024 * 1024; // 1GB per batch - safe margin under Pyodide's ~2GB limit
const NO_BATCH_THRESHOLD_BYTES = BATCH_SIZE_BYTES; // Below 1GB, no batching needed

// Parallel file reading - read multiple files concurrently for speed
const READ_CONCURRENCY = 100; // Read 100 files in parallel

export type ProcessingTarget = 'schema' | 'data' | 'addNew' | null;

export interface ProcessingResult {
  acquisitions: Acquisition[];
  dicomFileBatchId?: string;
}

export interface UseFileProcessingReturn {
  isProcessing: boolean;
  processingTarget: ProcessingTarget;
  processingProgress: ProcessingProgress | null;
  processingError: string | null;
  processFiles: (files: FileList, target: ProcessingTarget) => Promise<ProcessingResult>;
  processFileHandles: (manager: FileHandleManager, target: ProcessingTarget) => Promise<ProcessingResult>;
  clearError: () => void;
}

export type ProtocolFileType = 'pro' | 'exar1' | 'examcard' | 'lxprotocol' | 'printprot';

/**
 * Detect protocol file type from filename.
 *
 * Note: `.xml` and `.txt` are treated as Siemens "MR print protocol" candidates
 * here (they are never DICOM). The actual format is confirmed by sniffing the
 * file content in `refineProtocolFileType`, which also re-routes an ExamCard
 * that happens to carry an `.xml` extension.
 */
export function getProtocolFileType(fileName: string): ProtocolFileType | null {
  const lowerName = fileName.toLowerCase();
  if (lowerName.endsWith('.pro')) return 'pro';
  if (lowerName.endsWith('.exar1')) return 'exar1';
  if (lowerName.endsWith('.examcard')) return 'examcard';
  if (lowerName === 'lxprotocol') return 'lxprotocol';
  if (lowerName.endsWith('.xml') || lowerName.endsWith('.txt')) return 'printprot';
  return null;
}

/**
 * Refine a name-based protocol type using the file's content. Disambiguates the
 * XML formats: a Philips ExamCard is SOAP-enveloped, a Siemens print protocol
 * has a <PrintProtocol>/<PrintOut> root. Returns null if the content does not
 * look like a recognised protocol (so a stray .xml/.txt is ignored).
 */
function refineProtocolFileType(
  fileType: ProtocolFileType,
  content: Uint8Array
): ProtocolFileType | null {
  if (fileType !== 'printprot') return fileType;

  const head = new TextDecoder('utf-8', { fatal: false })
    .decode(content.subarray(0, 2048));

  if (head.includes('SOAP-ENV:Envelope') || head.includes('ExamCards.ECModel')) {
    return 'examcard';
  }
  if (head.includes('<PrintProtocol') || head.includes('<PrintOut')) {
    return 'printprot'; // Siemens print-protocol XML
  }
  // TXT print protocol: scanner header + Siemens protocol path line.
  if (head.includes('MAGNETOM') || /\\\\USER\\/.test(head)) {
    return 'printprot';
  }
  return null;
}

export type GradientFileType = 'dvs' | 'bvec' | 'bval';

/** Detect a diffusion gradient file by extension. Never a DICOM. */
export function getGradientFileType(fileName: string): GradientFileType | null {
  const lower = fileName.toLowerCase();
  if (lower.endsWith('.dvs')) return 'dvs';
  if (lower.endsWith('.bvec')) return 'bvec';
  if (lower.endsWith('.bval')) return 'bval';
  return null;
}

/** Read gradient files into {name, content} for the pip binder. */
async function gradientFilesToPayload(files: File[]): Promise<Array<{ name: string; content: string }>> {
  return Promise.all(files.map(async (f) => ({ name: f.name, content: await f.text() })));
}

/**
 * Bind diffusion gradient files (.dvs / .bvec+.bval) to the acquisitions they
 * describe, deriving and merging shell/direction descriptors. All matching and
 * derivation happens in the dicompare pip package (attach_gradient_files_to_
 * acquisitions), so the web app, embed, and CLI share one implementation.
 *
 * Returns one entry per successfully bound acquisition with its updated field
 * list (the caller applies it). Does not mutate the inputs.
 */
export async function computeGradientBindings(
  acquisitions: Acquisition[],
  gradientFiles: File[]
): Promise<Array<{ acquisition: Acquisition; fields: DicomField[] }>> {
  if (gradientFiles.length === 0 || acquisitions.length === 0) return [];

  const files = await gradientFilesToPayload(gradientFiles);
  const { acquisitions: updated, bound, unmatched } = await dicompareAPI.attachGradientFiles(acquisitions, files);

  if (unmatched.length > 0) {
    console.warn(`[useFileProcessing] Gradient file(s) matched no acquisition: ${unmatched.join(', ')}`);
  }

  const fieldsById = new Map(updated.map((a) => [a.id, a.acquisitionFields as DicomField[]]));
  const seen = new Set<any>();
  const results: Array<{ acquisition: Acquisition; fields: DicomField[] }> = [];
  for (const b of bound) {
    if (seen.has(b.id)) continue;
    seen.add(b.id);
    const original = acquisitions.find((a) => a.id === b.id);
    const fields = fieldsById.get(b.id);
    if (original && fields) results.push({ acquisition: original, fields });
  }
  return results;
}

/**
 * Bind gradient files to freshly-parsed acquisitions in place (used during the
 * drop-together upload flow, before the acquisitions enter React state).
 */
async function bindGradientFiles(
  acquisitions: Acquisition[],
  gradientFiles: File[]
): Promise<void> {
  const bindings = await computeGradientBindings(acquisitions, gradientFiles);
  for (const { acquisition, fields } of bindings) {
    acquisition.acquisitionFields = fields;
  }
}

/**
 * Derive descriptors for a SINGLE, known acquisition from picked gradient files
 * (a .dvs, or a .bvec + .bval pair). Returns the acquisition's updated field
 * list (descriptors merged in). Used by the per-acquisition drop zone; throws a
 * user-facing message when nothing could be bound.
 */
export async function deriveGradientDescriptorFields(
  acquisition: Acquisition,
  gradientFiles: File[]
): Promise<DicomField[]> {
  const files = await gradientFilesToPayload(gradientFiles);
  const { acquisitions: updated, bound } = await dicompareAPI.attachGradientFiles([acquisition], files);
  if (bound.length > 0 && updated[0]?.acquisitionFields) {
    return updated[0].acquisitionFields as DicomField[];
  }
  const hasDvs = gradientFiles.some((f) => getGradientFileType(f.name) === 'dvs');
  const hasBvec = gradientFiles.some((f) => getGradientFileType(f.name) === 'bvec');
  const hasBval = gradientFiles.some((f) => getGradientFileType(f.name) === 'bval');
  if (hasDvs) {
    throw new Error('Could not interpret the .dvs file. This acquisition needs a DiffusionBValue; attach a .bvec/.bval pair instead.');
  }
  if (hasBvec !== hasBval) {
    throw new Error('Provide a matching .bvec and .bval pair.');
  }
  throw new Error('Provide a .dvs file, or a matching .bvec and .bval pair.');
}

/**
 * Hook for processing DICOM and protocol files with progress tracking.
 * Consolidates duplicate file processing logic from WorkspaceContext.
 */
export function useFileProcessing(): UseFileProcessingReturn {
  const [isProcessing, setIsProcessing] = useState(false);
  const [processingTarget, setProcessingTarget] = useState<ProcessingTarget>(null);
  const [processingProgress, setProcessingProgress] = useState<ProcessingProgress | null>(null);
  const [processingError, setProcessingError] = useState<string | null>(null);

  const clearError = useCallback(() => {
    setProcessingError(null);
  }, []);

  /**
   * Process a batch of files (DICOM or protocol) and return acquisitions.
   */
  const processFiles = useCallback(async (
    files: FileList,
    target: ProcessingTarget
  ): Promise<ProcessingResult> => {
    setIsProcessing(true);
    setProcessingTarget(target);
    setProcessingError(null);
    setProcessingProgress({
      currentFile: 0,
      totalFiles: files.length,
      currentOperation: 'Initializing...',
      percentage: 0
    });

    try {
      const fileArray = Array.from(files);
      const gradientFiles = fileArray.filter(f => getGradientFileType(f.name) !== null);
      const protocolFiles = fileArray.filter(f => getGradientFileType(f.name) === null && getProtocolFileType(f.name) !== null);
      const dicomFiles = fileArray.filter(f => getGradientFileType(f.name) === null && getProtocolFileType(f.name) === null);

      const acquisitions: Acquisition[] = [];
      let dicomFileBatchId: string | undefined;

      // Cache DICOM File objects for later visualization
      if (dicomFiles.length > 0) {
        dicomFileBatchId = `batch_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
        dicomFileCache.set(dicomFileBatchId, [...dicomFiles]);
      }

      // Process protocol files
      if (protocolFiles.length > 0) {
        setProcessingProgress(prev => ({
          ...prev!,
          currentOperation: 'Processing protocol files...',
          percentage: 10
        }));

        for (const file of protocolFiles) {
          const nameType = getProtocolFileType(file.name)!;
          const fileContent = await file.arrayBuffer();
          const uint8Content = new Uint8Array(fileContent);

          // Confirm/disambiguate the format from content (e.g. .xml could be an
          // ExamCard or a Siemens print protocol). Skip unrecognised .xml/.txt.
          const fileType = refineProtocolFileType(nameType, uint8Content);
          if (fileType === null) {
            console.warn(`[useFileProcessing] Skipping unrecognised protocol file: ${file.name}`);
            continue;
          }

          let result: Acquisition[] = [];
          if (fileType === 'pro') {
            const proResult = await dicompareAPI.loadProFile(uint8Content, file.name);
            result = [proResult];
          } else if (fileType === 'exar1') {
            result = await dicompareAPI.loadExarFile(uint8Content, file.name);
          } else if (fileType === 'examcard') {
            result = await dicompareAPI.loadExamCardFile(uint8Content, file.name);
          } else if (fileType === 'lxprotocol') {
            result = await dicompareAPI.loadLxProtocolFile(uint8Content, file.name);
          } else if (fileType === 'printprot') {
            result = await dicompareAPI.loadPrintProtFile(uint8Content, file.name);
          }

          acquisitions.push(...result);
        }
      }

      // Process DICOM files
      if (dicomFiles.length > 0) {
        const fileObjects = await processUploadedFiles(
          filesToFileList(dicomFiles),
          {
            onProgress: (fileProgress) => {
              setProcessingProgress(prev => ({
                ...prev!,
                currentOperation: `Reading file ${fileProgress.current} of ${fileProgress.total}`,
                percentage: (fileProgress.current / fileProgress.total) * 5
              }));
            }
          }
        );

        const result = await dicompareAPI.analyzeFilesForUI(fileObjects, (progress) => {
          setProcessingProgress({
            currentFile: progress.currentFile,
            totalFiles: progress.totalFiles,
            currentOperation: progress.currentOperation,
            percentage: progress.percentage
          });
        });

        acquisitions.push(...(result || []));
      }

      // Bind any diffusion gradient files to the acquisitions they describe,
      // deriving descriptor fields. Done last, once all acquisitions exist.
      if (gradientFiles.length > 0 && acquisitions.length > 0) {
        setProcessingProgress(prev => ({
          ...prev!,
          currentOperation: 'Deriving diffusion gradient descriptors...',
          percentage: 95
        }));
        await bindGradientFiles(acquisitions, gradientFiles);
      } else if (gradientFiles.length > 0) {
        console.warn('[useFileProcessing] Gradient file(s) dropped without a protocol/DICOM acquisition to attach to; ignored');
      }

      return { acquisitions, dicomFileBatchId };
    } catch (error) {
      console.error('Failed to process files:', error);
      setProcessingError(error instanceof Error ? error.message : 'Unknown error occurred');
      return { acquisitions: [] };
    } finally {
      setIsProcessing(false);
      setProcessingTarget(null);
      setProcessingProgress(null);
    }
  }, []);

  /**
   * Process files using File System Access API handles (for large datasets).
   * Uses smart batching - no batching for small datasets, larger batches for big ones.
   */
  const processFileHandles = useCallback(async (
    manager: FileHandleManager,
    target: ProcessingTarget
  ): Promise<ProcessingResult> => {
    setIsProcessing(true);
    setProcessingTarget(target);
    setProcessingError(null);

    const handles = manager.getDicomHandles();
    const totalFiles = handles.length;
    const totalSize = manager.totalSize;

    // Cache File objects from handles for later visualization
    let dicomFileBatchId: string | undefined;
    if (handles.length > 0) {
      dicomFileBatchId = `batch_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
      try {
        const fileObjects = await Promise.all(
          handles.map(h => h.handle.getFile())
        );
        dicomFileCache.set(dicomFileBatchId, fileObjects);
      } catch (error) {
        console.warn('Failed to cache File objects from handles:', error);
        dicomFileBatchId = undefined;
      }
    }

    // Decide if we need batching (only based on size)
    const needsBatching = totalSize > NO_BATCH_THRESHOLD_BYTES;

    if (!needsBatching) {
      // Small dataset - load all at once
      const acquisitions = await processAllFilesAtOnce(handles, totalFiles);
      return { acquisitions, dicomFileBatchId };
    }

    // Large dataset - use batching
    const batches = createBatches(handles);
    console.log(`[useFileProcessing] Processing ${totalFiles} files (${manager.totalSizeGB.toFixed(2)} GB) in ${batches.length} batches`);

    setProcessingProgress({
      currentFile: 0,
      totalFiles,
      currentOperation: 'Initializing...',
      percentage: 0
    });

    try {
      const allResults: Acquisition[][] = [];
      let processedFiles = 0;

      for (let batchIndex = 0; batchIndex < batches.length; batchIndex++) {
        const batch = batches[batchIndex];

        // Load batch files in parallel
        setProcessingProgress({
          currentFile: processedFiles,
          totalFiles,
          currentOperation: `Loading batch ${batchIndex + 1}/${batches.length}...`,
          percentage: Math.round((processedFiles / totalFiles) * 100)
        });

        const fileObjects = await readFilesParallel(batch);

        // Process batch
        setProcessingProgress({
          currentFile: processedFiles,
          totalFiles,
          currentOperation: `Processing batch ${batchIndex + 1}/${batches.length} (${fileObjects.length} files)...`,
          percentage: Math.round((processedFiles / totalFiles) * 100)
        });

        const batchResult = await dicompareAPI.analyzeBatchForUI(
          fileObjects,
          batchIndex,
          batches.length
        );

        allResults.push(batchResult);
        processedFiles += batch.length;

        console.log(`[useFileProcessing] Batch ${batchIndex + 1}/${batches.length} complete: ${batchResult.length} acquisitions`);
      }

      // Aggregate results
      const aggregated = dicompareAPI.aggregateAcquisitions(allResults);
      console.log(`[useFileProcessing] Done: ${aggregated.length} acquisitions from ${batches.length} batches`);

      return { acquisitions: aggregated, dicomFileBatchId };
    } catch (error) {
      console.error('Failed to process files:', error);
      setProcessingError(error instanceof Error ? error.message : 'Unknown error occurred');
      return { acquisitions: [] };
    } finally {
      setIsProcessing(false);
      setProcessingTarget(null);
      setProcessingProgress(null);
    }
  }, []);

  // Helper: read files in parallel with concurrency limit
  const readFilesParallel = async (
    handles: ManagedFileHandle[],
    onProgress?: (loaded: number) => void
  ): Promise<FileObject[]> => {
    const results: FileObject[] = [];
    let loaded = 0;

    // Process in chunks of READ_CONCURRENCY
    for (let i = 0; i < handles.length; i += READ_CONCURRENCY) {
      const chunk = handles.slice(i, i + READ_CONCURRENCY);

      const chunkResults = await Promise.all(
        chunk.map(async (handle) => {
          try {
            const content = await readFileHandle(handle.handle);
            return { name: handle.path, content };
          } catch (error) {
            console.warn(`Failed to read ${handle.path}:`, error);
            return null;
          }
        })
      );

      // Filter out failed reads and add to results
      for (const result of chunkResults) {
        if (result) results.push(result);
      }

      loaded += chunk.length;
      onProgress?.(loaded);
    }

    return results;
  };

  // Helper: process all files at once (for small datasets)
  const processAllFilesAtOnce = async (
    handles: ManagedFileHandle[],
    totalFiles: number
  ): Promise<Acquisition[]> => {
    setProcessingProgress({
      currentFile: 0,
      totalFiles,
      currentOperation: 'Loading files...',
      percentage: 0
    });

    try {
      const fileObjects = await readFilesParallel(handles, (loaded) => {
        setProcessingProgress({
          currentFile: loaded,
          totalFiles,
          currentOperation: `Loading files... (${loaded}/${totalFiles})`,
          percentage: Math.round((loaded / totalFiles) * 20)
        });
      });

      console.log(`[useFileProcessing] Loaded ${fileObjects.length} files, analyzing...`);

      const result = await dicompareAPI.analyzeFilesForUI(fileObjects, (progress) => {
        setProcessingProgress({
          currentFile: progress.currentFile,
          totalFiles: progress.totalFiles,
          currentOperation: progress.currentOperation,
          percentage: 20 + Math.round(progress.percentage * 0.8)
        });
      });

      return result || [];
    } catch (error) {
      console.error('Failed to process files:', error);
      setProcessingError(error instanceof Error ? error.message : 'Unknown error occurred');
      return [];
    } finally {
      setIsProcessing(false);
      setProcessingTarget(null);
      setProcessingProgress(null);
    }
  };

  // Helper: create batches based on size only
  const createBatches = (handles: ManagedFileHandle[]): ManagedFileHandle[][] => {
    const batches: ManagedFileHandle[][] = [];
    let currentBatch: ManagedFileHandle[] = [];
    let currentSize = 0;

    for (const handle of handles) {
      // Start new batch if adding this file would exceed size limit
      if (currentSize + handle.size > BATCH_SIZE_BYTES && currentBatch.length > 0) {
        batches.push(currentBatch);
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
  };

  return {
    isProcessing,
    processingTarget,
    processingProgress,
    processingError,
    processFiles,
    processFileHandles,
    clearError,
  };
}
