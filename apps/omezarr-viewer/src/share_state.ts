export interface ShareableViewState {
  layout: number
  azimuth: number
  elevation: number
  scale: number
  crosshair: [number, number, number]
  pan2D: [number, number, number, number]
  renderPan: [number, number]
  colormap: string
  windowLevel: number
  windowWidth: number
  scrollZoomSpeed: number
  showCrosshair: boolean
  showScaleBar: boolean
  showStats: boolean
}

function finiteNumber(value: string | null): number | null {
  if (value === null || value.trim() === '') return null
  const number = Number(value)
  return Number.isFinite(number) ? number : null
}

function numberList(value: string | null, length: number): number[] | null {
  if (!value) return null
  const values = value.split(',').map((item) => Number(item))
  return values.length === length && values.every(Number.isFinite) ? values : null
}

function compactNumber(value: number): string {
  return String(Number(value.toFixed(6)))
}

export function writeShareState(url: URL, state: ShareableViewState): URL {
  url.searchParams.set('layout', String(state.layout))
  url.searchParams.set('zoom', compactNumber(state.pan2D[3]))
  url.searchParams.set('pan', state.pan2D.slice(0, 3).map(compactNumber).join(','))
  url.searchParams.set('crosshair', state.crosshair.map(compactNumber).join(','))
  url.searchParams.set('azimuth', compactNumber(state.azimuth))
  url.searchParams.set('elevation', compactNumber(state.elevation))
  url.searchParams.set('scale', compactNumber(state.scale))
  url.searchParams.set('renderPan', state.renderPan.map(compactNumber).join(','))
  url.searchParams.set('colormap', state.colormap)
  url.searchParams.set('wl', compactNumber(state.windowLevel))
  url.searchParams.set('ww', compactNumber(state.windowWidth))
  url.searchParams.set('scrollZoomSpeed', compactNumber(state.scrollZoomSpeed))
  url.searchParams.set('crosshairVisible', state.showCrosshair ? '1' : '0')
  url.searchParams.set('scaleBar', state.showScaleBar ? '1' : '0')
  url.searchParams.set('stats', state.showStats ? '1' : '0')
  return url
}

export function readShareState(
  params: URLSearchParams,
  defaults: ShareableViewState,
): ShareableViewState {
  const layout = finiteNumber(params.get('layout'))
  const zoom = finiteNumber(params.get('zoom'))
  const pan = numberList(params.get('pan'), 3)
  const crosshair = numberList(params.get('crosshair'), 3)
  const renderPan = numberList(params.get('renderPan'), 2)
  const scrollZoomSpeed = finiteNumber(params.get('scrollZoomSpeed'))
  return {
    ...defaults,
    layout: layout !== null && [0, 1, 2, 3, 4].includes(layout) ? layout : defaults.layout,
    azimuth: finiteNumber(params.get('azimuth')) ?? defaults.azimuth,
    elevation: finiteNumber(params.get('elevation')) ?? defaults.elevation,
    scale: finiteNumber(params.get('scale')) ?? defaults.scale,
    crosshair: (crosshair ?? defaults.crosshair) as [number, number, number],
    pan2D: [
      pan?.[0] ?? defaults.pan2D[0],
      pan?.[1] ?? defaults.pan2D[1],
      pan?.[2] ?? defaults.pan2D[2],
      zoom !== null && zoom > 0 ? zoom : defaults.pan2D[3],
    ],
    renderPan: (renderPan ?? defaults.renderPan) as [number, number],
    colormap: params.get('colormap') || defaults.colormap,
    windowLevel: finiteNumber(params.get('wl')) ?? defaults.windowLevel,
    windowWidth: finiteNumber(params.get('ww')) ?? defaults.windowWidth,
    scrollZoomSpeed:
      scrollZoomSpeed !== null &&
      scrollZoomSpeed >= 0.25 &&
      scrollZoomSpeed <= 4
        ? scrollZoomSpeed
        : defaults.scrollZoomSpeed,
    showCrosshair:
      params.get('crosshairVisible') === null
        ? defaults.showCrosshair
        : params.get('crosshairVisible') !== '0',
    showScaleBar:
      params.get('scaleBar') === null
        ? defaults.showScaleBar
        : params.get('scaleBar') !== '0',
    showStats:
      params.get('stats') === null ? defaults.showStats : params.get('stats') !== '0',
  }
}
