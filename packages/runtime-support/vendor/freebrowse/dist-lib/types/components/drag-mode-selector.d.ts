import { DRAG_MODE } from '@niivue/niivue';
export type DragMode = keyof typeof DRAG_MODE;
interface DragModeSelectorProps {
    currentMode: DragMode;
    onModeChange: (mode: DragMode) => void;
    availableModes?: DragMode[];
}
export default function DragModeSelector({ currentMode, onModeChange, availableModes }: DragModeSelectorProps): import("react/jsx-runtime").JSX.Element;
export {};
