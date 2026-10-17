import type { ViewMode } from "../store/types.js";
import type { NiiVue } from "@niivue/niivue";
interface CanvasAreaProps {
    nvInstance: NiiVue;
    viewMode: ViewMode;
    onFileUpload: (files: File[]) => Promise<void>;
    nvCanvasEmptyState?: React.ReactNode;
}
export default function CanvasArea({ nvInstance, viewMode, onFileUpload, nvCanvasEmptyState, }: CanvasAreaProps): import("react/jsx-runtime").JSX.Element;
export {};
