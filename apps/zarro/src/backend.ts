// Reads ?backend=webgl2|webgpu. WebGL2 is the default.

export type Backend = 'webgl2' | 'webgpu'

const DEFAULT_BACKEND: Backend = 'webgl2'

export function getBackendFromUrl(): Backend {
  if (typeof window === 'undefined') return DEFAULT_BACKEND
  const params = new URLSearchParams(window.location.search)
  const raw = params.get('backend')
  if (raw === 'webgpu' || raw === 'webgl2') return raw
  return DEFAULT_BACKEND
}
