import NiiVue from "@niivue/niivue";
interface DrawingTabProps {
    nvRef: React.RefObject<NiiVue | null>;
    onDrawModeChange: (mode: "none" | "pen" | "wand") => void;
    onDrawingColormapChange: (event: React.ChangeEvent<HTMLSelectElement>) => void;
    onPenFillChange: (checked: boolean) => void;
    onPenErasesChange: (checked: boolean) => void;
    onPenValueChange: (value: number) => void;
    onDrawingOpacityChange: (value: number) => void;
    onMagicWand2dOnlyChange: (checked: boolean) => void;
    onMagicWandMaxDistanceChange: (value: number) => void;
    onMagicWandThresholdChange: (value: number) => void;
    onDrawUndo: () => void;
    onSaveDrawing: () => void;
}
export default function DrawingTab({ nvRef, onDrawModeChange, onDrawingColormapChange, onPenFillChange, onPenErasesChange, onPenValueChange, onDrawingOpacityChange, onMagicWand2dOnlyChange, onMagicWandMaxDistanceChange, onMagicWandThresholdChange, onDrawUndo, onSaveDrawing, }: DrawingTabProps): import("react/jsx-runtime").JSX.Element;
export {};
