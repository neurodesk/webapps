export type ComputeJobStatus = 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled';

export interface ComputeOutput {
  name: string;
  bytes: number;
  contentType: string;
  /** Project jobs only: false when the file is above `limits.maxDownloadBytes`. */
  download?: boolean;
}

export interface ComputeJob {
  id: string;
  tool: string;
  command: string;
  status: ComputeJobStatus;
  position: number;
  progress: number | null;
  stage: string | null;
  message: string | null;
  simulated: boolean;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  error: { code: string; message: string } | null;
  outputs: ComputeOutput[];
  /** Absent on servers without the HPC features; null or [] for jobs outside projects. */
  project?: string | null;
  directory?: string | null;
  dependsOn?: string[];
  scheduler?: { id: string; state: string } | null;
}

export interface ComputeProjectJob {
  id: string;
  command: string;
  directory: string;
  status: ComputeJobStatus;
  dependsOn: string[];
  createdAt: string;
  finishedAt: string | null;
}

export interface ComputeProject { id: string; name: string; createdAt: string; jobs: ComputeProjectJob[] }

export interface ComputeProjectSummary { id: string; name: string; createdAt: string; jobCount: number }

export interface ComputeRoot { id: string; label: string }

export interface ComputeEntry { name: string; kind: 'file' | 'directory'; bytes: number | null; modifiedAt: string }

export interface ComputeEntriesPage { path: string; entries: ComputeEntry[]; next: string | null }

export interface ComputeInfo {
  service: 'neurodesk-compute';
  version: string;
  protocol: number;
  auth: 'bearer';
  simulated?: boolean;
  runner?: string;
  gpu?: { available: boolean; name: string | null };
  tools?: { id: string; version: string; image: string; commands: string[]; gpuRequired?: boolean }[];
  limits?: { maxUploadBytes: number; maxFiles: number; maxDownloadBytes?: number };
  ownership?: 'pairing' | 'single';
  features?: ('projects' | 'dataRoots' | 'scheduler')[];
  dataRoots?: ComputeRoot[];
  profiles?: { name: string; summary: string }[];
}

export interface WatchHandlers {
  onStatus?(event: { status: ComputeJobStatus; position: number }): void;
  onProgress?(event: { fraction: number; stage: string }): void;
  onLog?(event: { line: string; level: 'info' | 'warning' | 'error' }): void;
}

export interface ComputeClientOptions { baseUrl: string; token?: string; fetch?: typeof fetch }

export class ComputeError extends Error {
  code: string;
  status: number;
  job: ComputeJob | null;
  constructor(code: string, message: string, options?: { status?: number; job?: ComputeJob | null });
}

export class ComputeClient {
  constructor(options: ComputeClientOptions);
  readonly baseUrl: string;
  readonly token: string;
  info(options?: { signal?: AbortSignal }): Promise<ComputeInfo>;
  submit(spec: object, files: Record<string, Blob>, options?: { signal?: AbortSignal }): Promise<{ id: string; status: ComputeJobStatus; position: number }>;
  job(id: string, options?: { signal?: AbortSignal }): Promise<ComputeJob>;
  watch(id: string, handlers?: WatchHandlers, options?: { signal?: AbortSignal }): Promise<ComputeJob>;
  cancel(id: string, options?: { signal?: AbortSignal }): Promise<void>;
  output(id: string, name: string, options?: { signal?: AbortSignal }): Promise<Blob>;
  projects(options?: { signal?: AbortSignal }): Promise<{ projects: ComputeProjectSummary[] }>;
  createProject(name: string, options?: { signal?: AbortSignal }): Promise<ComputeProject>;
  project(id: string, options?: { signal?: AbortSignal }): Promise<ComputeProject>;
  removeProject(id: string, options?: { signal?: AbortSignal }): Promise<void>;
  roots(options?: { signal?: AbortSignal }): Promise<{ roots: ComputeRoot[] }>;
  entries(root: string, path?: string, cursor?: string | null, options?: { signal?: AbortSignal }): Promise<ComputeEntriesPage>;
}

export function createComputeClient(options: ComputeClientOptions): ComputeClient;
export function normalizeBaseUrl(input: string): string;
export function isLoopback(baseUrl: string): boolean;
export function describeConnectionError(error: unknown, context?: { pageOrigin?: string; baseUrl?: string }): { code: string; message: string };
