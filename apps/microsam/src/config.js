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

function asset(role) {
  const entry = manifest.assets.find((item) => item.role === role);
  return Object.freeze({ url: manifest.base_url + entry.filename, bytes: entry.bytes, sha256: entry.sha256, filename: entry.filename });
}

export const MODEL = Object.freeze({
  name: manifest.model.name,
  encoder: asset("encoder"),
  decoder: asset("decoder"),
});
