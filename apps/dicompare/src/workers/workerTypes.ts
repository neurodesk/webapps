/**
 * Type definitions for Web Worker communication
 * Main thread ↔ Pyodide Worker message passing
 */

export type RequestId = string;

// Progress information sent from worker
export interface ProgressPayload {
  percentage: number;
  currentOperation: string;
  totalFiles?: number;
  totalProcessed?: number;
}

// Request types (main → worker)
export type WorkerRequest =
  | { id: RequestId; type: 'initialize'; payload?: undefined }
  | { id: RequestId; type: 'analyzeFiles'; payload: { fileNames: string[]; fileContents: ArrayBuffer[] } }
  | { id: RequestId; type: 'analyzeBatch'; payload: { fileNames: string[]; fileContents: ArrayBuffer[]; batchIndex: number; totalBatches: number } }
  | { id: RequestId; type: 'validateAcquisition'; payload: { acquisition: any; schemaContent: string; acquisitionIndex?: number } }
  | { id: RequestId; type: 'loadProtocolFile'; payload: { fileContent: ArrayBuffer; fileName: string; fileType: string } }
  | { id: RequestId; type: 'loadGradientFile'; payload: { files: Record<string, string>; bMax: number | null } }
  | { id: RequestId; type: 'attachGradientFiles'; payload: { acquisitions: any[]; files: Array<{ name: string; content: string }> } }
  | { id: RequestId; type: 'searchFields'; payload: { query: string; limit: number } }
  | { id: RequestId; type: 'getFieldInfo'; payload: { fieldOrTag: string } }
  | { id: RequestId; type: 'generateSchema'; payload: { acquisitions: any[]; metadata: any } }
  | { id: RequestId; type: 'generateTestDicoms'; payload: { acquisition: any; testData: any[]; fields: any[] } }
  | { id: RequestId; type: 'categorizeFields'; payload: { fields: any[]; testData: any[] } }
  | { id: RequestId; type: 'runPython'; payload: { code: string } }
  | { id: RequestId; type: 'clearCache'; payload?: undefined };

// Response types (worker → main)
export type WorkerResponse =
  | { id: RequestId; type: 'success'; payload: any }
  | { id: RequestId; type: 'error'; error: { message: string; stack?: string } }
  | { id: RequestId; type: 'progress'; payload: ProgressPayload }
  | { type: 'ready'; payload: { pyodideVersion: string; dicompareVersion: string } };

// Pending request tracking
export interface PendingRequest<T = any> {
  resolve: (value: T) => void;
  reject: (error: Error) => void;
  onProgress?: (progress: ProgressPayload) => void;
}
