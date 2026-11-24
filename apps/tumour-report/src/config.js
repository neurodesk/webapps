// Pure configuration, label styling and report formatting for Brain Tumour Report.
// No DOM imports so unit tests can run directly in Node.js.
import { TUMOUR_TYPES } from "@neurodesk/tumour-report/models";

export const APP = Object.freeze({
  id: "tumour-report",
  title: "Brain Tumour Report",
});

export const TUMOUR_TYPE_LABELS = Object.freeze(
  Object.fromEntries(TUMOUR_TYPES.map(({ id, label }) => [id, label])),
);

export function modeHint({ hasT1c, hasMask, computeMniReport, skullStripped }) {
  if (!hasT1c) return "Load a native-space post-contrast T1 scan.";
  if (hasMask) {
    return computeMniReport
      ? "Supplied mask mode · native morphometry + MNI report."
      : "Supplied mask mode · native morphometry only.";
  }
  const steps = [skullStripped ? "skull-stripped T1c" : "brain + tumour segmentation"];
  if (computeMniReport) steps.push("MNI report");
  return `Ready · ${steps.join(" + ")}.`;
}

export function runButtonLabel({ hasMask }) {
  return hasMask ? "Characterize mask" : "Segment & characterize";
}

export function tumourColormap() {
  return {
    R: [0, 224],
    G: [0, 62],
    B: [0, 62],
    A: [0, 255],
    labels: ["Background", "Tumour core"],
  };
}

export function brainColormap() {
  return {
    R: [0, 56],
    G: [0, 178],
    B: [0, 172],
    A: [0, 160],
    labels: ["Background", "Brain mask"],
  };
}

export function formatRegionName(raw) {
  if (!raw) return "";
  const cleaned = String(raw).replace(/_+$/, "");
  const match = cleaned.match(/^(.*)_(left|right)$/i);
  const side = match ? (match[2].toLowerCase() === "left" ? " (L)" : " (R)") : "";
  const base = (match ? match[1] : cleaned).replace(/[_-]+/g, " ").trim();
  if (!base) return cleaned;
  return `${base.charAt(0).toUpperCase()}${base.slice(1)}${side}`;
}

export function formatTractName(raw) {
  if (!raw) return "";
  const cleaned = String(raw).replace(/_+$/, "");
  const match = cleaned.match(/^(.*)_(L|R|left|right)$/i);
  let side = "";
  let base = cleaned;
  if (match) {
    side = match[2].toLowerCase().startsWith("l") ? " (L)" : " (R)";
    base = match[1];
  }
  return `${base.replace(/_/g, " ").trim()}${side}`;
}

export function statusSummary(report) {
  const m = report?.morphometry;
  if (!m) return "Report ready";
  if (m.lesionCount === 0) return "Report ready · No lesions segmented";
  const count = `${m.lesionCount} ${m.lesionCount === 1 ? "lesion" : "lesions"}`;
  return `Report ready · ${count} · ${m.totalVolumeMl.toFixed(1)} mL`;
}

export function geometryMatches(a, b, toleranceMm = 0.05) {
  if (!a?.dims || !b?.dims || a.dims.length !== 3 || b.dims.length !== 3) return false;
  for (let i = 0; i < 3; i++) {
    if (a.dims[i] !== b.dims[i]) return false;
  }
  if (a.spacingMm && b.spacingMm) {
    for (let i = 0; i < 3; i++) {
      if (Math.abs(a.spacingMm[i] - b.spacingMm[i]) > toleranceMm) return false;
    }
  }
  return true;
}
