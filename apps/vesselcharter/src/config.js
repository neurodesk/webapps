import { sampleColormapRgba } from '@neurodesk/vesselcharter';

export const APP = Object.freeze({
  id: 'vesselcharter',
  title: 'VesselCharter',
  subtitle: '3D blood vessel morphometry and branching',
});

export const DEFAULT_DIAMETER_COLORMAP = 'turbo';

export const DIAMETER_COLORMAPS = Object.freeze([
  { id: 'turbo', label: 'Turbo' },
  { id: 'viridis', label: 'Viridis' },
  { id: 'plasma', label: 'Plasma' },
  { id: 'inferno', label: 'Inferno' },
  { id: 'hot', label: 'Hot' },
]);

export const SKELETON_COLORMAP_NAME = 'vc-skeleton';

// Categorical 4-class LUT mapped with colormapType=1, calMin=0.5, calMax=4:
// 0=transparent, 1=Segment, 2=Junction, 3=Endpoint, 4=Isolated.
export const SKELETON_COLORMAP = Object.freeze({
  R: [0, 56, 249, 250, 217],
  G: [0, 189, 115, 204, 70],
  B: [0, 248, 22, 21, 239],
  A: [0, 255, 255, 255, 255],
  I: [0, 64, 128, 192, 255],
});

export const SKELETON_LEGEND_ITEMS = Object.freeze([
  { value: 1, label: 'Segment', color: [56, 189, 248] },
  { value: 2, label: 'Junction', color: [249, 115, 22] },
  { value: 3, label: 'Endpoint', color: [250, 204, 21] },
  { value: 4, label: 'Isolated', color: [217, 70, 239] },
]);

export function buildColorMapCssGradient(lut, steps = 16) {
  const count = Math.max(2, steps);
  const stops = Array.from({ length: count + 1 }, (_, i) => {
    const frac = i / count;
    const [r, g, b] = sampleColormapRgba(lut, frac);
    return `rgb(${r} ${g} ${b}) ${(frac * 100).toFixed(1)}%`;
  });
  return `linear-gradient(to right, ${stops.join(', ')})`;
}

export function formatDiameterValue(valueMm) {
  if (!Number.isFinite(valueMm)) {
    return '—';
  }
  const abs = Math.abs(valueMm);
  if (abs < 0.1) return valueMm.toFixed(3);
  if (abs < 10) return valueMm.toFixed(2);
  return valueMm.toFixed(1);
}

export function formatDiameterTicks(minMm, maxMm, { dataMaxMm = null, count = 5 } = {}) {
  const n = Math.max(2, count);
  const ticks = [];
  for (let i = 0; i < n; i += 1) {
    const v = minMm + ((maxMm - minMm) * i) / (n - 1);
    const formatted = formatDiameterValue(v);
    if (i === n - 1) {
      const clippedHigh = Number.isFinite(dataMaxMm) && dataMaxMm > maxMm * 1.02;
      ticks.push(`${clippedHigh ? '≥ ' : ''}${formatted} mm`);
    } else {
      ticks.push(formatted);
    }
  }
  return ticks;
}
