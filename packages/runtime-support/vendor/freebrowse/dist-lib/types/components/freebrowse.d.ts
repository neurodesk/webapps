import type { NiiVue } from "@niivue/niivue";
export interface FreeBrowseProps {
    /**
     * The NiiVue instance this UI reflects and drives. The app creates it with
     * `createFreeBrowseInstance()` (`lib/default-niivue-options.ts`); an
     * embedding host may pass its own.
     */
    nv: NiiVue;
    /**
     * Publish the instance as `window.freebrowse.nv` for external callers
     * (console, embedding pages). Defaults to the configured `exposeGlobal`
     * (app: true; library: false).
     */
    exposeGlobal?: boolean;
    /**
     * The instance belongs to the host: FreeBrowse must not push its stored
     * viewer defaults (view mode, crosshair, ruler, …) onto it. The store is
     * seeded FROM the instance instead. Default false (the app owns its instance).
     */
    hostInstance?: boolean;
    /**
     * Allow loading by drag-and-drop (niivue's canvas drop and FreeBrowse's
     * drop zone). `false` also skips the drop zone: the canvas is shown from
     * the start, since the host is expected to load data itself. Default true.
     */
    dragDrop?: boolean;
    /** Show the sidebar initially (the header button still toggles it). Default true. */
    sidebar?: boolean;
    /** Show the footer (coordinate readout) initially. Default true. */
    footer?: boolean;
}
export default function FreeBrowse({ nv, exposeGlobal, hostInstance, dragDrop, sidebar, footer, }: FreeBrowseProps): import("react/jsx-runtime").JSX.Element;
