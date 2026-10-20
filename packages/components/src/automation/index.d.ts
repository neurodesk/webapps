export type ParameterValue = string | number | boolean | ParameterValue[];
export type InputFiles = File[] | { url: string };
export type ProgressUpdate = { message?: string; value?: number };
export type Artifact = { role: string; file: File; id?: string; type?: string; mediaType?: string; space?: string; labelSystem?: string };
export type OperationContext = {
  inputs: Record<string, InputFiles>;
  parameters: Record<string, ParameterValue | undefined>;
  signal: AbortSignal;
  progress(update: ProgressUpdate | string): void;
  inputDetails: Record<string, { sidecars: File[]; conversion?: object }>;
};
export type OperationResult = { artifacts: Artifact[]; provenance?: object; measurements?: object; summary?: object };
export type ViewerTab = { id: string; label?: string; active?: boolean };
export type ViewerTabs = { list(): ViewerTab[]; select(id: string): void | Promise<void> };
export type ViewerRegions = { list(): readonly unknown[] | Promise<readonly unknown[]> };
export type CrosshairPosition = { frame: 'mm'; value: [number, number, number] };
export type ViewerAdapter = {
  state(): object | Promise<object>;
  setCrosshair?(position: CrosshairPosition): void | Promise<void>;
  tabs?: ViewerTabs;
  regions?: ViewerRegions;
};
export type AutomationHandle = {
  ready: Promise<object>;
  /** Discard adopted inputs, artifacts and reports; abort an active operation. */
  reset(): void;
  dispatch(command: string, request?: object): Promise<unknown>;
  registerViewer(id: string, adapter: ViewerAdapter): () => boolean;
};
export type DicomConverter = (files: File[], options: { signal?: AbortSignal; niftiOnly?: boolean }) => Promise<File[]>;
export function registerAppAutomation(options: {
  app: string;
  operations: Record<string, (context: OperationContext) => Promise<OperationResult>>;
  convertDicom?: DicomConverter;
  contractUrl?: string;
  contract?: object;
  document?: Document;
  target?: object;
  download?: (file: File) => void | Promise<void>;
}): AutomationHandle;
export function registerViewer(id: string, adapter: ViewerAdapter): () => boolean;
export function createNiivueAdapter(controller: {
  getCrosshairPos?(): [number, number, number];
  setCrosshairPos?(position: [number, number, number]): void;
  createExtensionContext?(): { on(type: 'locationChange', callback: (event: { detail: { mm?: ArrayLike<number>; values?: unknown[] } }) => void): unknown };
}, options?: { tabs?: ViewerTabs; regions?: ViewerRegions }): ViewerAdapter;
export function createDicomConverter(options: { moduleUrl: string; timeoutMs?: number }): DicomConverter;
export function summarizeLabels(image: { data: ArrayLike<number>; dims: number[]; header: { affine: ArrayLike<number>[]; xyztUnits: number } }, lookup: { I: number[]; labels: string[] }): {
  geometry: { dimensions: number[]; affine: number[][]; spatialUnits: string };
  voxelVolumeMl: number | null;
  volumeUnavailable?: string;
  labels: { id: number; name: string; voxels: number; volumeMl?: number }[];
};
export function runAbortable<T>(signal: AbortSignal | undefined, task: () => T | Promise<T>, cancel: () => unknown): Promise<T>;
export function awaitPipelineStep<TStep, TResult, TError>(executor: {
  onStepComplete?: (step: TStep) => unknown;
  onComplete?: (result: TResult) => unknown;
  onError?: (error: TError) => unknown;
  cancel(): unknown;
}, options: { step: TStep; terminal?: 'step' | 'complete' }, action: () => unknown, signal: AbortSignal): Promise<void>;
export type LegacyRunSnapshot = {
  schemaVersion: 1;
  app: string;
  appVersion: string;
  runId: string | null;
  state: 'idle' | 'loading' | 'running' | 'ready' | 'succeeded' | 'failed' | 'cancelled';
  message: string;
  progress?: number;
  report?: object;
};
export function createRunState(options: { app: string; appVersion: string; statusElement?: HTMLElement }): {
  begin(state: 'loading' | 'running', context?: { inputs?: Record<string, File>; parameters?: object }): {
    readonly current: boolean;
    signal: AbortSignal;
    ready(message?: string): boolean;
    progress(update?: ProgressUpdate): boolean;
    fail(error: unknown): boolean;
    succeed(result: { artifacts: Record<string, { file: File; mediaType?: string; type?: string; space?: string; labelSystem?: string }>; provenance?: object; measurements?: object }): Promise<boolean>;
  };
  snapshot(): LegacyRunSnapshot;
  message(message: string): void;
  fail(error: unknown): void;
  cancel(message?: string): boolean;
};
