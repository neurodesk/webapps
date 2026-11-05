export interface RasterImageHeader {
  format: 'png' | 'jpeg';
  width: number;
  height: number;
  bitDepth: number;
  /** PNG colour type (0 grey, 2 RGB, 3 palette, 4 grey + alpha, 6 RGBA). */
  colourType?: number;
  /** JPEG component count. */
  components?: number;
}

/** PNG or JPEG size from the header (the JPEG segments are walked to the frame header); null for other formats. */
export function probeRasterImage(bytes: Uint8Array): RasterImageHeader | null;
/** RGBA pixels as stored (no EXIF rotation), refused from the header above `maxBytes`. */
export function decodeRasterImage(file: Blob, options?: { maxBytes?: number; signal?: AbortSignal }): Promise<{ width: number; height: number; format: 'png' | 'jpeg'; data: Uint8ClampedArray }>;
