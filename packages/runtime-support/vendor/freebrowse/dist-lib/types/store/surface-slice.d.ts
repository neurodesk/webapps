import type { StateCreator } from "zustand";
import type { SurfaceDetails } from "./types";
export interface SurfaceSlice {
    surfaces: SurfaceDetails[];
    currentSurfaceIndex: number | null;
    surfaceToRemove: number | null;
    selectedLayerIndex: number | null;
    layerVersion: number;
    setSurfaces: (surfaces: SurfaceDetails[] | ((prev: SurfaceDetails[]) => SurfaceDetails[])) => void;
    setCurrentSurfaceIndex: (index: number | null) => void;
    setSurfaceToRemove: (index: number | null) => void;
    setSelectedLayerIndex: (index: number | null) => void;
    incrementLayerVersion: () => void;
}
export declare const createSurfaceSlice: StateCreator<SurfaceSlice>;
