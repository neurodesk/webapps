// BrowserQC's pipeline, shared by the web app and the browserqc command line:
// a MindGrab brain mask, a MindGrab segmentation, then niimath's MRIQC-style
// `--qc` report. The segmenter (the browser wrapper or the Node CPU driver) and
// niimath are passed in, so both runtimes run these same steps.

import catalog from './models.json' with { type: 'json' };

export const MODELS = catalog;
export const DEFAULT_MODEL = 'mindmap-pve';

export function parseModel(value) {
  if (typeof value === 'string' && Object.hasOwn(MODELS, value)) return value;
  throw new Error(`Choose a supported BrowserQC segmentation model: ${Object.keys(MODELS).join(', ')}.`);
}

// The MNI air template behind the background metrics, pinned by its bytes.
export const AIR_TEMPLATE = Object.freeze({
  name: 'avg152T1.nii.gz',
  url: 'https://huggingface.co/datasets/neurodeskorg/webapps/resolve/12eb1069c34097b7c0881b22e1f7e4ed953aa5cc/browserqc/avg152T1.nii.gz',
  sha256: 'e8f5440f0dcec1a4d44384acbdf19c8e6cf94c032c3356ef91c4441fee3aaea8',
});

export async function sha256Hex(bytes) {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
  return Array.from(digest, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

export async function checkAirTemplate(bytes) {
  const actual = await sha256Hex(bytes);
  if (actual !== AIR_TEMPLATE.sha256) {
    throw new Error(`${AIR_TEMPLATE.name} has SHA-256 ${actual}, not the pinned ${AIR_TEMPLATE.sha256}.`);
  }
  return bytes;
}

/**
 * Runs MindGrab's brain mask, then the model's tissue fractions or labels, on
 * the input's own grid. Outputs are uncompressed NIfTI whatever the input.
 * `segmenter` has @brainchop/mindgrab's `segment` and `segmentTissues`.
 */
export async function segmentForQc(segmenter, input, model, options = {}) {
  const shared = { ...options, gzipOutput: false };
  const brain = await segmenter.segment(input, { ...shared, model: 'mindgrab', mask: true });
  if (!brain.mask) throw new Error('Brain extraction returned no mask.');
  const tissueModel = MODELS[model].pve;
  if (tissueModel) {
    const result = await segmenter.segmentTissues(input, { ...shared, model: tissueModel });
    const { csf, gm, wm } = result.tissues;
    return { kind: 'pve', tissues: { csf, gm, wm }, mask: brain.mask, backend: result.backend, elapsedMs: brain.elapsedMs + result.elapsedMs };
  }
  const result = await segmenter.segment(input, { ...shared, model });
  return { kind: 'labels', image: result.image, mask: brain.mask, backend: result.backend, elapsedMs: brain.elapsedMs + result.elapsedMs };
}

/** The tissues argument of @niivue/niimath's `qc()` for a segmentForQc result. */
export function qcTissues(segmentation, model) {
  if (segmentation.kind === 'pve') {
    const { csf, gm, wm } = segmentation.tissues;
    return { pve: [csf, gm, wm], mask: segmentation.mask };
  }
  const { csf, wm } = MODELS[model];
  return { seg: segmentation.image, csf, wm, mask: segmentation.mask };
}

/** Adds BrowserQC's provenance and the optional BIDS sidecar to niimath's report. */
export function finishReport(report, { model, bids }) {
  if (bids) report.bids_meta = bids;
  report.provenance.segmentation = `brainchop ${model} (${MODELS[model].label})`;
  return report;
}
