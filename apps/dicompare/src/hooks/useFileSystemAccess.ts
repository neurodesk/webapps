/**
 * React hook for File System Access API operations.
 * Provides state and methods for directory/file picking with FSAA.
 */

import { useState, useEffect, useCallback } from 'react';
import {
  isFileSystemAccessSupported,
  isFilePickerSupported,
  pickDirectory,
  pickFiles,
  DirectoryPickerOptions,
  OpenFilePickerOptions,
} from '../utils/fileSystemAccessUtils';
import { FileHandleManager, BatchConfig, DEFAULT_BATCH_CONFIG } from '../utils/fileHandleManager';

export interface UseFileSystemAccessReturn {
  // Feature detection
  isDirectoryPickerSupported: boolean;
  isFilePickerSupported: boolean;

  // State
  isScanning: boolean;
  scanProgress: { scanned: number; currentPath: string } | null;
  lastError: string | null;

  // Methods
  pickAndScanDirectory: (options?: DirectoryPickerOptions) => Promise<FileHandleManager | null>;
  pickFilesWithHandles: (options?: OpenFilePickerOptions) => Promise<FileHandleManager | null>;
  clearError: () => void;
}

export function useFileSystemAccess(): UseFileSystemAccessReturn {
  const [isDirectoryPickerSupported, setIsDirectoryPickerSupported] = useState(false);
  const [isFilePickerSupportedState, setIsFilePickerSupportedState] = useState(false);
  const [isScanning, setIsScanning] = useState(false);
  const [scanProgress, setScanProgress] = useState<{ scanned: number; currentPath: string } | null>(null);
  const [lastError, setLastError] = useState<string | null>(null);

  // Check for FSAA support on mount
  useEffect(() => {
    setIsDirectoryPickerSupported(isFileSystemAccessSupported());
    setIsFilePickerSupportedState(isFilePickerSupported());
  }, []);

  const clearError = useCallback(() => {
    setLastError(null);
  }, []);

  /**
   * Open directory picker and scan for files
   */
  const pickAndScanDirectory = useCallback(
    async (options?: DirectoryPickerOptions): Promise<FileHandleManager | null> => {
      if (!isFileSystemAccessSupported()) {
        setLastError('File System Access API is not supported in this browser');
        return null;
      }

      setLastError(null);
      setIsScanning(true);
      setScanProgress({ scanned: 0, currentPath: '' });

      try {
        const dirHandle = await pickDirectory(options);

        if (!dirHandle) {
          // User cancelled
          setIsScanning(false);
          setScanProgress(null);
          return null;
        }

        const manager = new FileHandleManager();

        await manager.addFromDirectory(dirHandle, (scanned, path) => {
          setScanProgress({ scanned, currentPath: path });
        });

        setIsScanning(false);
        setScanProgress(null);

        if (manager.fileCount === 0) {
          setLastError('No valid DICOM files found in the selected directory');
          return null;
        }

        console.log(
          `[useFileSystemAccess] Scanned ${manager.fileCount} files (${manager.totalSizeGB.toFixed(2)} GB)`
        );

        return manager;
      } catch (error) {
        setIsScanning(false);
        setScanProgress(null);

        if (error instanceof Error) {
          if (error.name === 'NotAllowedError') {
            setLastError('Permission denied. Please allow access to the folder.');
          } else {
            setLastError(`Failed to scan directory: ${error.message}`);
          }
        } else {
          setLastError('An unknown error occurred');
        }

        return null;
      }
    },
    []
  );

  /**
   * Open file picker and create manager from handles
   */
  const pickFilesWithHandles = useCallback(
    async (options?: OpenFilePickerOptions): Promise<FileHandleManager | null> => {
      if (!isFilePickerSupported()) {
        setLastError('File picker API is not supported in this browser');
        return null;
      }

      setLastError(null);

      try {
        const handles = await pickFiles({
          multiple: true,
          ...options,
        });

        if (handles.length === 0) {
          // User cancelled
          return null;
        }

        const manager = new FileHandleManager();
        await manager.addFromHandles(handles);

        if (manager.fileCount === 0) {
          setLastError('No valid DICOM files found in the selection');
          return null;
        }

        console.log(
          `[useFileSystemAccess] Selected ${manager.fileCount} files (${manager.totalSizeGB.toFixed(2)} GB)`
        );

        return manager;
      } catch (error) {
        if (error instanceof Error) {
          if (error.name === 'NotAllowedError') {
            setLastError('Permission denied. Please allow access to the files.');
          } else {
            setLastError(`Failed to open files: ${error.message}`);
          }
        } else {
          setLastError('An unknown error occurred');
        }

        return null;
      }
    },
    []
  );

  return {
    isDirectoryPickerSupported,
    isFilePickerSupported: isFilePickerSupportedState,
    isScanning,
    scanProgress,
    lastError,
    pickAndScanDirectory,
    pickFilesWithHandles,
    clearError,
  };
}

/**
 * Utility hook for batch configuration
 */
export function useBatchConfig(initialConfig?: Partial<BatchConfig>) {
  const [config, setConfig] = useState<BatchConfig>({
    ...DEFAULT_BATCH_CONFIG,
    ...initialConfig,
  });

  const updateConfig = useCallback((updates: Partial<BatchConfig>) => {
    setConfig(prev => ({ ...prev, ...updates }));
  }, []);

  return { config, updateConfig };
}
