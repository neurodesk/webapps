import type { NiiVue } from "@niivue/niivue";
/**
 * Built-in colormaps that are categorical/label maps (as opposed to continuous
 * gradients). When one of these is selected, FreeBrowse applies it as a label
 * colormap (setColormapLabel) so the volume renders as discrete regions.
 * niivue-mono does not tag colormaps as label-vs-continuous, so this list is
 * curated here; matched case-insensitively against nv.colormaps. Only palettes
 * we've made opaque (alpha 255) are included — random/nih still ship alpha 64
 * and would wash out, so they're excluded pending the Phase-7 systemic fix.
 */
export declare const LABEL_COLORMAPS: Set<string>;
/**
 * After a document loads, attach the label LUT to every volume whose
 * `colormap` names a categorical palette but that carries no `colormapLabel`.
 *
 * niivue-mono applies a document's `colormap` as a continuous gradient
 * (niivue/mono#69), so a migrated legacy scene -- `aseg` with `Freesurfer`,
 * say -- would render as a smooth ramp. A document the app itself saved after
 * a dropdown change already embeds `colormapLabel` and is left alone. Same
 * dual call as `handleColormapChange`.
 */
export declare function applyLabelColormapsAfterLoad(nv: NiiVue): Promise<void>;
export declare function useVolumes(nvRef: React.RefObject<NiiVue | null>, debouncedGLUpdate: () => void, removeSurface: (surfaceIndex: number) => void): {
    getVolumes: () => import("@niivue/niivue").NVImage[];
    toggleImageVisibility: (id: string) => void;
    handleOpacityChange: (newOpacity: number) => void;
    handleFrameChange: (newFrame: number) => void;
    handleContrastMinChange: (newContrastMin: number) => void;
    handleContrastMaxChange: (newContrastMax: number) => void;
    handleColormapChange: (event: React.ChangeEvent<HTMLSelectElement>) => void;
    handleMoveVolumeUp: () => void;
    handleMoveVolumeDown: () => void;
    removeVolume: (imageIndex: number) => void;
    handleRemoveVolumeClick: (imageIndex: number) => void;
    handleEditVolume: (imageIndex: number) => Promise<void>;
    canEditVolume: (imageIndex: number) => boolean;
    handleConfirmRemove: () => void;
    handleCancelRemove: () => void;
};
