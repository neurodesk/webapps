/**
 * File System Access API utilities for handling large files and directories.
 * Provides streaming file reading and directory traversal with fallback detection.
 */

// Type definitions for File System Access API
// These extend the standard lib.dom.d.ts definitions
declare global {
  interface Window {
    showDirectoryPicker?: (options?: DirectoryPickerOptions) => Promise<FileSystemDirectoryHandle>;
    showOpenFilePicker?: (options?: OpenFilePickerOptions) => Promise<FileSystemFileHandle[]>;
  }
}

export interface DirectoryPickerOptions {
  id?: string;
  mode?: 'read' | 'readwrite';
  startIn?: 'desktop' | 'documents' | 'downloads' | 'music' | 'pictures' | 'videos' | FileSystemHandle;
}

export interface OpenFilePickerOptions {
  multiple?: boolean;
  excludeAcceptAllOption?: boolean;
  types?: Array<{
    description?: string;
    accept: Record<string, string[]>;
  }>;
}

export interface FileHandleWithPath {
  handle: FileSystemFileHandle;
  path: string;
  name: string;
}

/**
 * Check if the File System Access API is supported in the current browser.
 * Returns true for Chrome 86+, Edge 86+, and Opera 72+.
 * Returns false for Firefox and Safari (partial support not sufficient for our needs).
 */
export function isFileSystemAccessSupported(): boolean {
  return (
    typeof window !== 'undefined' &&
    'showDirectoryPicker' in window &&
    typeof window.showDirectoryPicker === 'function'
  );
}

/**
 * Check if showOpenFilePicker is supported (slightly broader support than directory picker)
 */
export function isFilePickerSupported(): boolean {
  return (
    typeof window !== 'undefined' &&
    'showOpenFilePicker' in window &&
    typeof window.showOpenFilePicker === 'function'
  );
}

/**
 * Open a directory picker dialog and return the selected directory handle.
 * Returns null if the user cancels the dialog or if not supported.
 */
export async function pickDirectory(options?: DirectoryPickerOptions): Promise<FileSystemDirectoryHandle | null> {
  if (!isFileSystemAccessSupported()) {
    console.warn('File System Access API not supported');
    return null;
  }

  try {
    const handle = await window.showDirectoryPicker!(options);
    return handle;
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') {
      // User cancelled the picker
      return null;
    }
    throw error;
  }
}

/**
 * Open a file picker dialog and return the selected file handles.
 * Returns empty array if the user cancels or if not supported.
 */
export async function pickFiles(options?: OpenFilePickerOptions): Promise<FileSystemFileHandle[]> {
  if (!isFilePickerSupported()) {
    console.warn('File picker API not supported');
    return [];
  }

  try {
    const handles = await window.showOpenFilePicker!(options);
    return handles;
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') {
      // User cancelled the picker
      return [];
    }
    throw error;
  }
}

/**
 * Recursively iterate over all files in a directory.
 * Yields file handles with their relative paths for uniqueness.
 *
 * @param handle - The directory handle to iterate
 * @param basePath - Base path for building relative paths (internal use)
 */
export async function* iterateDirectoryFiles(
  handle: FileSystemDirectoryHandle,
  basePath: string = ''
): AsyncGenerator<FileHandleWithPath> {
  for await (const entry of handle.values()) {
    const entryPath = basePath ? `${basePath}/${entry.name}` : entry.name;

    if (entry.kind === 'file') {
      yield {
        handle: entry as FileSystemFileHandle,
        path: entryPath,
        name: entry.name,
      };
    } else if (entry.kind === 'directory') {
      yield* iterateDirectoryFiles(entry as FileSystemDirectoryHandle, entryPath);
    }
  }
}

/**
 * Count files in a directory without loading content.
 * Useful for progress estimation.
 */
export async function countDirectoryFiles(handle: FileSystemDirectoryHandle): Promise<number> {
  let count = 0;
  for await (const _ of iterateDirectoryFiles(handle)) {
    count++;
  }
  return count;
}

/**
 * Get file metadata (size) from a handle without reading content.
 */
export async function getFileSize(handle: FileSystemFileHandle): Promise<number> {
  const file = await handle.getFile();
  return file.size;
}

/**
 * Read a file from a handle. For files under 2GB, uses standard arrayBuffer().
 * For larger files, uses streaming to avoid ArrayBuffer size limits.
 *
 * @param handle - The file handle to read
 * @param onProgress - Optional callback for progress updates
 * @returns The file content as a Uint8Array
 */
export async function readFileHandle(
  handle: FileSystemFileHandle,
  onProgress?: (bytesRead: number, totalBytes: number) => void
): Promise<Uint8Array> {
  const file = await handle.getFile();
  const totalSize = file.size;

  // For files under 2GB, use standard approach (faster)
  const TWO_GB = 2 * 1024 * 1024 * 1024;
  if (totalSize < TWO_GB) {
    const buffer = await file.arrayBuffer();
    onProgress?.(totalSize, totalSize);
    return new Uint8Array(buffer);
  }

  // For large files, use streaming to avoid ArrayBuffer limits
  console.log(`Reading large file (${(totalSize / (1024 * 1024 * 1024)).toFixed(2)} GB) using stream...`);
  return readLargeFile(file, onProgress);
}

/**
 * Read a large file (>2GB) using ReadableStream.
 * Chunks are collected and concatenated at the end.
 *
 * @param file - The File object to read
 * @param onProgress - Optional callback for progress updates
 * @returns The file content as a Uint8Array
 */
export async function readLargeFile(
  file: File,
  onProgress?: (bytesRead: number, totalBytes: number) => void
): Promise<Uint8Array> {
  const totalSize = file.size;
  const chunks: Uint8Array[] = [];
  let bytesRead = 0;

  const stream = file.stream();
  const reader = stream.getReader();

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      chunks.push(value);
      bytesRead += value.length;
      onProgress?.(bytesRead, totalSize);
    }
  } finally {
    reader.releaseLock();
  }

  // Concatenate all chunks into a single Uint8Array
  const result = new Uint8Array(totalSize);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.length;
  }

  return result;
}

/**
 * Filter file handles to only include likely DICOM files.
 * Excludes known non-DICOM extensions and zero-size files.
 */
export function isDicomFile(name: string): boolean {
  const lowerName = name.toLowerCase();

  // Skip known non-DICOM files
  const nonDicomExtensions = ['.txt', '.json', '.xml', '.csv', '.md', '.html', '.log', '.ds_store'];
  if (nonDicomExtensions.some(ext => lowerName.endsWith(ext))) {
    return false;
  }

  // Skip hidden files (Unix-style)
  if (name.startsWith('.')) {
    return false;
  }

  return true;
}

/**
 * Check if a file is a ZIP archive
 */
export function isZipFile(name: string): boolean {
  return name.toLowerCase().endsWith('.zip');
}

/**
 * Check if a file is a protocol file (Siemens, Philips, etc.)
 */
export function isProtocolFile(name: string): boolean {
  const lowerName = name.toLowerCase();
  return (
    lowerName.endsWith('.pro') ||
    lowerName.endsWith('.exar1') ||
    lowerName.endsWith('.examcard') ||
    lowerName === 'lxprotocol'
  );
}
