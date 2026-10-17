import type { NvdFormat } from "../store/types.js";
import type { NiiVue } from "@niivue/niivue";
export declare function useSave(nvRef: React.RefObject<NiiVue | null>): {
    handleSaveScene: (isDownload?: boolean) => Promise<void>;
    handleConfirmSave: () => Promise<void>;
    handleCancelSave: () => void;
    handleVolumeUrlChange: (index: number, url: string) => void;
    handleVolumeCheckboxChange: (index: number, enabled: boolean) => void;
    handleDocumentLocationChange: (location: string) => void;
    handleDocumentCheckboxChange: (enabled: boolean) => void;
    handleDocumentFormatChange: (format: NvdFormat) => void;
};
