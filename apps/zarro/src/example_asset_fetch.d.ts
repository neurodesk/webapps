import type { RetryOptions } from '@neurodesk/webapp-components/fetch'

export function createExampleAssetFetch(
  assets: readonly { url: string; sha256: string; bytes: number }[],
  options?: RetryOptions,
): (request: Request) => Promise<{ response: Response; wireBytes: number }>
