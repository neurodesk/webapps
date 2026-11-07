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
  /** OME only: the OME element's UUID, the first image's channels and its TiffData elements. */
  uuid?: string | null;
  channels?: OmeChannel[];
  tiffData?: OmeTiffData[];
  description?: string;
}

/** What `parseOmeDescription` returns: OME metadata, always with the UUID, channels and TiffData. */
export interface OmeMetadata extends Omit<TiffStackMetadata, 'description' | 'unlabelledStack' | 'uuid' | 'channels' | 'tiffData'> {
  kind: 'ome';
  /** null when the OME element has no UUID. */
  uuid: string | null;
  channels: OmeChannel[];
  tiffData: OmeTiffData[];
}

export interface OmeChannel {
  /** null when the Channel has no Name or an empty one. */
  name: string | null;
  samplesPerPixel: number;
}

/** A TiffData element's attributes as written (undefined when absent), and the UUID of the file holding its planes (null for this file). */
export interface OmeTiffData {
  IFD?: string;
  FirstC?: string;
  FirstZ?: string;
  FirstT?: string;
  PlaneCount?: string;
  uuid: string | null;
}

/** What a sample of a page holds: an RGB or palette-as-colour sample, an alpha, or another sample (1-based). */
export type TiffSampleKind = 'red' | 'green' | 'blue' | 'alpha' | `sample ${number}`;

/** A full-resolution page of a 2D image TIFF and what each of its samples holds. */
export interface TiffPlanePage {
  ifd: number;
  width: number;
  height: number;
  samples: TiffSampleKind[];
}

export interface TiffPlanes {
  /** At most `pageLimit` pages, pyramid levels left out. */
  pages: TiffPlanePage[];
  /** The first page's ImageDescription, or null. */
  description: string | null;
  /** Bytes of every page's decoded samples, alpha included; throws on a sample type geotiff cannot decode. */
  decodedBytes(): number;
  /** Per page, its samples other than alpha, in sample order; palette pages as red, green and blue unless read as indices. */
  readPlanes(options?: { signal?: AbortSignal }): Promise<Array<Array<{ kind: Exclude<TiffSampleKind, 'alpha'>; data: TiffSampleArray }>>>;
}

export interface TiffStackInfo {
  width: number;
  height: number;
  pages: number;
  dtype: 'uint8' | 'uint16' | 'uint32' | 'int8' | 'int16' | 'int32' | 'float32' | 'float64';
  bytesPerSample: number;
  /** 1, or 3 or more for RGB pages read with `rgb: 'mean'`. */
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
export function parseOmeDescription(description: string | null | undefined): OmeMetadata | null;
export function parseImagejDescription(description: string | null | undefined, resolution?: [number | null, number | null]): Omit<TiffStackMetadata, 'description'> | null;
/** Size, sample type and metadata from the page directories; no pixel is decoded. Refuses several OME series and an ImageJ `images=` that is not the page count. A Blob or File is read range by range, only as far as its page directories and description. */
export function inspectTiffStack(source: ArrayBuffer | Blob, options?: { rgb?: 'refuse' | 'mean' }): Promise<TiffStackInfo>;
/** Every page of a greyscale TIFF in page, row, column order; refuses multi-sample, palette and over-budget stacks. */
export function readTiffStack<Data extends TiffSampleArray = TiffSampleArray>(buffer: ArrayBuffer, options?: ReadTiffStackOptions<Data>): Promise<TiffStack<Data>>;
export function imagejDescription(options: { frames: number; frameInterval?: number | null; unit?: string | null; min?: number | null; max?: number | null }): string;
/** Uncompressed little-endian baseline TIFF, one strip per page; `rgb` writes Uint8Array red, green, blue triplets as RGB pages. */
export function writeTiffStack(stack: { width: number; height: number; data: TiffSampleArray; description?: string; pixelSize?: { x: number; y: number } | null; rgb?: boolean }): Uint8Array;
/** The full-resolution pages of a 2D image TIFF from their directories; `readPlanes` decodes them. `palette: 'index'` reads palette pages as their colour indices (default `'rgb'`). */
export function openTiffPlanes(buffer: ArrayBuffer, options?: { pageLimit?: number; palette?: 'rgb' | 'index' }): Promise<TiffPlanes>;
/** Each kept page's OME channel name (`ifds`, in page order), or null when the pages are not one 2D image's single-sample channels; throws on TiffData it cannot follow. */
export function omePageChannels(name: string, ome: OmeMetadata, ifds: number[]): string[] | null;
/** A label image as an uncompressed TIFF, unsigned 16-bit when the labels fit and 32-bit otherwise. */
export function writeLabelTiff(labels: ArrayLike<number>, width: number, height: number): Uint8Array;
