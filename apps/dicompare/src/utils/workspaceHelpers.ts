import type { WorkspaceItem } from '../contexts/WorkspaceContext';
import { Acquisition } from '../types';
import { getAllFilesFromDirectory } from './fileUploadUtils';

/**
 * Derived state flags for a WorkspaceItem.
 * Eliminates repeated boolean logic across components.
 */
export interface ItemFlags {
  isEmptyItem: boolean;
  hasCreatedSchema: boolean;
  hasAttachedData: boolean;
  hasAttachedSchema: boolean;
  hasSchema: boolean;
  hasData: boolean;
  isUsedAsSchema: boolean;
}

/**
 * Compute derived state flags for a workspace item.
 * Use this instead of repeating the boolean logic in multiple components.
 */
export function getItemFlags(item: WorkspaceItem): ItemFlags {
  const isEmptyItem = item.source === 'empty';
  const hasCreatedSchema = item.hasCreatedSchema || false;
  const hasAttachedData = item.attachedData !== undefined;
  const hasAttachedSchema = item.attachedSchema !== undefined;

  // Item "has schema" if:
  // - It's schema-sourced (from library)
  // - It's data-sourced in schema-template mode (default mode)
  // - It's empty but user created a blank schema
  // - It has an attached schema from library
  const hasSchema = item.source === 'schema' ||
    (item.source === 'data' && item.dataUsageMode !== 'validation-subject') ||
    (isEmptyItem && hasCreatedSchema) ||
    hasAttachedSchema;

  // Item "has data" if:
  // - It's data-sourced in validation-subject mode
  // - It has attached data
  const hasData = (item.source === 'data' && item.dataUsageMode === 'validation-subject') ||
    hasAttachedData;

  // Item is "used as schema" when it represents the schema side
  // OR when it has an attached schema (for validation-subject items)
  const isUsedAsSchema = item.source === 'schema' ||
    (item.source === 'data' && item.dataUsageMode !== 'validation-subject') ||
    (isEmptyItem && hasCreatedSchema) ||
    (isEmptyItem && hasAttachedSchema) ||
    (item.source === 'data' && item.dataUsageMode === 'validation-subject' && hasAttachedSchema);

  return {
    isEmptyItem,
    hasCreatedSchema,
    hasAttachedData,
    hasAttachedSchema,
    hasSchema,
    hasData,
    isUsedAsSchema,
  };
}

/**
 * Create an empty acquisition object with sensible defaults.
 * Eliminates repeated empty acquisition creation pattern.
 */
export function createEmptyAcquisition(id: string, protocolName = ''): Acquisition {
  return {
    id,
    protocolName,
    seriesDescription: '',
    totalFiles: 0,
    acquisitionFields: [],
    series: [],
    metadata: {}
  };
}

/**
 * Convert an array of Files to a FileList.
 * Eliminates repeated DataTransfer pattern.
 */
export function filesToFileList(files: File[]): FileList {
  const dt = new DataTransfer();
  files.forEach(f => dt.items.add(f));
  return dt.files;
}

/**
 * Process dropped files, handling both files and directories.
 * Returns a flat array of all files.
 */
export async function processDroppedFiles(e: React.DragEvent): Promise<File[]> {
  // The DataTransfer is only readable synchronously during the drop event, so
  // pull every entry/file out of it before the first await.
  const dropped: Array<FileSystemDirectoryEntry | File> = [];
  for (const item of Array.from(e.dataTransfer.items)) {
    if (item.kind !== 'file') continue;
    const entry = item.webkitGetAsEntry();
    if (entry?.isDirectory) {
      dropped.push(entry as FileSystemDirectoryEntry);
    } else {
      const file = item.getAsFile();
      if (file) dropped.push(file);
    }
  }

  const files: File[] = [];
  for (const d of dropped) {
    if (d instanceof File) {
      files.push(d);
    } else {
      files.push(...(await getAllFilesFromDirectory(d)));
    }
  }
  return files;
}
