import { gzipSync } from 'node:zlib';
import { syntheticNifti } from '../../../test-utils/nifti-fixture.mjs';

export function analysisFixture(kind, compressed = true) {
  const dims = [32, 32, 40];
  const spacing = [0.8, 0.9, 1.5];
  const bytes = syntheticNifti({ dims, spacing, gzip: false, value(index) {
    const x = index % dims[0];
    const y = Math.floor(index / dims[0]) % dims[1];
    const z = Math.floor(index / (dims[0] * dims[1]));
    const radius = ((x - 16 - 0.04 * (z - 20)) / 5.5) ** 2 + ((y - 16 - 0.015 * (z - 20)) / 4) ** 2;
    if (kind === 'weighted') return Math.max(0, Math.min(1, 4 * (1.1 - radius)));
    if (kind === 'cord') return Number(radius <= 1);
    const first = ((x - 16) / 2) ** 2 + ((y - 16) / 1.7) ** 2 + ((z - 13) / 4) ** 2 <= 1;
    const second = ((x - 15) / 1.3) ** 2 + ((y - 15) / 1.3) ** 2 + ((z - 28) / 2) ** 2 <= 1;
    return Number(radius <= 1 && (first || second));
  } });
  bytes.fill(0, 280, 328);
  spacing.forEach((value, axis) => bytes.writeFloatLE(value, 280 + 20 * axis));
  return compressed ? gzipSync(bytes) : bytes;
}

export const ANALYSIS_CASES = [
  { id: 'morphometry-default', command: 'process_segmentation', roles: { cord: 'cord' }, options: {}, flags: [] },
  { id: 'morphometry-weighted', command: 'process_segmentation', roles: { cord: 'weighted' }, options: { perSlice: true, angleCorrection: false, slices: '5:25,30' }, flags: ['-perslice', '1', '-angle-corr', '0', '-z', '5:25,30'] },
  { id: 'lesion-cord', command: 'analyze_lesion', roles: { lesion: 'lesion', cord: 'cord' }, options: {} },
  { id: 'lesion-only', command: 'analyze_lesion', roles: { lesion: 'lesion' }, options: {} },
  { id: 'lesion-uncompressed', command: 'analyze_lesion', roles: { lesion: 'lesion', cord: 'cord' }, options: {}, compressed: false },
];

