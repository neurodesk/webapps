import { NiiVue, type NiiVueOptions, type SettingsSavePolicy } from "@niivue/niivue";
/**
 * The options FreeBrowse constructs its NiiVue instance with. Shared by the
 * app entry (`main.tsx`) and the library (`createFreeBrowseInstance`) so both
 * produce identical instances. No `backend` option: niivue picks WebGPU when
 * `navigator.gpu` exists and falls back to WebGL2 otherwise.
 */
export declare const DEFAULT_NIIVUE_OPTIONS: Partial<NiiVueOptions>;
/** Overrides the QA route applies on top of the defaults. */
export declare const QA_VIEWER_NIIVUE_OPTIONS: Partial<NiiVueOptions>;
/**
 * Settings policy for every document FreeBrowse saves.
 *
 * `volume.matcap` is omitted: niivue-mono applies its bundled `cortex` matcap
 * to every instance but declares the default as `''`, so the sparsifier can
 * never elide it and each saved document carries the matcap as a ~23 KB
 * `data:image/jpeg;base64,…` URL -- 88% of a typical FreeBrowse save
 * (niivue/mono#225). FreeBrowse exposes no matcap UI, so nothing a user chose
 * is lost; on load an omitted matcap falls back to the instance's own. Remove
 * once #225 is fixed upstream.
 */
export declare const FREEBROWSE_SAVE_SETTINGS: SettingsSavePolicy;
/**
 * Build a NiiVue instance the way FreeBrowse does. A host that wants FreeBrowse
 * to own the instance calls this (or lets `mountFreeBrowse` call it); a host
 * that already has an instance passes its own instead.
 */
export declare function createFreeBrowseInstance(overrides?: Partial<NiiVueOptions>): NiiVue;
