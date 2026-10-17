import type { StateCreator } from "zustand";
import type { SaveState } from "./types";
export interface SaveSlice {
    saveDialogOpen: boolean;
    saveState: SaveState;
    setSaveDialogOpen: (open: boolean) => void;
    setSaveState: (state: SaveState | ((prev: SaveState) => SaveState)) => void;
}
export declare const createSaveSlice: StateCreator<SaveSlice>;
