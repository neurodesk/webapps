/**
 * `freebrowse/react` — for hosts that already render React 19: the component
 * itself (React and ReactDOM are peer dependencies on this entry, not bundled).
 * Configure once with `configureFreeBrowse` before the first render, and import
 * `freebrowse/style.css` in the host.
 */
export { default as FreeBrowse } from "./components/freebrowse.js";
export type { FreeBrowseProps } from "./components/freebrowse.js";
export { configureFreeBrowse, getFreeBrowseConfig, type FreeBrowseBackend, type FreeBrowseConfig, } from "./lib/deployment-config.js";
export { createFreeBrowseInstance, DEFAULT_NIIVUE_OPTIONS, } from "./lib/default-niivue-options.js";
