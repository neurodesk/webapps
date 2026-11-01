// The visible line under the marker table stays within the 90-character help limit; the run's
// configuration goes into an info tooltip beside it.
export function detectionsHint(det) {
  const networks = det.folds.length === 5
    ? '5-network ensemble'
    : `network${det.folds.length > 1 ? 's' : ''} ${det.folds.map((f) => Number(f) + 1).join(', ')} of 5`;
  const backend = { webgpu: 'WebGPU', wasm: 'WebAssembly' }[det.backend] || det.backend;
  const details = `Inference: ${networks}, mirroring ${det.mirror ? 'on' : 'off'}, ${backend}, ${det.timing.total.toFixed(0)} s.`;
  if (det.edited) return { text: 'From the edited mask.', details };
  const next = det.others.length ? `Next candidate p ${det.others[0].meanProb.toFixed(3)}.` : 'No further candidates.';
  return { text: next, details };
}
