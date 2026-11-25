// DOM-independent app config: identity plus shared settings from @neurodesk/stitching.
import automation from "../automation.json" with { type: "json" };

export {
  DEFAULT_VALUES,
  LAYOUTS,
  MAX_FUSED_PIXELS,
  MAX_TILE_BYTES,
  SettingsError,
  guessGrid,
  readSettings,
} from "@neurodesk/stitching/config";

export const APP = Object.freeze({
  id: "stitching",
  title: automation.title,
  version: "0.2.20261124",
});
