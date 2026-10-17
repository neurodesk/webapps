interface AiAnnotationTabProps {
    volumesCount: number;
    onNewSession: (sessionName: string) => Promise<void>;
    onLoadSession: (sessionId: string) => Promise<void>;
    onRunSegmentation: (mlId: string, labelValue: number) => Promise<void>;
    onExitAndSaveSession: () => Promise<void>;
    onExitAndDeleteSession: () => Promise<void>;
    onRefreshSessions: () => Promise<void>;
    onDrawModeChange: (mode: "none" | "pen" | "wand") => void;
    onDrawingOpacityChange: (value: number) => void;
    onPenValueChange: (value: number) => void;
    onPenFillChange: (checked: boolean) => void;
    onPenErasesChange: (checked: boolean) => void;
    onMagicWand2dOnlyChange: (checked: boolean) => void;
    onMagicWandMaxDistanceChange: (value: number) => void;
    onMagicWandThresholdChange: (value: number) => void;
    onDrawUndo: () => void;
}
export default function AiAnnotationTab({ volumesCount, onNewSession, onLoadSession, onRunSegmentation, onExitAndSaveSession, onExitAndDeleteSession, onRefreshSessions, onDrawModeChange, onDrawingOpacityChange, onPenValueChange, onPenFillChange, onPenErasesChange, onMagicWand2dOnlyChange, onMagicWandMaxDistanceChange, onMagicWandThresholdChange, onDrawUndo, }: AiAnnotationTabProps): import("react/jsx-runtime").JSX.Element;
export {};
