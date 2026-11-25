// DOM-independent app config: identity plus shared settings & provenance from @neurodesk/microscope-qc.
import automation from "../automation.json" with { type: "json" };
import { provenance as baseProvenance } from "@neurodesk/microscope-qc/config";

export {
  ANALYSES,
  MAX_FILE_BYTES,
  MAX_PEAK_BYTES,
  SettingsError,
  boxHalfWidth,
  checkFileSize,
  checkStack,
  peakBytes,
  readSettings,
  saturationLevel,
  suggestedAnalysis,
} from "@neurodesk/microscope-qc/config";

export const APP = Object.freeze({
  id: "microscope-qc",
  title: automation.title,
  version: "0.1.20261124",
});

export function provenance(args) {
  return baseProvenance({ ...args, version: APP.version });
}
