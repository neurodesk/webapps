// DOM-independent app config: identity plus shared input/settings helpers from @neurodesk/histo2mri.
import automation from "../automation.json" with { type: "json" };

export {
  SECTION_OUTPUT_KINDS,
  classifyFiles,
  outputNames,
  runSettings,
  runSummary,
  workerVolume,
} from "@neurodesk/histo2mri/config";

export const APP = Object.freeze({
  id: "histo2mri",
  title: automation.title,
  version: "0.1.20261124",
});
