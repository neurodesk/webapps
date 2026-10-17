import type { NvdFormat } from "../../store/types.js";
import type { NiiVue } from "@niivue/niivue";
interface SaveDialogProps {
    nvRef: React.RefObject<NiiVue | null>;
    onConfirm: () => void;
    onCancel: () => void;
    onVolumeUrlChange: (index: number, url: string) => void;
    onVolumeCheckboxChange: (index: number, enabled: boolean) => void;
    onDocumentLocationChange: (location: string) => void;
    onDocumentCheckboxChange: (enabled: boolean) => void;
    onDocumentFormatChange: (format: NvdFormat) => void;
}
export default function SaveDialog({ nvRef, onConfirm, onCancel, onVolumeUrlChange, onVolumeCheckboxChange, onDocumentLocationChange, onDocumentCheckboxChange, onDocumentFormatChange, }: SaveDialogProps): import("react/jsx-runtime").JSX.Element;
export {};
