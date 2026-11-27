// DOM-independent app configuration and helpers for BrkRaw.
import { AFFINE_SPACES, SUBJECT_POSES, SUBJECT_TYPES } from "@neurodesk/brkraw/affine";

export const APP = Object.freeze({
  id: "brkraw",
  title: "BrkRaw",
});

export function normalizeSpace(value) {
  return AFFINE_SPACES.includes(value) ? value : "subject_ras";
}

export function normalizeSubjectType(value) {
  if (!value || value === "auto") return "";
  return SUBJECT_TYPES.includes(value) ? value : "";
}

export function normalizeSubjectPose(value) {
  if (!value || value === "auto") return "";
  return SUBJECT_POSES.includes(value) ? value : "";
}

export function recoKey(scanId, recoId) {
  return `${scanId}:${recoId}`;
}

export function parseRecoKey(key) {
  const [scanStr, recoStr] = String(key || "").split(":");
  const scanId = Number.parseInt(scanStr, 10);
  const recoId = Number.parseInt(recoStr, 10);
  if (!Number.isFinite(scanId) || !Number.isFinite(recoId)) return null;
  return { scanId, recoId };
}

/**
 * Choose the best default reconstruction when a Bruker study loads:
 * prefers the first convertible single-pack anatomical multi-slice or 3D scan
 * over a 1-slice localizer, falling back to the first convertible reco.
 */
export function defaultRecoOf(summary) {
  const recos = (summary?.scans ?? []).flatMap((s) => s.recos).filter((r) => r.convertible);
  if (!recos.length) return null;
  const preferred = recos.find(
    (r) => r.numSlicePacks === 1 && (r.dim === 3 || (r.numSlices?.[0] ?? 0) > 1) && !/localizer|pilot/i.test(r.protocol),
  );
  return preferred ?? recos.find((r) => r.numSlicePacks === 1 && (r.shape?.[2] ?? 0) > 1) ?? recos[0];
}

export function scanOptionLabel(reco) {
  const dims = reco.shape?.length ? reco.shape.join("×") : "?";
  const packs = reco.numSlicePacks > 1 ? `, ${reco.numSlicePacks} packs` : "";
  const method = reco.methodName ? reco.methodName.replace(/^Bruker:/i, "") : "";
  const suffix = reco.convertible
    ? ""
    : reco.exceedsLimit
      ? " [exceeds 1 GiB limit]"
      : " [unsupported]";
  return `Scan ${reco.scanId} · Reco ${reco.recoId} — ${reco.protocol} (${dims}${packs}${method ? `, ${method}` : ""})${suffix}`;
}

export function scanMetaSummary(reco) {
  const dims = reco.shape?.join(" × ") || "?";
  const vox = reco.zooms?.length ? `${reco.zooms.slice(0, 3).map((v) => v.toFixed(3)).join(" × ")} mm` : "";
  const timing = [
    reco.trMs ? `TR ${Number(reco.trMs).toFixed(0)} ms` : null,
    reco.teMs ? `TE ${Number(reco.teMs).toFixed(1)} ms` : null,
  ].filter(Boolean).join(" · ");
  return [dims, vox, timing].filter(Boolean).join(" · ");
}

/**
 * Privacy-safe output filename stem: intentionally omits the study folder/archive name
 * because ParaVision study folders commonly encode acquisition dates and subject IDs.
 */
export function outputStem({ scanId, recoId, slicePackIndex = 0, slicePackCount = 1 }) {
  const base = `scan${scanId}_reco${recoId}`;
  return slicePackCount > 1 ? `${base}_pack${slicePackIndex}` : base;
}
