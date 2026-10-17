export type ViewMode = "axial" | "coronal" | "sagittal" | "ACS" | "ACSR" | "render";
interface ViewSelectorProps {
    currentView: ViewMode;
    onViewChange: (view: ViewMode) => void;
}
export default function ViewSelector({ currentView, onViewChange }: ViewSelectorProps): import("react/jsx-runtime").JSX.Element;
export {};
