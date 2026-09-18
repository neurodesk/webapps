// DOM-independent app config. Kept pure so it can be unit-tested under Node
// without a browser (see test/config.test.js).
export const APP = Object.freeze({
  id: "vessel-surfer",
  version: "0.1.20260918",
});

// The shared leaderboard worker. Override at build time with
// VITE_LEADERBOARD_URL; an empty string keeps scores on this device only.
export const LEADERBOARD_URL =
  import.meta.env?.VITE_LEADERBOARD_URL ??
  "https://vessel-surfer-leaderboard.neurodesk.workers.dev";
