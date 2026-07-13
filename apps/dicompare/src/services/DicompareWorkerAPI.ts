/**
 * DicompareWorkerAPI - Main thread wrapper for Web Worker communication
 * Provides the same interface as DicompareAPI but runs processing in background thread
 */

import type { WorkerRequest, WorkerResponse, PendingRequest, ProgressPayload } from '../workers/workerTypes';
import { SchemaTemplate } from '../types/schema';
import { Acquisition as UIAcquisition, DicomField } from '../types';
import { FileObject } from '../utils/fileUploadUtils';
import { fieldToSchemaField } from '../utils/schemaFieldConverters';

function transferableCopy(bytes: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy.buffer;
}

class DicompareWorkerAPI {
  private worker: Worker | null = null;
  private pendingRequests: Map<string, PendingRequest> = new Map();
  private requestId = 0;
  private initializationPromise: Promise<void> | null = null;
  private initialized = false;

  constructor() {
    this.createWorker();
  }

  private createWorker(): void {
    // Create worker using Vite's worker import syntax
    this.worker = new Worker(
      new URL('../workers/pyodide.worker.ts', import.meta.url),
      { type: 'module' } // Use ES module worker with pyodide npm package
    );

    this.worker.onmessage = this.handleMessage.bind(this);
    this.worker.onerror = (error) => {
      console.error('[DicompareWorkerAPI] Worker error:', error);
    };
  }

  private handleMessage(event: MessageEvent<WorkerResponse>): void {
    const response = event.data;

    // Handle ready message (no id)
    if (response.type === 'ready') {
      console.log('[DicompareWorkerAPI] Worker ready:', response.payload);
      this.initialized = true;
      return;
    }

    // Handle messages with id
    const { id, type } = response as { id: string; type: string };
    const pending = this.pendingRequests.get(id);

    if (!pending) {
      console.warn('[DicompareWorkerAPI] No pending request for id:', id);
      return;
    }

    if (type === 'progress' && pending.onProgress) {
      pending.onProgress((response as any).payload);
      return; // Don't resolve yet, wait for success/error
    }

    if (type === 'success') {
      pending.resolve((response as any).payload);
      this.pendingRequests.delete(id);
    }

    if (type === 'error') {
      const error = (response as any).error;
      pending.reject(new Error(error.message));
      this.pendingRequests.delete(id);
    }
  }

  private sendRequest<T>(
    request: Omit<WorkerRequest, 'id'>,
    onProgress?: (progress: ProgressPayload) => void,
    transferables?: Transferable[]
  ): Promise<T> {
    const id = `req_${++this.requestId}_${Date.now()}`;

    return new Promise<T>((resolve, reject) => {
      this.pendingRequests.set(id, { resolve, reject, onProgress });

      const fullRequest = { ...request, id } as WorkerRequest;

      if (transferables && transferables.length > 0) {
        this.worker!.postMessage(fullRequest, transferables);
      } else {
        this.worker!.postMessage(fullRequest);
      }
    });
  }

  // ==========================================================================
  // Public API (mirrors DicompareAPI interface)
  // ==========================================================================

  /**
   * Ensure Pyodide and dicompare are initialized
   */
  async ensureInitialized(
    onProgress?: (progress: ProgressPayload) => void
  ): Promise<void> {
    if (this.initialized) {
      return;
    }

    if (!this.initializationPromise) {
      this.initializationPromise = this.sendRequest<void>(
        { type: 'initialize' },
        onProgress
      );
    } else if (onProgress) {
      // If already initializing but caller wants progress, we can't provide it
      // for the in-flight request, but we can at least await it
    }

    await this.initializationPromise;
    this.initialized = true;
  }

  /**
   * Check if initialized
   */
  isInitialized(): boolean {
    return this.initialized;
  }

  /**
   * Clear cached session data
   */
  async clearSessionCache(): Promise<void> {
    await this.ensureInitialized();
    await this.sendRequest({ type: 'clearCache' });
  }

  // ==========================================================================
  // DICOM Analysis
  // ==========================================================================

  /**
   * Analyze DICOM files and return UI-ready acquisition format.
   */
  async analyzeFilesForUI(
    files: FileObject[],
    onProgress?: (progress: { currentFile: number; totalFiles: number; currentOperation: string; percentage: number }) => void
  ): Promise<UIAcquisition[]> {
    // If not initialized, show init progress (0-30% of total)
    const needsInit = !this.initialized;

    if (needsInit && onProgress) {
      const initProgressHandler = (p: ProgressPayload) => {
        // Map init progress (0-100) to overall progress (0-30)
        const scaledPercentage = Math.round(p.percentage * 0.3);
        onProgress({
          currentFile: 0,
          totalFiles: files.length,
          currentOperation: p.currentOperation || 'Initializing...',
          percentage: scaledPercentage
        });
      };
      await this.ensureInitialized(initProgressHandler);
    } else {
      await this.ensureInitialized();
    }

    console.log(`[DicompareWorkerAPI] Analyzing ${files.length} files...`);

    const fileNames = files.map(f => f.name);
    // Create transferable copies of the ArrayBuffers
    const fileContents = files.map(f => transferableCopy(f.content));

    const progressHandler = onProgress
      ? (p: ProgressPayload) => {
          // Map file processing progress (0-100) to overall progress (30-100)
          const basePercentage = needsInit ? 30 : 0;
          const scaleFactor = needsInit ? 0.7 : 1;
          const scaledPercentage = Math.round(basePercentage + (p.percentage || 0) * scaleFactor);
          onProgress({
            currentFile: p.totalProcessed || 0,
            totalFiles: p.totalFiles || files.length,
            currentOperation: p.currentOperation || 'Processing...',
            percentage: scaledPercentage
          });
        }
      : undefined;

    return this.sendRequest<UIAcquisition[]>(
      { type: 'analyzeFiles', payload: { fileNames, fileContents } },
      progressHandler,
      fileContents // Transfer ownership for zero-copy
    );
  }

  /**
   * Analyze a single batch of DICOM files (for use with batch processor).
   * Does not include initialization progress - assumes already initialized.
   */
  async analyzeBatchForUI(
    files: FileObject[],
    batchIndex: number,
    totalBatches: number,
    onProgress?: (progress: ProgressPayload) => void
  ): Promise<UIAcquisition[]> {
    await this.ensureInitialized();

    console.log(`[DicompareWorkerAPI] Analyzing batch ${batchIndex + 1}/${totalBatches} (${files.length} files)...`);

    const fileNames = files.map(f => f.name);
    // Create transferable copies of the ArrayBuffers
    const fileContents = files.map(f => transferableCopy(f.content));

    return this.sendRequest<UIAcquisition[]>(
      { type: 'analyzeBatch', payload: { fileNames, fileContents, batchIndex, totalBatches } },
      onProgress,
      fileContents // Transfer ownership for zero-copy
    );
  }

  /**
   * Aggregate acquisitions from multiple batches.
   * Merges acquisitions with the same protocolName.
   */
  aggregateAcquisitions(batchResults: UIAcquisition[][]): UIAcquisition[] {
    const acquisitionMap = new Map<string, UIAcquisition>();

    for (const batch of batchResults) {
      for (const acq of batch) {
        const key = acq.protocolName;
        const existing = acquisitionMap.get(key);

        if (existing) {
          // Merge: combine file counts, merge series
          existing.totalFiles = (existing.totalFiles || 0) + (acq.totalFiles || 0);
          existing.sliceCount = (existing.sliceCount || 0) + (acq.sliceCount || 0);

          // Merge series data (unique by name)
          if (acq.series) {
            const seriesMap = new Map(existing.series?.map(s => [s.name, s]) || []);
            for (const series of acq.series) {
              if (!seriesMap.has(series.name)) {
                existing.series = existing.series || [];
                existing.series.push(series);
              } else {
                // Merge series fields if same name exists
                const existingSeries = seriesMap.get(series.name)!;
                if (series.fields) {
                  const existingFieldKeys = new Set(existingSeries.fields?.map(f => f.keyword || f.tag) || []);
                  for (const field of series.fields) {
                    const fieldKey = field.keyword || field.tag;
                    if (!existingFieldKeys.has(fieldKey)) {
                      existingSeries.fields = existingSeries.fields || [];
                      existingSeries.fields.push(field);
                    }
                  }
                }
              }
            }
          }

          // Merge acquisition-level fields
          if (acq.acquisitionFields) {
            const existingFieldKeys = new Set(existing.acquisitionFields?.map(f => f.keyword || f.tag) || []);
            for (const field of acq.acquisitionFields) {
              const fieldKey = field.keyword || field.tag;
              if (!existingFieldKeys.has(fieldKey)) {
                existing.acquisitionFields = existing.acquisitionFields || [];
                existing.acquisitionFields.push(field);
              }
            }
          }
        } else {
          // Clone the acquisition to avoid mutating original
          acquisitionMap.set(key, { ...acq });
        }
      }
    }

    return Array.from(acquisitionMap.values());
  }

  // ==========================================================================
  // Validation
  // ==========================================================================

  /**
   * Validate an acquisition against a schema.
   */
  async validateAcquisitionAgainstSchema(
    acquisition: UIAcquisition,
    schemaId: string,
    getSchemaContent?: (id: string) => Promise<string | null>,
    acquisitionIndex?: string
  ): Promise<any[]> {
    await this.ensureInitialized();

    // Fetch schema content on main thread (has fetch access)
    let schemaContent: string;
    if (getSchemaContent) {
      const content = await getSchemaContent(schemaId);
      if (!content) {
        throw new Error(`Schema content not found for ${schemaId}`);
      }
      schemaContent = content;
    } else {
      const response = await fetch(`${import.meta.env.BASE_URL}schemas/${schemaId}.json`);
      if (!response.ok) {
        throw new Error(`Failed to fetch schema ${schemaId}: ${response.statusText}`);
      }
      schemaContent = await response.text();
    }

    // Convert acquisition to format Python expects
    const acquisitionData = this.acquisitionToPythonDict(acquisition);

    return this.sendRequest({
      type: 'validateAcquisition',
      payload: {
        acquisition: acquisitionData,
        schemaContent,
        acquisitionIndex: acquisitionIndex ? parseInt(acquisitionIndex) : undefined
      }
    });
  }

  /**
   * Validate an acquisition against another acquisition (data-as-schema mode).
   */
  async validateAcquisitionAgainstAcquisition(
    dataAcquisition: UIAcquisition,
    schemaAcquisition: UIAcquisition
  ): Promise<any[]> {
    await this.ensureInitialized();

    // Convert the schema acquisition to schema JSON format
    const schemaContent = this.acquisitionToSchemaJson(schemaAcquisition);
    const acquisitionData = this.acquisitionToPythonDict(dataAcquisition);

    return this.sendRequest({
      type: 'validateAcquisition',
      payload: {
        acquisition: acquisitionData,
        schemaContent,
        acquisitionIndex: 0
      }
    });
  }

  private acquisitionToPythonDict(acquisition: UIAcquisition): Record<string, any> {
    return {
      protocolName: acquisition.protocolName,
      sliceCount: acquisition.sliceCount || 0,
      acquisitionFields: acquisition.acquisitionFields?.map(f => ({
        tag: f.tag,
        keyword: f.keyword,
        name: f.name,
        value: f.value
      })) || [],
      series: acquisition.series?.map(s => ({
        name: s.name,
        fields: s.fields?.map(f => ({
          tag: f.tag,
          keyword: f.keyword,
          name: f.name,
          value: f.value
        })) || []
      })) || []
    };
  }

  private acquisitionToSchemaJson(acquisition: UIAcquisition): string {
    const schema: any = {
      name: acquisition.protocolName || 'Generated Schema',
      description: acquisition.seriesDescription || '',
      acquisitions: {}
    };

    const acqEntry: any = {
      fields: [],
      series: []
    };

    if (acquisition.acquisitionFields) {
      for (const field of acquisition.acquisitionFields) {
        acqEntry.fields.push(fieldToSchemaField(field));
      }
    }

    if (acquisition.series) {
      for (const series of acquisition.series) {
        const seriesEntry: any = {
          name: series.name,
          fields: []
        };
        if (series.fields) {
          for (const field of series.fields) {
            seriesEntry.fields.push(fieldToSchemaField(field));
          }
        }
        acqEntry.series.push(seriesEntry);
      }
    }

    if (acquisition.validationFunctions && acquisition.validationFunctions.length > 0) {
      acqEntry.rules = acquisition.validationFunctions.map(func => ({
        id: func.name.toLowerCase().replace(/\s+/g, '_'),
        name: func.customName || func.name,
        description: func.description || '',
        implementation: func.implementation || '',
        fields: func.fields || []
      }));
    }

    const acqName = acquisition.protocolName || 'Acquisition';
    schema.acquisitions[acqName] = acqEntry;

    return JSON.stringify(schema);
  }

  // ==========================================================================
  // Protocol File Loading
  // ==========================================================================

  async loadProFile(fileContent: Uint8Array, fileName: string): Promise<UIAcquisition> {
    const acquisitions = await this._loadProtocolFile(fileContent, fileName, 'pro');
    return acquisitions[0];
  }

  async loadExarFile(fileContent: Uint8Array, fileName: string): Promise<UIAcquisition[]> {
    return this._loadProtocolFile(fileContent, fileName, 'exar1');
  }

  async loadExamCardFile(fileContent: Uint8Array, fileName: string): Promise<UIAcquisition[]> {
    return this._loadProtocolFile(fileContent, fileName, 'examcard');
  }

  async loadLxProtocolFile(fileContent: Uint8Array, fileName: string): Promise<UIAcquisition[]> {
    return this._loadProtocolFile(fileContent, fileName, 'lxprotocol');
  }

  async loadPrintProtFile(fileContent: Uint8Array, fileName: string): Promise<UIAcquisition[]> {
    return this._loadProtocolFile(fileContent, fileName, 'printprot');
  }

  /**
   * Derive diffusion descriptor fields from a gradient file (.dvs) or an FSL
   * bvec/bval pair. Returns UI-ready derived fields to merge into an
   * acquisition. `bMax` (the acquisition's DiffusionBValue) is required for
   * .dvs and ignored for bvec/bval.
   */
  async loadGradientFile(
    files: Record<string, string>,
    bMax: number | null
  ): Promise<{ fields: DicomField[] }> {
    await this.ensureInitialized();
    return this.sendRequest<{ fields: DicomField[] }>(
      { type: 'loadGradientFile', payload: { files, bMax } }
    );
  }

  /**
   * Bind diffusion gradient files (.dvs / .bvec+.bval) to the candidate
   * acquisitions they describe, deriving and merging shell/direction
   * descriptors. Returns the updated acquisitions plus which were bound and
   * which gradient files matched nothing.
   */
  async attachGradientFiles(
    acquisitions: UIAcquisition[],
    files: Array<{ name: string; content: string }>
  ): Promise<{
    acquisitions: UIAcquisition[];
    bound: Array<{ protocolName: string; id: any; descriptors: string[] }>;
    unmatched: string[];
  }> {
    await this.ensureInitialized();
    return this.sendRequest({ type: 'attachGradientFiles', payload: { acquisitions, files } });
  }

  private async _loadProtocolFile(
    fileContent: Uint8Array,
    fileName: string,
    fileType: string
  ): Promise<UIAcquisition[]> {
    await this.ensureInitialized();

    console.log(`[DicompareWorkerAPI] Loading ${fileType} protocol: ${fileName}`);

    // Create transferable copy
    const buffer = transferableCopy(fileContent);

    return this.sendRequest<UIAcquisition[]>(
      { type: 'loadProtocolFile', payload: { fileContent: buffer, fileName, fileType } },
      undefined,
      [buffer]
    );
  }

  // ==========================================================================
  // Field Search & Info
  // ==========================================================================

  async searchFields(query: string, limit: number = 20): Promise<any[]> {
    await this.ensureInitialized();
    return this.sendRequest({ type: 'searchFields', payload: { query, limit } });
  }

  async getFieldInfo(fieldOrTag: string): Promise<{ tag: string | null; name: string; type: string; fieldType: string } | null> {
    await this.ensureInitialized();
    return this.sendRequest({ type: 'getFieldInfo', payload: { fieldOrTag } });
  }

  async getDicomTag(keyword: string): Promise<{ tag: string; name: string; vr: string; keyword: string } | null> {
    const info = await this.getFieldInfo(keyword);
    if (info && info.tag) {
      return {
        tag: info.tag,
        name: info.name,
        vr: 'LO',
        keyword: keyword
      };
    }
    return null;
  }

  // ==========================================================================
  // Schema Generation & Parsing
  // ==========================================================================

  async generateSchemaJS(
    acquisitions: UIAcquisition[],
    metadata: { name: string; description?: string; version?: string; authors?: string[]; tags?: string[] }
  ): Promise<any> {
    await this.ensureInitialized();
    return this.sendRequest({ type: 'generateSchema', payload: { acquisitions, metadata } });
  }

  /**
   * Get example schemas - runs on main thread (just fetch, no Python needed)
   */
  async getExampleSchemas(): Promise<SchemaTemplate[]> {
    try {
      const response = await fetch(`${import.meta.env.BASE_URL}schemas/index.json`);
      if (!response.ok) {
        console.warn('Could not fetch schema index');
        return [];
      }

      const paths: string[] = await response.json();

      const schemas = await Promise.all(
        paths.map(async (path) => {
          try {
            // Use base URL for correct resolution regardless of current route
            const basePath = import.meta.env.BASE_URL || '/';
            const absolutePath = path.startsWith('/') ? `${basePath}${path.slice(1)}` : path;
            const id = path.replace('/schemas/', '').replace('.json', '');

            const schemaResponse = await fetch(absolutePath);
            if (!schemaResponse.ok) {
              console.warn(`Could not fetch schema at ${path}: ${schemaResponse.status}`);
              return null;
            }

            const schemaText = await schemaResponse.text();
            const schemaData = JSON.parse(schemaText);

            const allTags: string[] = [];
            if (schemaData.acquisitions) {
              for (const acq of Object.values(schemaData.acquisitions) as any[]) {
                if (acq.tags && Array.isArray(acq.tags)) {
                  allTags.push(...acq.tags);
                }
              }
            }
            const uniqueTags = [...new Set(allTags)];

            return {
              id,
              name: schemaData.name || id,
              description: schemaData.description || '',
              category: 'Library',
              content: schemaText,
              format: 'json' as const,
              tags: uniqueTags,
              version: schemaData.version,
              authors: schemaData.authors
            };
          } catch (error) {
            console.warn(`Failed to load schema from ${path}:`, error);
            return null;
          }
        })
      );

      return schemas.filter((s): s is NonNullable<typeof s> => s !== null);
    } catch (error) {
      console.warn('Failed to fetch example schemas:', error);
      return [];
    }
  }

  /**
   * Get schema fields - runs on main thread (pure JS parsing)
   */
  async getSchemaFields(schemaId: string, schemaContent?: string): Promise<{ acquisitionName: string; fields: any[] }[]> {
    let content: string;

    if (schemaContent) {
      content = schemaContent;
    } else {
      const response = await fetch(`${import.meta.env.BASE_URL}schemas/${schemaId}.json`);
      if (!response.ok) {
        throw new Error(`Failed to fetch schema ${schemaId}`);
      }
      content = await response.text();
    }

    const schema = JSON.parse(content);
    const result: { acquisitionName: string; fields: any[] }[] = [];

    const acquisitions = schema.acquisitions || {};
    for (const [acqName, acqData] of Object.entries(acquisitions)) {
      const acq = acqData as any;
      const fields: any[] = [];

      if (acq.fields && Array.isArray(acq.fields)) {
        for (const field of acq.fields) {
          fields.push({
            name: field.field,
            tag: field.tag,
            value: field.value,
            level: 'acquisition',
            fieldType: field.fieldType || 'standard'
          });
        }
      }

      if (acq.series && Array.isArray(acq.series)) {
        for (const series of acq.series) {
          if (series.fields && Array.isArray(series.fields)) {
            for (const field of series.fields) {
              fields.push({
                name: field.field,
                tag: field.tag,
                value: field.value,
                level: 'series',
                seriesName: series.name,
                fieldType: field.fieldType || 'standard'
              });
            }
          }
        }
      }

      result.push({ acquisitionName: acqName, fields });
    }

    return result;
  }

  // ==========================================================================
  // Test DICOM Generation
  // ==========================================================================

  async generateTestDicomsFromSchema(
    acquisition: UIAcquisition,
    testData: Array<Record<string, any>>,
    fields: Array<{ name: string; tag: string; level: string; dataType?: string; vr?: string }>
  ): Promise<Blob> {
    await this.ensureInitialized();

    const result = await this.sendRequest<{ zipBytes: number[] }>({
      type: 'generateTestDicoms',
      payload: { acquisition, testData, fields }
    });

    const zipBytes = new Uint8Array(result.zipBytes);
    return new Blob([zipBytes], { type: 'application/zip' });
  }

  async categorizeFields(
    fields: Array<{ name: string; tag: string; level?: string; dataType?: string; vr?: string }>,
    testData: Array<Record<string, any>>
  ): Promise<{
    standardFields: number;
    handledFields: number;
    unhandledFields: number;
    unhandledFieldWarnings: string[];
  }> {
    await this.ensureInitialized();
    return this.sendRequest({ type: 'categorizeFields', payload: { fields, testData } });
  }

  // ==========================================================================
  // Python Execution
  // ==========================================================================

  /**
   * Run arbitrary Python code and return the result.
   * Used for custom code execution (e.g., test data generation scripts).
   */
  async runPython(code: string): Promise<any> {
    await this.ensureInitialized();
    return this.sendRequest({ type: 'runPython', payload: { code } });
  }

  // ==========================================================================
  // Worker lifecycle
  // ==========================================================================

  /**
   * Terminate the worker (cleanup)
   */
  terminate(): void {
    if (this.worker) {
      this.worker.terminate();
      this.worker = null;
      this.initialized = false;
      this.initializationPromise = null;
      this.pendingRequests.clear();
    }
  }
}

// Create and export singleton instance
export const dicompareWorkerAPI = new DicompareWorkerAPI();
