// DOM-independent settings, names and provenance, re-exported from @neurodesk/spot-detection.
import automation from "../automation.json" with { type: "json" };

export const APP = Object.freeze({
  id: "spot-detection",
  title: automation.title,
});

export * from "@neurodesk/spot-detection/settings";
