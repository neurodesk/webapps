import type { StateCreator } from "zustand";
export interface VolumeSlice {
    currentImageIndex: number | null;
    showUploader: boolean;
    /** Master switch for drag-and-drop loading (niivue canvas drop + the drop zone). */
    dragDropEnabled: boolean;
    volumeVersion: number;
    setCurrentImageIndex: (index: number | null) => void;
    setShowUploader: (show: boolean) => void;
    setDragDropEnabled: (enabled: boolean) => void;
    incrementVolumeVersion: () => void;
}
export declare const createVolumeSlice: StateCreator<VolumeSlice>;
