// @neurodesk/analytics
// Typed telemetry ALLOW-LIST for patient-data neuroimaging apps.
// Only declared events/props with VALIDATED VALUES ever leave the browser, and only
// when telemetry is enabled (consent + Do-Not-Track respected). GA4 is not even loaded
// when telemetry is off.

const MAX_STRING = 32;

/** Event names are a fixed enum — no free-text event names. */
export const EVENTS = Object.freeze([
  "app_loaded",
  "file_selected",
  "inference_started",
  "inference_succeeded",
  "inference_failed",
  "result_downloaded",
]);

/** Enumerated string props: value must be exactly one of these. */
const ENUMS = Object.freeze({
  duration_bucket: ["<1s", "1-5s", "5-30s", ">30s"],
  browser_class: ["chromium", "firefox", "safari", "other"],
  os_class: ["windows", "macos", "linux", "other"],
});

/** Per-key validators. A prop is forwarded ONLY if its validator returns true. */
const VALIDATORS = Object.freeze({
  app: (v) => isStr(v) && /^[a-z][a-z0-9-]*$/.test(v),
  app_version: (v) => isStr(v) && /^\d+\.\d+\.\d+([.-][0-9a-z.]+)?$/.test(v),
  duration_bucket: (v) => ENUMS.duration_bucket.includes(v),
  browser_class: (v) => ENUMS.browser_class.includes(v),
  os_class: (v) => ENUMS.os_class.includes(v),
  cross_origin_isolated: (v) => typeof v === "boolean",
  used_gpu: (v) => typeof v === "boolean",
  success: (v) => typeof v === "boolean",
});

function isStr(v) {
  return typeof v === "string" && v.length > 0 && v.length <= MAX_STRING;
}

/**
 * PROHIBITED — never emitted, never logged, no exceptions: filenames, DICOM
 * metadata/tags, image dimensions, voxel values, any scientific measurement or
 * segmentation, screenshots, free-text logs, patient identifiers.
 */
const PROHIBITED_SUBSTRINGS = Object.freeze([
  "filename", "path", "patient", "dicom", "voxel", "dim", "shape",
  "measurement", "metric", "segmentation", "screenshot", "log", "note",
]);

/**
 * Validate keys AND values. Drops any prop that is unknown, prohibited, a
 * non-primitive (object/array/null), or fails its per-key validator. Throws only
 * on an unknown event name (a programming error).
 */
export function sanitize(event, props = {}) {
  if (!EVENTS.includes(event)) throw new Error(`telemetry: unknown event "${event}"`);
  const out = {};
  for (const [k, v] of Object.entries(props)) {
    const key = k.toLowerCase();
    if (PROHIBITED_SUBSTRINGS.some((s) => key.includes(s))) continue; // never forward
    if (!(k in VALIDATORS)) continue; // allow-list only
    // Reject non-primitives outright: no nested objects/arrays/null/functions.
    if (v === null || typeof v === "object" || typeof v === "function") continue;
    if (!VALIDATORS[k](v)) continue; // value failed type/enum/pattern/length check
    out[k] = v;
  }
  return { event, props: out };
}

/** Telemetry is opt-in-safe: off if DNT is set or consent has not been granted. */
export function isTelemetryEnabled() {
  if (typeof navigator !== "undefined" && (navigator.doNotTrack === "1" || navigator.globalPrivacyControl))
    return false;
  if (typeof localStorage !== "undefined")
    return localStorage.getItem("nd:telemetry") === "granted";
  return false;
}

let loaded = false;
/** Load GA4 only when telemetry is enabled — otherwise the tag is never fetched. */
export function initAnalytics(measurementId) {
  if (loaded || !isTelemetryEnabled() || typeof document === "undefined") return;
  loaded = true;
  // ...inject the GA4 tag for `measurementId` here (only reached when enabled).
}

/** Emit an event. No-op when telemetry is disabled; payload is sanitized first. */
export function track(event, props) {
  if (!isTelemetryEnabled()) return null;
  const clean = sanitize(event, props);
  // ...forward `clean` to GA4. Reporting/aggregation happens server-side via an
  // authenticated scheduled workflow (GA4 Data API), never from this static app.
  return clean;
}
