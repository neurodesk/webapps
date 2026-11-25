// DOM-independent app config, re-exported from @neurodesk/structure-tensor.
import automation from "../automation.json" with { type: "json" };
import packageJson from "../package.json" with { type: "json" };

export const APP = Object.freeze({
  id: "structure-tensor",
  title: automation.title,
  version: packageJson.version,
});

export * from "@neurodesk/structure-tensor/settings";
