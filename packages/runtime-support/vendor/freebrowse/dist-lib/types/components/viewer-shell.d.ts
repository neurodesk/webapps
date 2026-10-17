import type { NiiVue } from "@niivue/niivue";
import type { ViewMode } from "../store/types.js";
interface ViewerShellProps {
    nvInstance: NiiVue;
    viewMode: ViewMode;
    onFileUpload: (files: File[]) => Promise<void>;
    sidebar?: React.ReactNode;
    dialogs?: React.ReactNode;
    hiddenInputs?: React.ReactNode;
    nvCanvasEmptyState?: React.ReactNode;
}
export default function ViewerShell({ nvInstance, viewMode, onFileUpload, sidebar, dialogs, hiddenInputs, nvCanvasEmptyState, }: ViewerShellProps): import("react/jsx-runtime").JSX.Element;
export {};
