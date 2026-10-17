import type { NiiVue, NVExtensionContext } from "@niivue/niivue";
import type { DrawingOptions } from "../store/types.js";
/**
 * Flood from the drawing layer's *current* bitmap and apply the result. Used for
 * the one-shot commit path (a click with no preceding hover preview). Exported
 * for unit testing against a fake ctx. Guards on drawing/volume so a click before
 * a layer/volume exists is a no-op.
 */
export declare function runMagicWand(ctx: NVExtensionContext, opts: DrawingOptions, seed: [number, number, number], sliceType: number): Promise<void>;
/**
 * Wires the wand engine to the niivue instance. One extension context per
 * instance; params are read imperatively at event time (so changing them never
 * re-subscribes).
 */
export declare function useMagicWand(nvRef: React.RefObject<NiiVue | null>): void;
