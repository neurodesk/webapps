export type TiffSampleArray = Uint8Array | Uint16Array | Uint32Array | Int8Array | Int16Array | Int32Array | Float32Array | Float64Array;

export interface TiffStackMetadata {
  kind: 'ome' | 'imagej' | 'baseline';
  /** ImageJ only: a stack without `hyperstack=true` or `frames=`, whose pages may be z or t. */
  unlabelledStack?: boolean;
  images: number;
  dimensionOrder?: string | null;
  sizeC: number;
  sizeZ: number;
  sizeT: number;
  /** Micrometres; null when the file does not record it. */
  pixelSize: { x: number | null; y: number | null; z: number | null };
  /** Seconds between frames; null when the file does not record it. */
  frameInterval: number | null;
  /** OME stage position of the first image's first plane (TheZ = TheC = TheT = 0), in micrometres; null when that plane records none or the file is not OME. */
  stagePosition: { x: number; y: number; z: number | null } | null;
  description?: string;
}

export interface TiffStackInfo {
  width: number;
  height: number;
  pages: number;
  dtype: 'uint8' | 'uint16' | 'uint32' | 'int8' | 'int16' | 'int32' | 'float32' | 'float64';
  bytesPerSample: number;
  metadata: TiffStackMetadata;
}

export interface TiffStack<Data extends TiffSampleArray = TiffSampleArray> extends TiffStackInfo {
  /** The file's sample type unless `Type` chose another; `dtype` always names the file's. */
  data: Data;
}

type TiffSampleArrayConstructor<Data extends TiffSampleArray> = { new (length: number): Data; new (buffer: ArrayBufferLike): Data; readonly BYTES_PER_ELEMENT: number };

export interface ReadTiffStackOptions<Data extends TiffSampleArray = TiffSampleArray> {
  signal?: AbortSignal;
  /** Limit on the output array's bytes (in `Type` when given). */
  maxBytes?: number;
  /** Decode each page straight into an array of this type instead of the file's sample type. */
  Type?: TiffSampleArrayConstructor<Data>;
  /** Back the output with a SharedArrayBuffer. */
  shared?: boolean;
  onProgress?: (done: number, total: number) => void;
}

export function micrometresPerUnit(unit: string | null | undefined): number | null;
export function parseOmeDescription(description: string | null | undefined): Omit<TiffStackMetadata, 'description'> | null;
export function parseImagejDescription(description: string | null | undefined, resolution?: [number | null, number | null]): Omit<TiffStackMetadata, 'description'> | null;
/** Size, sample type and metadata from the page directories; no pixel is decoded. Refuses several OME series and an ImageJ `images=` that is not the page count. */
export function inspectTiffStack(buffer: ArrayBuffer): Promise<TiffStackInfo>;
/** Every page of a greyscale TIFF in page, row, column order; refuses multi-sample, palette and over-budget stacks. */
export function readTiffStack<Data extends TiffSampleArray = TiffSampleArray>(buffer: ArrayBuffer, options?: ReadTiffStackOptions<Data>): Promise<TiffStack<Data>>;
export function imagejDescription(options: { frames: number; frameInterval?: number | null; unit?: string | null; min?: number | null; max?: number | null }): string;
/** Uncompressed little-endian baseline TIFF, one strip per page. */
export function writeTiffStack(stack: { width: number; height: number; data: TiffSampleArray; description?: string; pixelSize?: { x: number; y: number } | null }): Uint8Array;
