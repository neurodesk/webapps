import type { NiiVue } from "@niivue/niivue";
import { type FreeBrowseBackend } from "./lib/deployment-config.js";
export interface MountOptions {
    /**
     * The NiiVue instance to show. When given, the host owns it: FreeBrowse
     * seeds its UI from the instance's current settings and never pushes its
     * own defaults onto it. When omitted, FreeBrowse creates one with
     * `createFreeBrowseInstance()` and applies its defaults.
     */
    nv?: NiiVue;
    /**
     * Backend endpoints for Save-to-server, the Data/NVD tabs and AI sessions.
     * Omitted (or `null`): no backend — those features are hidden.
     */
    backend?: FreeBrowseBackend | null;
    /** localStorage key for user preferences (default `freebrowse-user-settings`), or `false` to keep them in memory. */
    persist?: string | false;
    /** Read `?nvd=` / `?vol=` from the host page URL on startup. Default false. */
    readUrlParams?: boolean;
    /** Also publish the instance as `window.freebrowse.nv`. Default false. */
    exposeGlobal?: boolean;
    /** Disable the Download button and niivue's save-to-disk methods. Default false. */
    downloadDisabled?: boolean;
    /**
     * Allow loading by drag-and-drop (niivue's canvas drop and FreeBrowse's
     * drop zone). `false` also skips the drop zone and shows the canvas from
     * the start, for hosts that load data themselves. Default true.
     */
    dragDrop?: boolean;
    /** Show the sidebar initially (the header button still toggles it). Default true. */
    sidebar?: boolean;
    /** Show the footer (coordinate readout) initially. Default true. */
    footer?: boolean;
}
export interface FreeBrowseHandle {
    /** The instance FreeBrowse is showing (the one passed in, or the one it created). */
    nv: NiiVue;
    /** Unmount the UI and detach FreeBrowse's event listeners from the instance. */
    destroy(): void;
}
/**
 * Mount the FreeBrowse UI into `container` and return a handle.
 *
 * One mount at a time: FreeBrowse's UI state is a single store, so a second
 * concurrent mount throws. Call `destroy()` on the previous handle first.
 *
 * Styles are not injected — import `freebrowse/style.css` once in the host.
 */
export declare function mountFreeBrowse(container: HTMLElement, options?: MountOptions): FreeBrowseHandle;
