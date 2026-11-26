// DOM-independent app config: identity plus shared validation & provenance from @neurodesk/calcium-imaging.
import automation from "../automation.json" with { type: "json" };
import { provenance as baseProvenance } from "@neurodesk/calcium-imaging/config";

export {
  MAX_MOVIE_BYTES,
  MOTION_LABELS,
  SettingsError,
  checkMovie,
  readSettings,
} from "@neurodesk/calcium-imaging/config";

export const APP = Object.freeze({
  id: "calcium-imaging",
  title: automation.title,
  version: "0.1.20261124",
});

export function provenance(args) {
  return baseProvenance({ ...args, version: APP.version });
}
