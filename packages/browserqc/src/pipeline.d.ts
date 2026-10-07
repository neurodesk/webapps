import type { Backend, SegmentOptions, segment, segmentTissues } from '@brainchop/mindgrab';
import type catalog from './models.json';

export type Model = keyof typeof catalog;
export declare const MODELS: typeof catalog;
export declare const DEFAULT_MODEL: Model;
export declare function parseModel(value: unknown): Model;

export declare const AIR_TEMPLATE: Readonly<{ name: string; url: string; sha256: string }>;
export declare function sha256Hex(bytes: BufferSource): Promise<string>;
export declare function checkAirTemplate<T extends BufferSource>(bytes: T): Promise<T>;

/** @brainchop/mindgrab's segment and segmentTissues, or the Node CPU driver's. */
export type Segmenter = { segment: typeof segment; segmentTissues: typeof segmentTissues };

type Timing = { backend: Backend; elapsedMs: number };
export type Segmentation = Timing & (
  { kind: 'labels'; image: ArrayBuffer; mask: ArrayBuffer } |
  { kind: 'pve'; tissues: { csf: ArrayBuffer; gm: ArrayBuffer; wm: ArrayBuffer }; mask: ArrayBuffer }
);
export declare function segmentForQc(segmenter: Segmenter, input: Uint8Array, model: Model, options?: Omit<SegmentOptions, 'model'>): Promise<Segmentation>;

export type QcTissues = (
  { seg: ArrayBuffer; csf: number[]; wm: number[] } |
  { pve: [csf: ArrayBuffer, gm: ArrayBuffer, wm: ArrayBuffer] }
) & { mask: ArrayBuffer };
export declare function qcTissues(segmentation: Segmentation, model: Model): QcTissues;

export declare function finishReport<T extends { provenance: Record<string, unknown> }>(report: T, options: { model: Model; bids: unknown }): T;
