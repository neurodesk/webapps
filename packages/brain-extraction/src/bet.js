export function runBet({ volume, runtime, fractionalIntensity = 0.5, onProgress = () => {} }) {
  const { dims, affine, data } = volume;
  if (dims.length !== 3 || dims.some(value => !Number.isInteger(value) || value < 2) || data.length !== dims.reduce((a, b) => a * b, 1)) {
    throw new Error('BET requires a 3D image with at least two voxels per axis.');
  }
  if (!Number.isFinite(fractionalIntensity) || fractionalIntensity < 0 || fractionalIntensity > 1) {
    throw new Error('BET fractional intensity must be between 0 and 1.');
  }
  const spacing = [0, 1, 2].map(axis => Math.hypot(...affine.slice(0, 3).map(row => row[axis])));
  if (spacing.some(value => !Number.isFinite(value) || value <= 0)) throw new Error('Invalid image voxel spacing.');
  if (data.some(value => !Number.isFinite(value))) throw new Error('Non-finite image intensity.');
  onProgress(0, 'Extracting brain with BET…');
  const extracted = runtime.bet_wasm_with_progress(
    Float64Array.from(data), ...dims, ...spacing, fractionalIntensity, 1, 0, 1000, 4,
    (current, total) => onProgress(total ? current / total : 0, 'Extracting brain with BET…'),
  );
  if (extracted.length !== data.length) throw new Error('BET returned an unexpected mask shape.');
  const mask = Uint8Array.from(extracted, value => value ? 1 : 0);
  if (!mask.some(Boolean)) throw new Error('BET produced an empty mask. Try a lower fractional intensity.');
  const geometry = { dims, affine };
  return {
    brain: { ...geometry, data: Float32Array.from(data, (value, index) => mask[index] ? value : 0) },
    mask: { ...geometry, data: mask },
    provenance: { method: 'BET', implementation: 'QSMbly Rust', fractionalIntensity, spacing, iterations: 1000, subdivisions: 4 },
  };
}
