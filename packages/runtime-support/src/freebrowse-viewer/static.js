// Entry for the prebuilt bundle that bundler-less apps load from their own
// origin (`scripts/build-freebrowse-viewer.mjs`). It carries the NiiVue build
// FreeBrowse is pinned to, so a static app never mixes two NiiVue versions.
export { mountViewer } from './index.js';
export { NiiVue, SLICE_TYPE, SHOW_RENDER, DRAG_MODE } from '@niivue/niivue';
