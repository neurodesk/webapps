import { type VolumeSlice } from "./volume-slice";
import { type SurfaceSlice } from "./surface-slice";
import { type DrawingSlice } from "./drawing-slice";
import { type ViewerSlice } from "./viewer-slice";
import { type SaveSlice } from "./save-slice";
import { type LocationSlice } from "./location-slice";
import { type AiSlice } from "./ai-slice";
export type FreeBrowseStore = VolumeSlice & SurfaceSlice & DrawingSlice & ViewerSlice & SaveSlice & LocationSlice & AiSlice;
export declare const useFreeBrowseStore: import("zustand").UseBoundStore<Omit<import("zustand").StoreApi<FreeBrowseStore>, "persist" | "setState"> & {
    setState(partial: FreeBrowseStore | Partial<FreeBrowseStore> | ((state: FreeBrowseStore) => FreeBrowseStore | Partial<FreeBrowseStore>), replace?: false | undefined): unknown;
    setState(state: FreeBrowseStore | ((state: FreeBrowseStore) => FreeBrowseStore), replace: true): unknown;
    persist: {
        setOptions: (options: Partial<import("zustand/middleware").PersistOptions<FreeBrowseStore, unknown, unknown>>) => void;
        clearStorage: () => void;
        rehydrate: () => Promise<void> | void;
        hasHydrated: () => boolean;
        onHydrate: (fn: (state: FreeBrowseStore) => void) => () => void;
        onFinishHydration: (fn: (state: FreeBrowseStore) => void) => () => void;
        getOptions: () => Partial<import("zustand/middleware").PersistOptions<FreeBrowseStore, unknown, unknown>>;
    };
}>;
