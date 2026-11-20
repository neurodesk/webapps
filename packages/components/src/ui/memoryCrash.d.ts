export interface FormattedMemoryError {
  readonly kind: 'oom' | 'worker-crash' | 'webgl' | 'reload-active' | 'reload-loaded' | 'reload-discarded';
  readonly raw: string;
  readonly status: string;
  readonly log: string;
  readonly dedupLog: string;
}

export function isMemoryErrorMessage(value: unknown): boolean;
export function isRawMemoryErrorText(value: unknown): boolean;
export function formatMemoryError(
  value: unknown,
  options?: { kind?: FormattedMemoryError['kind']; detail?: string },
): FormattedMemoryError | null;
export function bindMemoryCrashMonitor(
  doc?: Document,
  options?: { appId?: string; now?: () => number; maxAgeMs?: number },
): { destroy(): void } | null;
