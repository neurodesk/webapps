// DOM-independent app config. Kept pure so it can be unit-tested under Node
// without a browser (see test/config.test.js).
export const APP = Object.freeze({
  id: "lcmodel",
  version: "0.5.20261003",
});

/**
 * The simulated basis sets of models/lcmodel.manifest.json, each with its
 * pinned URL and checksum, in the shape basis-select.js ranks.
 */
export function basisLibrary(manifest) {
  const assets = new Map(manifest.assets.map((a) => [a.filename, a]));
  return manifest.basis_sets.map((set) => {
    const asset = assets.get(set.file);
    if (!asset) throw new Error(`basis set ${set.id} has no asset entry`);
    return {
      id: set.id,
      label: set.label,
      sequence: set.sequence,
      hzpppm: set.hzpppm,
      teMs: set.teMs,
      shapedPulses: set.pulses === "shaped",
      coEditedMM: set.coEditedMM === true,
      mmSuppressed: set.mmSuppressed === true,
      library: { url: manifest.base_url + set.file, bytes: asset.bytes, sha256: asset.sha256, label: set.label },
    };
  });
}
