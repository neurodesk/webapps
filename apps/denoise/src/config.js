// DOM-independent app configuration: identity plus re-exports from @neurodesk/denoise/format.
import automation from "../automation.json" with { type: "json" };

export {
  assertValidDims,
  outputNames,
  provenance,
  resolvedSpacingUm,
  stackNifti,
  stackTiff,
  stem,
} from "@neurodesk/denoise/format";

export const APP = Object.freeze({
  id: "denoise",
  title: automation.title,
});
