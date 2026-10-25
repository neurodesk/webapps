// BIDS-derivative names and sidecars of the DWI apps (degibbs, dwidenoise, n4, noddi, hmc).
// Each step writes `<source entities>_desc-<step>_<suffix>`: the input's entities without any
// earlier desc- entity, then the step's desc label, then the input's suffix.
// The functions are DOM-free, so the web apps and their command lines write the same names.

/** The BIDS stem and suffix of an image name: sub-01_dwi.nii.gz gives ["sub-01", "dwi"]. */
export function splitName(fileName) {
  const base = fileName.replace(/\.nii(\.gz)?$/i, "");
  const match = base.match(/^(.*)_([A-Za-z0-9]+)$/);
  return match ? [match[1], match[2]] : [base, ""];
}

/** The source entities of an image name: its stem without any desc- entity. */
export function sourceStem(fileName) {
  const [stem] = splitName(fileName);
  return stem
    .split("_")
    .filter((entity) => !entity.startsWith("desc-"))
    .join("_");
}

/**
 * The derivative names of a corrected image and of its passed-through gradient files and sidecar.
 * A name without a suffix keeps none, unless `defaultSuffix` gives one.
 */
export function outputNames(fileName, desc, { defaultSuffix = "" } = {}) {
  if (typeof desc !== "string" || !desc) throw new TypeError("outputNames desc must be a non-empty string");
  const [, nameSuffix] = splitName(fileName);
  const suffix = nameSuffix || defaultSuffix;
  const source = sourceStem(fileName);
  const base = suffix ? `${source}_desc-${desc}_${suffix}` : `${source}_desc-${desc}`;
  return { image: `${base}.nii.gz`, bval: `${base}.bval`, bvec: `${base}.bvec`, sidecar: `${base}.json` };
}

/** The BIDS name of a brain mask: <stem>_desc-brain_mask.nii.gz. */
export function maskName(stem) {
  return `${stem}_desc-brain_mask.nii.gz`;
}

/** The sidecar of a derivative: the input's fields, with the step recorded as Description. */
export function derivativeSidecar(sidecar, description) {
  if (typeof description !== "string" || !description) throw new TypeError("derivativeSidecar description must be a non-empty string");
  return { ...(sidecar ?? {}), Description: description };
}

/** The text of a sidecar: two-space JSON and a final newline. */
export function sidecarText(sidecar) {
  return `${JSON.stringify(sidecar, null, 2)}\n`;
}

/** A gzip-compressed File of the bytes. An aborted signal stops it before and after compression. */
export async function gzipFile(buffer, name, signal) {
  signal?.throwIfAborted();
  const stream = new Blob([buffer]).stream().pipeThrough(new CompressionStream("gzip"));
  const bytes = await new Response(stream).arrayBuffer();
  signal?.throwIfAborted();
  return new File([bytes], name, { type: "application/gzip" });
}
