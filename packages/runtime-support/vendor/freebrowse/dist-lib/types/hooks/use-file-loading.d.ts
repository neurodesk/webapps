import type { NiiVue } from "@niivue/niivue";
import type { FileItem } from "../components/file-list.js";
export declare function useFileLoading(nvRef: React.RefObject<NiiVue | null>, applyViewerOptions: () => void, syncViewerOptionsFromNiiVue: () => void, updateSurfaceDetails: () => void): {
    serverlessMode: boolean;
    fileInputRef: import("react").RefObject<HTMLInputElement | null>;
    surfaceFileInputRef: import("react").RefObject<HTMLInputElement | null>;
    loadNvdData: (data: ArrayBuffer | Uint8Array | Record<string, unknown>) => Promise<void>;
    handleFileUpload: (files: File[]) => Promise<void>;
    handleImagingFileSelect: (file: FileItem) => Promise<void>;
    handleNvdFileSelect: (file: FileItem) => Promise<void>;
    handleFileChange: (e: React.ChangeEvent<HTMLInputElement>) => void;
    handleAddMoreFiles: () => void;
    handleAddSurfaceFiles: () => void;
    handleSurfaceFileChange: (e: React.ChangeEvent<HTMLInputElement>) => Promise<void>;
};
