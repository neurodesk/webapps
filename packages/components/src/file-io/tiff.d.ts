export type TiffSampleArray = Uint8Array | Uint16Array | Uint32Array | Int8Array | Int16Array | Int32Array | Float32Array | Float64Array;

export interface TiffStackMetadata {
  kind: 'ome' | 'imagej' | 'baseline';
  images: number;
  dimensionOrder?: string | null;
  sizeC: number;
  sizeZ: number;
  sizeT: number;
  /** Micrometres; null when the file does not record it. */
  pixelSize: { x: number | null; y: number | null; z: number | null };
  /** Seconds between frames; null when the file does not record it. */
  frameInterval: number | null;
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

export interface TiffStack extends TiffStackInfo {
  data: TiffSampleArray;
}

export function micrometresPerUnit(unit: string | null | undefined): number | null;
export function parseOmeDescription(description: string | null | undefined): Omit<TiffStackMetadata, 'description'> | null;
export function parseImagejDescription(description: string | null | undefined, resolution?: [number | null, number | null]): Omit<TiffStackMetadata, 'description'> | null;
/** Size, sample type and metadata from the page directories; no pixel is decoded. */
export function inspectTiffStack(buffer: ArrayBuffer): Promise<TiffStackInfo>;
/** Every page of a greyscale TIFF in page, row, column order; refuses multi-sample, palette and over-budget stacks. */
export function readTiffStack(buffer: ArrayBuffer, options?: { signal?: AbortSignal; maxBytes?: number; onProgress?: (done: number, total: number) => void }): Promise<TiffStack>;
export function imagejDescription(options: { frames: number; frameInterval?: number | null; unit?: string | null; min?: number | null; max?: number | null }): string;
/** Uncompressed little-endian baseline TIFF, one strip per page. */
export function writeTiffStack(stack: { width: number; height: number; data: TiffSampleArray; description?: string; pixelSize?: { x: number; y: number } | null }): Uint8Array;
