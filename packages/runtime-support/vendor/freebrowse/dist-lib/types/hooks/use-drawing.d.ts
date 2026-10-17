import NiiVue from "@niivue/niivue";
/**
 * Core pen-drawing handlers (Phase 4a). Hybrid store/command model:
 *  - Event-mirrored fields (opacity, penFill, colormap, enabled): handlers issue
 *    nv.* commands only; the event adapter maps the resulting events into
 *    drawingOptions. `enabled` follows drawingChanged (a drawing layer exists),
 *    NOT drawIsEnabled (pointer painting) — `mode` is FreeBrowse's abstraction
 *    over drawIsEnabled.
 *  - Store-owned fields (mode, penErases, penValue): handlers set the store AND
 *    drive niivue as a derived value (drawPenValue = penErases ? 0 : penValue),
 *    which the adapter does NOT mirror back (mirroring would clobber penValue on
 *    erase). Magic-wand params stay store-owned for 4c.
 */
export declare function useDrawing(nvRef: React.RefObject<NiiVue | null>, debouncedGLUpdate: () => void): {
    handleCreateDrawingLayer: () => void;
    handleDrawingColormapChange: (event: React.ChangeEvent<HTMLSelectElement>) => void;
    handleDrawModeChange: (mode: "none" | "pen" | "wand") => void;
    handlePenFillChange: (checked: boolean) => void;
    handlePenErasesChange: (checked: boolean) => void;
    handlePenValueChange: (value: number) => void;
    handleDrawingOpacityChange: (opacity: number) => void;
    handleMagicWand2dOnlyChange: (checked: boolean) => void;
    handleMagicWandMaxDistanceChange: (value: number) => void;
    handleMagicWandThresholdChange: (value: number) => void;
    handleDrawUndo: () => void;
    handleSaveDrawing: () => Promise<void>;
};
