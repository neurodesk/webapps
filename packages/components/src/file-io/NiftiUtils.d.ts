/** Bytes a NIfTI helper accepts: an ArrayBuffer or any typed-array view of one. */
export type NiftiBytes = ArrayBuffer | ArrayBufferView;

/** Rows of a 4x4 voxel-to-world matrix. */
export type NiftiAffine = Float64Array[];

export type NiftiVoxelArray =
  | Int8Array
  | Uint8Array
  | Int16Array
  | Uint16Array
  | Int32Array
  | Uint32Array
  | Float32Array
  | Float64Array;

export type NiftiOutputConstructor<T extends NiftiVoxelArray = NiftiVoxelArray> = new (length: number) => T;

export interface NiftiHeader {
  dims: number[];
  littleEndian: boolean;
  nx: number;
  ny: number;
  nz: number;
  pixDims: number[];
  voxelSize: [number, number, number];
  datatype: number;
  bitpix: number;
  xyztUnits: number;
  qformCode: number;
  sformCode: number;
  voxOffset: number;
  sclSlope: number;
  sclInter: number;
  affine: NiftiAffine;
}

export interface NiftiImage<T extends NiftiVoxelArray = Float32Array> {
  data: T;
  header: NiftiHeader;
  dims: [number, number, number];
}

export interface NiftiFrames<T extends NiftiVoxelArray = Float32Array> extends NiftiImage<T> {
  frames: number;
}

export interface NiftiVolume<T extends NiftiVoxelArray = Float32Array> {
  imageData: T;
  dims: [number, number, number];
  voxelSize: number[];
  headerBytes: ArrayBuffer;
  affine: NiftiAffine;
  header: NiftiHeader;
}

export interface NiftiFromDataOptions {
  dims?: [number, number, number] | null;
  preserveScaling?: boolean;
  spacing?: [number, number, number];
  calMin?: number;
  calMax?: number;
  range?: 'auto';
  clampCalMax?: boolean;
}

export function sameVoxelGrid(left: Pick<NiftiHeader, 'dims' | 'affine'>, right: Pick<NiftiHeader, 'dims' | 'affine'>): boolean;
export function sameNiftiGrid(first: NiftiBytes, second: NiftiBytes, toleranceMm?: number): boolean;
export function parseNiftiHeader(headerBuffer: NiftiBytes): NiftiHeader;
export function extractAffine(view: NiftiBytes): NiftiAffine;
export function isGzipped(data: NiftiBytes): boolean;
export function isValidNifti1(data: NiftiBytes): boolean;
export function decodeNiftiBuffer(bufferLike: NiftiBytes, options?: { maxBytes?: number }): Promise<ArrayBuffer>;
export function readNifti(bufferLike: NiftiBytes): Promise<NiftiImage>;
export function readNifti<T extends NiftiVoxelArray>(bufferLike: NiftiBytes, OutputCtor: NiftiOutputConstructor<T>): Promise<NiftiImage<T>>;
export function readNiftiImageData(bufferLike: NiftiBytes): NiftiImage;
export function readNiftiImageData<T extends NiftiVoxelArray>(bufferLike: NiftiBytes, OutputCtor: NiftiOutputConstructor<T>): NiftiImage<T>;
export function readNiftiFrames(bufferLike: NiftiBytes): NiftiFrames;
export function readNiftiFrames<T extends NiftiVoxelArray>(bufferLike: NiftiBytes, OutputCtor: NiftiOutputConstructor<T>): NiftiFrames<T>;
export function parseNiftiVolume(
  bufferLike: NiftiBytes,
  options?: { decompress?: (buffer: ArrayBuffer) => NiftiBytes; OutputCtor?: NiftiOutputConstructor },
): NiftiVolume<NiftiVoxelArray>;
export function extractNiftiHeader(bufferLike: NiftiBytes): ArrayBuffer;
export function createUint8Nifti(data: ArrayLike<number>, sourceHeader: NiftiBytes, dims?: [number, number, number] | null): ArrayBuffer;
export function createFloat32Nifti(data: ArrayLike<number>, sourceHeader: NiftiBytes, dims?: [number, number, number] | null): ArrayBuffer;
export function createFloat64Nifti(data: ArrayLike<number>, sourceHeader: NiftiBytes, dims?: [number, number, number] | null): ArrayBuffer;
export function createMaskNifti(maskData: ArrayLike<number | boolean>, sourceHeader: NiftiBytes, dims?: [number, number, number] | null): ArrayBuffer;
export function createNiftiFromData(data: NiftiVoxelArray, sourceHeader: NiftiBytes, options?: NiftiFromDataOptions): ArrayBuffer;
export function createNiftiHeaderFromVolume(volume: unknown): ArrayBuffer;
export function createNiftiFromVolume(volume: unknown): ArrayBuffer;
