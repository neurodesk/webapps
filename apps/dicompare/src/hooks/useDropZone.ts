import { useState, useCallback } from 'react';
import { processDroppedFiles, filesToFileList } from '../utils/workspaceHelpers';

export interface UseDropZoneOptions {
  onDrop: (files: FileList) => void;
  disabled?: boolean;
}

export interface UseDropZoneReturn {
  isDragOver: boolean;
  handlers: {
    onDragOver: (e: React.DragEvent) => void;
    onDragLeave: (e: React.DragEvent) => void;
    onDrop: (e: React.DragEvent) => void;
  };
}

/**
 * Hook for handling drag-and-drop file uploads.
 * Eliminates duplicate drag handler sets.
 */
export function useDropZone({ onDrop, disabled = false }: UseDropZoneOptions): UseDropZoneReturn {
  const [isDragOver, setIsDragOver] = useState(false);

  const handleDragOver = useCallback((e: React.DragEvent) => {
    if (disabled) return;
    e.preventDefault();
    setIsDragOver(true);
  }, [disabled]);

  const handleDragLeave = useCallback((e: React.DragEvent) => {
    if (disabled) return;
    e.preventDefault();
    if (!e.currentTarget.contains(e.relatedTarget as Node)) {
      setIsDragOver(false);
    }
  }, [disabled]);

  const handleDrop = useCallback(async (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragOver(false);

    if (disabled) return;

    const files = await processDroppedFiles(e);
    if (files.length > 0) {
      onDrop(filesToFileList(files));
    }
  }, [disabled, onDrop]);

  return {
    isDragOver,
    handlers: {
      onDragOver: handleDragOver,
      onDragLeave: handleDragLeave,
      onDrop: handleDrop,
    },
  };
}
