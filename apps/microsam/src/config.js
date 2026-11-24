// DOM-independent app config. Kept pure so it can be unit-tested under Node
// without a browser (see test/config.test.js).
import automation from "../automation.json" with { type: "json" };
import manifest from "../../../models/microsam.manifest.json" with { type: "json" };
import packageJson from "../package.json" with { type: "json" };

export const APP = Object.freeze({
  id: "microsam",
  title: automation.title,
  version: packageJson.version,
});

function asset(modelId, role) {
  const entry = manifest.assets.find((item) => (item.model ?? manifest.model.name) === modelId && item.role === role);
  if (!entry) throw new Error(`Missing ${role} asset for micro-sam model ${modelId}.`);
  const url = entry.url ?? `${manifest.base_url}${entry.filename}`;
  return Object.freeze({ url, bytes: entry.bytes, sha256: entry.sha256, filename: entry.filename });
}

export const MODELS = Object.freeze(
  Object.entries(manifest.models).map(([id, info]) => Object.freeze({
    id,
    name: id,
    label: info.label,
    encoder: asset(id, "encoder"),
    decoder: asset(id, "decoder"),
  })),
);

export const DEFAULT_MODEL_ID = manifest.model.name;

export function modelById(id = DEFAULT_MODEL_ID) {
  const found = MODELS.find((item) => item.id === id);
  if (!found) throw new Error(`Unknown micro-sam model "${id}". Expected one of: ${MODELS.map((item) => item.id).join(", ")}.`);
  return found;
}

export const MODEL = modelById(DEFAULT_MODEL_ID);
