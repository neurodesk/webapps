import { resolveTaskPlan } from "@neurodesk/totalsegmentator/models";

export const APP = Object.freeze({
  id: "totalsegmentator",
  title: "TotalSegmentator",
  description: "Segment organs, bones and muscles in CT and MRI.",
});

export function formatMegabytes(bytes) {
  return `${Math.round(bytes / 1e6)} MB`;
}

// Short sidebar hint (<= 90 chars) summarizing models and download size for the active selection.
export function describePlan({ task, resolution, subset }) {
  const plan = resolveTaskPlan({ task, resolution, subset });
  const allModels = plan.cropModel ? [plan.cropModel, ...plan.models] : plan.models;
  const totalBytes = allModels.reduce((sum, m) => sum + m.bytes, 0);
  const count = allModels.length;
  const noun = count === 1 ? "model" : "models";
  if (plan.cropModel) {
    return `${count} ${noun} (trunk crop + muscles) · ${formatMegabytes(totalBytes)}, cached locally.`;
  }
  return `${count} ${noun} · ${formatMegabytes(totalBytes)} download, cached locally.`;
}

export function filterReportRows(rows, { group = "all", query = "" } = {}) {
  const q = query.trim().toLowerCase();
  return rows.filter((row) => {
    if (group !== "all" && row.group !== group) return false;
    if (!q) return true;
    return row.name.toLowerCase().includes(q)
      || row.slug.toLowerCase().includes(q)
      || row.groupLabel.toLowerCase().includes(q)
      || String(row.id) === q;
  });
}

export function distinctGroups(rows) {
  const seen = new Map();
  for (const row of rows) {
    if (!seen.has(row.group)) seen.set(row.group, row.groupLabel);
  }
  return [...seen.entries()].map(([id, label]) => ({ id, label }));
}
