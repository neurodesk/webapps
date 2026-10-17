import type { StateCreator } from "zustand";
import type { DrawingOptions } from "./types";
export interface DrawingSlice {
    drawingOptions: DrawingOptions;
    setDrawingOptions: (options: DrawingOptions | ((prev: DrawingOptions) => DrawingOptions)) => void;
}
export declare const createDrawingSlice: StateCreator<DrawingSlice>;
