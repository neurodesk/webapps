// DOM-independent settings: identity plus shared validation & output names from @neurodesk/lightsheet-atlas.
import automation from "../automation.json" with { type: "json" };

export {
  DETECTION_FIELDS,
  EXAMPLE_SETTINGS,
  outputNames,
  runSettings,
} from "@neurodesk/lightsheet-atlas/config";

export const APP = Object.freeze({
  id: "lightsheet-atlas",
  title: automation.title,
});
