export interface AdapterInfoLike {
  vendor?: string
  architecture?: string
  device?: string
  description?: string
  isFallbackAdapter?: boolean
}

export interface Webgl2Probe {
  supported?: boolean
  renderer?: string
  software?: boolean | undefined
  caveat?: boolean
}

export interface WebgpuProbe {
  supported?: boolean
  software?: boolean
  info?: AdapterInfoLike
}

export interface BackendChoiceInput {
  webgpu?: WebgpuProbe | null
  webgl2?: Webgl2Probe | (() => Webgl2Probe | null | undefined) | null
  cpu?: boolean
}

export function isSoftwareAdapter(info?: AdapterInfoLike | null): boolean
export function isSoftwareRenderer(probe?: Pick<Webgl2Probe, 'renderer' | 'caveat'> | null): boolean
export function chooseBackend(input: BackendChoiceInput): 'webgpu' | 'webgl2' | 'cpu' | 'auto' | null
export function withBackendChoice<T extends { segment: (...args: any[]) => any; segmentTissues: (...args: any[]) => any }>(
  mindgrab: T,
): Pick<T, 'segment' | 'segmentTissues'>
