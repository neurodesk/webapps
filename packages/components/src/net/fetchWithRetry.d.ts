export interface RetryOptions {
  retries?: number;
  baseDelay?: number;
  maxDelay?: number;
  retryTransient?: boolean;
  fetch?: typeof globalThis.fetch;
  onRetry?(event: { status: number; attempt: number; delay: number }): void;
}

export function retryDelay(response: Response, attempt: number, options?: { baseDelay?: number; maxDelay?: number }): number;
export function fetchWithRetry(input: RequestInfo | URL, init?: RequestInit, options?: RetryOptions): Promise<Response>;
