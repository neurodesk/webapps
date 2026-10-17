import type { NiiVue, NVImage } from "@niivue/niivue";
interface SceneDetailsTabProps {
    nvRef: React.RefObject<NiiVue | null>;
    serverlessMode: boolean;
    getVolumes: () => NVImage[];
    onToggleVisibility: (id: string) => void;
    onEditVolume: (index: number) => void;
    canEditVolume: (index: number) => boolean;
    onRemoveVolume: (index: number) => void;
    onAddMoreFiles: () => void;
    onCreateDrawingLayer: () => void;
    onSaveScene: (isDownload: boolean) => void;
    onOpacityChange: (value: number) => void;
    onFrameChange: (value: number) => void;
    onContrastMinChange: (value: number) => void;
    onContrastMaxChange: (value: number) => void;
    onColormapChange: (event: React.ChangeEvent<HTMLSelectElement>) => void;
    onMoveVolumeUp: () => void;
    onMoveVolumeDown: () => void;
}
export default function SceneDetailsTab({ nvRef, serverlessMode, getVolumes, onToggleVisibility, onEditVolume, canEditVolume, onRemoveVolume, onAddMoreFiles, onCreateDrawingLayer, onSaveScene, onOpacityChange, onFrameChange, onContrastMinChange, onContrastMaxChange, onColormapChange, onMoveVolumeUp, onMoveVolumeDown, }: SceneDetailsTabProps): import("react/jsx-runtime").JSX.Element;
export {};
