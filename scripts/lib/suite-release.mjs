// The release naming of the desktop suites. Shared by the standalone catalog
// (scripts/lib/standalone.mjs) and the catalog importer
// (scripts/lib/standalone-import.mjs), which runs without installed packages, so
// this module imports nothing.

// The full suite: every app, released as webapps-vVERSION with the catalog's
// `suite` record. A catalogue edition releases as webapps-<catalogue>-vVERSION
// with its record under `suites.<catalogue>`.
export const SUITE_ID = 'webapps';

/** The release id (tag prefix and archive stem) of a catalogue's desktop suite. */
export function suiteReleaseId(catalogId, primary) {
  return primary ? SUITE_ID : `${SUITE_ID}-${catalogId}`;
}

/**
 * Where a suite release's record lives in the standalone catalog: `['suite']`
 * for the full suite, `['suites', '<catalogue>']` for an edition, or null when
 * the release id names an app.
 */
export function suiteRecordPath(releaseId) {
  if (releaseId === SUITE_ID) return ['suite'];
  if (releaseId.startsWith(`${SUITE_ID}-`)) return ['suites', releaseId.slice(SUITE_ID.length + 1)];
  return null;
}
