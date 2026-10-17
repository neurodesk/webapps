import type { ViewerOptions } from "./types.js";
import type { NiiVueEventSource, NiiVueSyncTarget } from "./niivue-sync";
/**
 * Concrete NiiVueSyncTarget backed by the FreeBrowse Zustand store.
 *
 * This is the adapter that makes the store a *derived view* of niivue state:
 * `registerNiiVueEvents(nv, createStoreSyncTarget(nv))` routes every relevant
 * niivue event into the store, translating niivue-mono property names/values
 * into FreeBrowse's store shape. Because both FreeBrowse's own command wrappers
 * and external callers (e.g. `window.freebrowse.nv`) drive niivue through the
 * same events, the UI follows either path identically.
 *
 * The volume/surface UI reads live `nv.volumes`/`nv.meshes` and re-renders on a
 * version-counter bump, so those events bump the counter rather than mirroring
 * a list into the store. Viewer options and location are mirrored into store
 * slices.
 */
/** niivue reader surface this adapter needs beyond the event target. */
export type NiiVueReader = NiiVueEventSource & {
    sliceType: number;
    showRender: number;
    crosshairWidth?: number;
    crosshairGap?: number;
    crosshairColor?: number[];
    rulerWidth?: number;
    isRulerVisible?: boolean;
    volumeIsNearestInterpolation?: boolean;
    volumeOutlineWidth?: number;
    isColorbarVisible?: boolean;
    isRadiological?: boolean;
    secondaryDragMode?: number;
};
/**
 * Read the instance's current settings as a viewerOptions patch — the
 * nv -> store direction, for seeding the store from an instance the host
 * built (so FreeBrowse never pushes its own defaults onto it). Only settings
 * the instance actually reports (not undefined) are included, so a partial
 * reader (or the test mock) leaves the rest of the store alone.
 */
export declare function readViewerFromNiiVue(nv: NiiVueReader): Partial<ViewerOptions>;
export declare function createStoreSyncTarget(nv: NiiVueReader): NiiVueSyncTarget;
