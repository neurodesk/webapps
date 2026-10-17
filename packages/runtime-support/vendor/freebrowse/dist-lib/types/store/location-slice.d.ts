import type { StateCreator } from "zustand";
import type { LocationData } from "./types";
export interface LocationSlice {
    locationData: LocationData | null;
    setLocationData: (data: LocationData | null) => void;
}
export declare const createLocationSlice: StateCreator<LocationSlice>;
