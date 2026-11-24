// DOM-independent app configuration for MedSAM2.
import automation from "../automation.json" with { type: "json" };
import manifest from "../../../models/medsam2.manifest.json" with { type: "json" };
import packageJson from "../package.json" with { type: "json" };

export const APP = Object.freeze({
  id: "medsam2",
  title: automation.title,
  version: packageJson.version,
});

function asset(role) {
  const entry = manifest.assets.find((item) => item.role === role);
  if (!entry) throw new Error(`Missing ${role} asset in models/medsam2.manifest.json.`);
  const url = entry.url ?? `${manifest.base_url}${entry.filename}`;
  return Object.freeze({ url, bytes: entry.bytes, sha256: entry.sha256, filename: entry.filename });
}

export const MODEL = Object.freeze({
  name: manifest.model.name,
  imageSize: manifest.model.image_size,
  numMaskmem: manifest.model.num_maskmem,
  maxObjPtrs: manifest.model.max_obj_ptrs,
  imageEncoder: asset("image_encoder"),
  maskDecoder: asset("mask_decoder"),
  memoryEncoder: asset("memory_encoder"),
  memoryAttention: asset("memory_attention"),
});

export const WINDOW_PRESETS = Object.freeze([
  Object.freeze({ id: "auto", label: "Auto (0.5–99.5% MRI)", range: null }),
  Object.freeze({ id: "ct-soft", label: "CT soft tissue (−160 to 240 HU)", range: Object.freeze([-160, 240]) }),
  Object.freeze({ id: "ct-lung", label: "CT lung (−1000 to 400 HU)", range: Object.freeze([-1000, 400]) }),
  Object.freeze({ id: "ct-bone", label: "CT bone (−400 to 1000 HU)", range: Object.freeze([-400, 1000]) }),
  Object.freeze({ id: "ct-brain", label: "CT brain (0 to 80 HU)", range: Object.freeze([0, 80]) }),
  Object.freeze({ id: "full", label: "Full intensity range", range: null }),
]);

export const AXES = Object.freeze(["axial", "coronal", "sagittal"]);
