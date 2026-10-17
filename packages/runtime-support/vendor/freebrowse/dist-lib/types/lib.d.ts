/**
 * `freebrowse` — framework-agnostic entry. React is bundled; the host only
 * needs `@niivue/niivue` (peer) and `import "freebrowse/style.css"`.
 *
 *   import { NiiVue } from "@niivue/niivue";
 *   import { mountFreeBrowse } from "freebrowse";
 *   import "freebrowse/style.css";
 *   const nv = new NiiVue();
 *   const fb = mountFreeBrowse(document.getElementById("viewer"), { nv });
 *   await nv.addVolume({ url: "..." });   // the FreeBrowse UI follows
 *   fb.destroy();
 */
export { mountFreeBrowse } from "./mount.js";
export type { MountOptions, FreeBrowseHandle } from "./mount.js";
export { createFreeBrowseInstance, DEFAULT_NIIVUE_OPTIONS, } from "./lib/default-niivue-options.js";
export { configureFreeBrowse, getFreeBrowseConfig, type FreeBrowseBackend, type FreeBrowseConfig, } from "./lib/deployment-config.js";
