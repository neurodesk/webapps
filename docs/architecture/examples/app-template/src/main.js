// Scaffolded entry point. Imports the SHARED library by package name (resolved via
// pnpm workspace) — NOT a relative ../../src path — so the copy is self-contained.
import "@neurodesk/webapp-components/styles/base.css"; // shared base styles
import { createNeuroWebapp } from "@neurodesk/webapp-components";
import { initAnalytics, track } from "@neurodesk/analytics";
import { APP } from "./config.js";

// createNeuroWebapp owns the shared UI: use the instance's progress/console rather
// than constructing our own (the factory creates and returns them).
const app = createNeuroWebapp({ root: document.getElementById("app") });
app.progress.reset();
app.console.log(`${APP.id} ready`);

// App-specific scientific worker, metric renderers, and pipeline definitions live in
// THIS app (see src/worker/, src/metrics/), not in the shared library. Wire them here.

initAnalytics(APP.ga4MeasurementId); // no-ops unless telemetry is enabled (consent + DNT)
track("app_loaded", { app: APP.id, app_version: APP.version });

export default app;
