/**
 * Shared utilities for DICOM file uploading across components
 */

import JSZip from 'jszip';

export interface FileObject {
  name: string;  // Unique identifier for the file (may include path for subdirectory files)
  content: Uint8Array;
}

export interface FileSizeInfo {
  totalBytes: number;
  totalGB: number;
  fileCount: number;
  exceedsLimit: boolean;
}

// Memory limit for browser processing (WebAssembly constraint) - legacy upload path only
// Testing showed crashes occur after converting ~6000 files at 339KB each (~2GB)
// For larger datasets, use the File System Access API with batch processing
export const MAX_TOTAL_SIZE_BYTES = 1.9 * 1024 * 1024 * 1024; // 1.9 GB

// Warning threshold - suggest using FSAA for better performance
export const SIZE_WARNING_THRESHOLD_BYTES = 500 * 1024 * 1024; // 500 MB

/**
 * Get a unique name for a file, using webkitRelativePath if available.
 * This ensures files with the same name from different subdirectories are distinguishable.
 */
function getUniqueFileName(file: File): string {
  // When files are uploaded via webkitdirectory, they have webkitRelativePath
  // which includes the full relative path from the selected folder
  const relativePath = (file as any).webkitRelativePath;
  if (relativePath && relativePath.length > 0) {
    return relativePath;
  }
  return file.name;
}

/**
 * Extract files from a zip archive
 */
async function extractZipFile(zipFile: File): Promise<File[]> {
  console.log(`Extracting zip file: ${zipFile.name}`);
  const zip = new JSZip();

  try {
    const zipContent = await zipFile.arrayBuffer();
    const loadedZip = await zip.loadAsync(zipContent);

    const extractedFiles: File[] = [];

    for (const [path, zipEntry] of Object.entries(loadedZip.files)) {
      // Skip directories
      if (zipEntry.dir) {
        continue;
      }

      // Get the file content as a Blob
      const blob = await zipEntry.async('blob');

      // Use full path as filename to ensure uniqueness across subdirectories
      // This prevents files with the same name in different folders from overwriting each other
      const fileName = path;

      // Create a File object from the blob with the full path as name
      const file = new File([blob], fileName, { type: 'application/dicom' });
      extractedFiles.push(file);

      console.log(`Extracted: ${fileName} (${file.size} bytes)`);
    }

    console.log(`Extracted ${extractedFiles.length} files from ${zipFile.name}`);
    return extractedFiles;
  } catch (error) {
    console.error(`Failed to extract zip file ${zipFile.name}:`, error);
    throw new Error(`Failed to extract zip file: ${error instanceof Error ? error.message : 'Unknown error'}`);
  }
}

export interface ProcessFilesOptions {
  onProgress?: (progress: { current: number; total: number; fileName: string }) => void;
  skipSizeCheck?: boolean;
}

/**
 * Process uploaded files, filtering out directories and non-DICOM files
 * Also extracts .zip files and processes their contents
 */
export async function processUploadedFiles(
  files: FileList,
  optionsOrProgress?: ProcessFilesOptions | ((progress: { current: number; total: number; fileName: string }) => void)
): Promise<FileObject[]> {
  // Handle both old signature (callback) and new signature (options object)
  const options: ProcessFilesOptions = typeof optionsOrProgress === 'function'
    ? { onProgress: optionsOrProgress }
    : optionsOrProgress || {};
  const { onProgress, skipSizeCheck = false } = options;
  const filesArray = Array.from(files);

  // First, extract any zip files
  const extractedFiles: File[] = [];
  const nonZipFiles: File[] = [];

  for (const file of filesArray) {
    if (file.name.toLowerCase().endsWith('.zip')) {
      try {
        const extracted = await extractZipFile(file);
        extractedFiles.push(...extracted);
      } catch (error) {
        console.error(`Failed to extract ${file.name}:`, error);
        // Continue processing other files even if one zip fails
      }
    } else {
      nonZipFiles.push(file);
    }
  }

  // Combine extracted files with non-zip files
  const allFiles = [...nonZipFiles, ...extractedFiles];

  // Filter out directories and empty files - only process actual DICOM files
  const actualFiles = allFiles.filter(file => {
    // Skip directories (they have size 0 and specific type indicators)
    if (file.size === 0) {
      console.log(`Skipping directory or empty file: ${file.name}`);
      return false;
    }
    // Skip known non-DICOM files
    const name = file.name.toLowerCase();
    if (name.endsWith('.txt') || name.endsWith('.json') || name.endsWith('.xml') || name.endsWith('.csv')) {
      console.log(`Skipping non-DICOM file: ${file.name}`);
      return false;
    }
    return true;
  });

  if (actualFiles.length === 0) {
    throw new Error('No valid DICOM files found in the uploaded content.');
  }

  // Check total file size before processing - browser memory limits prevent processing very large datasets
  const totalSize = actualFiles.reduce((sum, file) => sum + file.size, 0);
  const totalSizeGB = totalSize / (1024 * 1024 * 1024);

  if (!skipSizeCheck && totalSize > MAX_TOTAL_SIZE_BYTES) {
    throw new Error(
      `Dataset too large for standard upload: ${totalSizeGB.toFixed(1)} GB (${actualFiles.length.toLocaleString()} files). ` +
      `Maximum size for standard upload is ~2 GB. Use the "Large Folder" button (Chrome/Edge) for datasets over 2 GB, ` +
      `or use the desktop Python package.`
    );
  }

  // Log a warning for large datasets that could benefit from FSAA
  if (totalSize > SIZE_WARNING_THRESHOLD_BYTES) {
    console.warn(
      `[fileUploadUtils] Large dataset detected: ${totalSizeGB.toFixed(2)} GB. ` +
      `Consider using the "Large Folder" button for better performance and memory efficiency.`
    );
  }

  console.log(`Processing ${actualFiles.length} files (${totalSizeGB.toFixed(2)} GB) out of ${filesArray.length} total items`);
  console.log('File details:', actualFiles.map(f => ({ name: f.name, size: f.size, type: f.type })));

  const fileObjects: FileObject[] = [];

  for (let i = 0; i < actualFiles.length; i++) {
    const file = actualFiles[i];
    try {
      onProgress?.({ current: i + 1, total: actualFiles.length, fileName: file.name });

      const content = await file.arrayBuffer();
      fileObjects.push({
        name: getUniqueFileName(file),
        content: new Uint8Array(content)
      });
    } catch (error) {
      console.error(`Failed to read file ${file.name}:`, error);
      throw new Error(`Failed to read file ${file.name}: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  return fileObjects;
}

/**
 * Check total file size and count to determine if it exceeds browser limits.
 * This extracts zip files to get accurate totals.
 */
export async function checkFileSizeLimit(files: FileList): Promise<FileSizeInfo> {
  const filesArray = Array.from(files);

  // Extract zip files to get accurate file count and size
  const extractedFiles: File[] = [];
  const nonZipFiles: File[] = [];

  for (const file of filesArray) {
    if (file.name.toLowerCase().endsWith('.zip')) {
      try {
        const extracted = await extractZipFile(file);
        extractedFiles.push(...extracted);
      } catch (error) {
        console.error(`Failed to extract ${file.name}:`, error);
      }
    } else {
      nonZipFiles.push(file);
    }
  }

  const allFiles = [...nonZipFiles, ...extractedFiles];

  // Filter to actual DICOM files
  const actualFiles = allFiles.filter(file => {
    if (file.size === 0) return false;
    const name = file.name.toLowerCase();
    if (name.endsWith('.txt') || name.endsWith('.json') || name.endsWith('.xml') || name.endsWith('.csv')) {
      return false;
    }
    return true;
  });

  const totalBytes = actualFiles.reduce((sum, file) => sum + file.size, 0);
  const totalGB = totalBytes / (1024 * 1024 * 1024);

  return {
    totalBytes,
    totalGB,
    fileCount: actualFiles.length,
    exceedsLimit: totalBytes > MAX_TOTAL_SIZE_BYTES
  };
}

/**
 * Check if FileList contains any valid DICOM files or zip files (quick check without processing)
 */
export function hasValidDicomFiles(files: FileList): boolean {
  const filesArray = Array.from(files);
  return filesArray.some(file => {
    if (file.size === 0) return false;
    const name = file.name.toLowerCase();
    // Allow .zip files as they may contain DICOM files
    if (name.endsWith('.zip')) return true;
    // Skip known non-DICOM files
    return !name.endsWith('.txt') && !name.endsWith('.json') && !name.endsWith('.xml') && !name.endsWith('.csv');
  });
}

/**
 * Recursively get all files from a directory entry (for drag-and-drop folder uploads)
 */
export async function getAllFilesFromDirectory(dirEntry: FileSystemDirectoryEntry): Promise<File[]> {
  const files: File[] = [];

  return new Promise((resolve) => {
    const reader = dirEntry.createReader();

    const readEntries = () => {
      reader.readEntries(async (entries) => {
        if (entries.length === 0) {
          resolve(files);
          return;
        }

        for (const entry of entries) {
          if (entry.isFile) {
            const file = await new Promise<File>((fileResolve) => {
              (entry as FileSystemFileEntry).file(fileResolve);
            });
            files.push(file);
          } else if (entry.isDirectory) {
            const subFiles = await getAllFilesFromDirectory(entry as FileSystemDirectoryEntry);
            files.push(...subFiles);
          }
        }

        readEntries();
      });
    };

    readEntries();
  });
}