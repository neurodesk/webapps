// DOM-independent app config. Re-exports shared model catalog from @neurodesk/stardist/models.
import automation from "../automation.json" with { type: "json" };
import packageJson from "../package.json" with { type: "json" };

export { DEFAULT_MODEL_ID, MODEL, MODEL_IDS, MODELS, resolveModel } from "@neurodesk/stardist/models";

export const APP = Object.freeze({
  id: "stardist",
  title: automation.title,
  version: packageJson.version,
});
