export type TiffSampleArray = Uint8Array | Uint16Array | Uint32Array | Int8Array | Int16Array | Int32Array | Float32Array | Float64Array;

export interface TiffStackMetadata {
  kind: 'ome' | 'imagej' | 'baseline';
  /**
   * The file does not say whether its pages are z planes or time points: an ImageJ stack without
   * `hyperstack=true` or `frames=`, or a plain TIFF (whose sizeZ and sizeT are then null).
   */
  unlabelledStack?: boolean;
  images: number;
  dimensionOrder?: string | null;
  sizeC: number;
  sizeZ: number | null;
  sizeT: number | null;
  /** Micrometres; null when the file does not record it. */
  pixelSize: { x: number | null; y: number | null; z: number | null };
  /**
   * The pixel size as the file declares it, in its own unit (ImageJ `unit=`, OME
   * `PhysicalSizeXUnit`, a plain TIFF's ResolutionUnit; null when none is named). A plain TIFF's
   * resolution tags are often a nominal dpi, so treat its values as ratios, not a calibration.
   */
  declaredSpacing?: { x: number | null; y: number | null; z: number | null; unit: string | null };
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
  /** Samples per pixel of the first page: 1, 2 for grey + alpha (read as grey), or 3 or more for RGB pages read with `rgb: 'mean'`. */
  samplesPerPixel: number;
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
  /** `'mean'` reads RGB pages as the mean of red, green and blue (ImageJ's RGB to 8-bit); the default refuses them. */
  rgb?: 'refuse' | 'mean';
  onProgress?: (done: number, total: number) => void;
}

export function micrometresPerUnit(unit: string | null | undefined): number | null;
export function isOmeDescription(description: string | null | undefined): boolean;
export function parseOmeDescription(description: string | null | undefined): Omit<TiffStackMetadata, 'description'> | null;
export function parseImagejDescription(description: string | null | undefined, resolution?: [number | null, number | null]): Omit<TiffStackMetadata, 'description'> | null;
/**
 * Size, sample type and metadata from the page directories; no pixel is decoded. `pages` counts
 * full-resolution pages (or OME planes). Refuses several OME series, OME planes in other files or
 * not all mapped by TiffData, and an ImageJ `images=` that is not the page count. A Blob or File
 * is read range by range, only as far as its page directories and description.
 */
export function inspectTiffStack(source: ArrayBuffer | Blob, options?: { rgb?: 'refuse' | 'mean' }): Promise<TiffStackInfo>;
/**
 * Every full-resolution page of a greyscale TIFF in page (or OME plane), row, column order.
 * Reads the grey sample of grey + alpha pages, an ImageJ 8-bit palette's indices and inverted
 * WhiteIsZero integers; refuses colour (unless `rgb: 'mean'`), multichannel, other palette and
 * over-budget stacks.
 */
export function readTiffStack<Data extends TiffSampleArray = TiffSampleArray>(buffer: ArrayBuffer, options?: ReadTiffStackOptions<Data>): Promise<TiffStack<Data>>;
/** ImageJ description of `frames` time points of `slices` z planes (`spacing` in `unit`s). */
export function imagejDescription(options: { frames?: number; slices?: number; frameInterval?: number | null; spacing?: number | null; unit?: string | null; min?: number | null; max?: number | null }): string;
/** Uncompressed little-endian baseline TIFF, one strip per page; `rgb` writes Uint8Array red, green, blue triplets as RGB pages. */
export function writeTiffStack(stack: { width: number; height: number; data: TiffSampleArray; description?: string; pixelSize?: { x: number; y: number } | null; rgb?: boolean }): Uint8Array;
