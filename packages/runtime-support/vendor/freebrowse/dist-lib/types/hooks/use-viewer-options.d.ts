import { type NiiVue } from "@niivue/niivue";
import type { DragMode } from "../components/drag-mode-selector.js";
import type { ViewMode } from "../store/types.js";
/**
 * Viewer-option handlers. Event-driven model: handlers issue commands to the
 * niivue instance (`nv.*`) and the Zustand store follows via the event adapter
 * (registerNiiVueEvents / createStoreSyncTarget) — handlers do NOT write the
 * store themselves. The single exception is crosshairWidth/crosshairVisible,
 * which is store-owned UI state (niivue has only one crosshairWidth where 0
 * means hidden, so it can't remember the width while hidden).
 *
 * One-time init on mount, chosen by `init` (only the viewer component that owns
 * the mount passes it; other consumers of the handlers leave it at "none"):
 *   - `"apply"` (the app, which built the instance): push the store's viewer
 *     defaults onto the instance once (`applyViewerOptions`).
 *   - `"sync"`  (a host-owned instance): never touch the instance's settings;
 *     seed the store FROM it instead (`syncViewerOptionsFromNiiVue`), so the
 *     UI reflects what the host configured.
 *   - `"none"`  (default): handlers only.
 */
export type ViewerOptionsInit = "apply" | "sync" | "none";
export declare function useViewerOptions(nvRef: React.RefObject<NiiVue | null>, init?: ViewerOptionsInit): {
    viewerOptions: import("../store/types.js").ViewerOptions;
    setViewerOptions: (options: import("../store/types.js").ViewerOptions | ((prev: import("../store/types.js").ViewerOptions) => import("../store/types.js").ViewerOptions)) => void;
    applyViewerOptions: () => void;
    syncViewerOptionsFromNiiVue: () => void;
    debouncedGLUpdate: () => void;
    handleViewMode: (mode: ViewMode) => void;
    handleDragModeChange: (mode: DragMode) => void;
    handleCrosshairWidthChange: (value: number) => void;
    handleCrosshairGapChange: (value: number) => void;
    handleInterpolateVoxelsChange: (checked: boolean) => void;
    handleCrosshairVisibleChange: (visible: boolean) => void;
    handleCrosshairColorChange: (color: string) => void;
    handleRulerWidthChange: (value: number) => void;
    handleRulerVisibleChange: (visible: boolean) => void;
    handleOverlayOutlineWidthChange: (value: number) => void;
    handleColorbarChange: (checked: boolean) => void;
    handleRadiologicalChange: (checked: boolean) => void;
    handleSagittalNoseLeftChange: (checked: boolean) => void;
    resetViewAndContrast: () => void;
};
