// Types for the `./file-io/download` export. The name is deliberately not
// download.d.ts: a sibling declaration would also retype the untyped
// `./file-io` index for allowJs consumers, which pass it unknown values.
export function arrayBufferToFile(buffer: BlobPart, name: string, type?: string): File;
export function downloadBlob(blob: Blob, filename: string): void;
export function downloadFile(file: File): void;
export function downloadArrayBuffer(buffer: BlobPart, filename: string, type?: string): void;
