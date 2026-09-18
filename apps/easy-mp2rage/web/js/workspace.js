import { mountImagingWorkspace } from "../vendor/webapp-components/src/core/mountImagingWorkspace.js";
import {
  bindInfoTooltips,
  createInfoDialog,
  renderConsole,
  renderFileField,
  renderViewerToolbar,
} from "../vendor/webapp-components/src/ui/index.js";

const $ = (selector) => document.querySelector(selector);
mountImagingWorkspace({
  controls: "#controls",
  viewer: "#viewer",
  status: "#status",
  title: "Easy MP2RAGE T1 Map",
  controlsContract: { privacy: "#privacyButton" },
});

export const fileField = renderFileField({
  id: "file",
  rootId: "drop",
  text: "Drop NIfTI or DICOM files or folders",
});
$("#fileControl").append(fileField.root);
const colormap = document.createElement("select");
colormap.id = "cmapSel";
colormap.className = "nd-colormap-select";
colormap.setAttribute("aria-label", "Colormap");
for (const name of ["viridis", "gray", "hot", "plasma"]) {
  colormap.add(new Option(name, name));
}
const toolbar = renderViewerToolbar({
  views: [{ id: "multiplanar", label: "3-Plane", active: true }],
  window: false,
  overlay: false,
  colormap: false,
  download: false,
  screenshot: false,
  actions: [colormap],
});
$("#viewer").prepend(toolbar.root);
export const technicalLog = renderConsole({
  id: "technicalLog",
  outputId: "log",
});
$("#viewer").append(technicalLog.root);
const info = createInfoDialog({ id: "privacyDialog" });
$("#privacyButton").onclick = () => info.open("Privacy", $("#privacyContent"));
bindInfoTooltips();

export function setViewerVisible(visible) {
  $("#viewerWrap").hidden = !visible;
  $("#sliders").hidden = !visible;
  $("#emptyState").hidden = visible;
  if (!visible) {
    $("#viewStat").textContent = "No image selected";
    $("#emptyState").textContent = "Load images or choose an example to begin.";
    $("#histogramPanel").open = false;
  }
}
