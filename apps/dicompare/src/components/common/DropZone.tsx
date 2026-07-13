import React from 'react';
import { Download, Loader, FolderOpen, Book, Plus, HardDrive } from 'lucide-react';
import { ProcessingProgress } from '../../contexts/WorkspaceContext';
import { UseDropZoneReturn } from '../../hooks/useDropZone';

export interface DropZoneProps {
  /** The variant determines visual styling */
  variant: 'schema' | 'data';
  /** Whether any processing is currently happening */
  isProcessing: boolean;
  /** Current processing progress (if processing) */
  processingProgress?: ProcessingProgress | null;
  /** Which target is currently processing */
  processingTarget?: 'schema' | 'data' | 'addNew' | null;
  /** Handler when files are selected via browse button */
  onBrowse: (files: FileList) => void;
  /** Handler for FSAA large folder browse (for datasets >2GB) */
  onLargeFolderBrowse?: () => void;
  /** Whether FSAA large folder browse is supported */
  isLargeFolderSupported?: boolean;
  /** Drop zone hook return value */
  dropZone: UseDropZoneReturn;
  /** Handler for Library button click */
  onLibraryClick?: () => void;
  /** Handler for Blank button click */
  onBlankClick?: () => void;
  /** Whether to show the Library button */
  showLibraryButton?: boolean;
  /** Whether to show the Blank button */
  showBlankButton?: boolean;
  /** Label shown when empty (e.g., "No reference") */
  emptyLabel?: string;
  /** Description shown when empty */
  emptyDescription?: string;
  /** Unique ID for the file input */
  fileInputId: string;
  /** Accepted file types */
  acceptedFiles?: string;
  /** Extra classes for the drop container (e.g. to fill available height) */
  className?: string;
}

const DropZone: React.FC<DropZoneProps> = ({
  variant,
  isProcessing,
  processingProgress,
  processingTarget,
  onBrowse,
  onLargeFolderBrowse,
  isLargeFolderSupported = false,
  dropZone,
  onLibraryClick,
  onBlankClick,
  showLibraryButton = false,
  showBlankButton = false,
  emptyLabel = 'No data',
  emptyDescription = 'Drop DICOMs or protocols (.pro, .exar1, ExamCard, Siemens print protocol .xml/.txt), plus diffusion gradients (.dvs/.bvec/.bval)',
  fileInputId,
  acceptedFiles = '.dcm,.dicom,.zip,.pro,.exar1,.ExamCard,.examcard,LxProtocol,.xml,.txt,.dvs,.bvec,.bval',
  className = '',
}) => {
  // Determine if this zone is disabled (other zone is processing)
  const isDisabled = isProcessing && processingTarget !== variant;
  // Determine if this zone is actively processing
  const isActivelyProcessing = isProcessing && processingTarget === variant;

  const containerClasses = `border-2 border-dashed rounded-lg p-4 text-center transition-colors ${className} ${
    isDisabled
      ? 'border-border-secondary bg-surface-tertiary/50 opacity-50 cursor-not-allowed'
      : dropZone.isDragOver
        ? 'border-brand-500 bg-brand-50 dark:bg-brand-900/20'
        : 'border-border-secondary hover:border-brand-400 bg-surface-secondary/50'
  }`;

  return (
    <div
      className={containerClasses}
      {...(isDisabled ? {} : dropZone.handlers)}
    >
      {isActivelyProcessing ? (
        <>
          <Loader className="h-6 w-6 text-brand-600 mx-auto mb-2 animate-spin" />
          <p className="text-sm font-medium text-content-secondary mb-1">
            {processingProgress?.currentOperation || 'Processing...'}
          </p>
          {processingProgress && (
            <div className="w-full max-w-[120px] mx-auto">
              <div className="w-full bg-surface-tertiary rounded-full h-1.5">
                <div
                  className="bg-brand-600 h-1.5 rounded-full transition-all duration-500"
                  style={{ width: `${processingProgress.percentage}%` }}
                />
              </div>
            </div>
          )}
        </>
      ) : (
        <>
          <Download
            className={`h-6 w-6 mx-auto mb-2 ${
              dropZone.isDragOver ? 'text-brand-600' : 'text-content-muted'
            }`}
          />
          <p className="text-sm font-medium text-content-secondary mb-1">
            {emptyLabel}
          </p>
          <p className="text-xs text-content-tertiary mb-3">
            {emptyDescription}
          </p>
          <div className="flex flex-wrap items-center justify-center gap-2">
            <input
              type="file"
              multiple
              webkitdirectory=""
              accept={acceptedFiles}
              className="hidden"
              id={fileInputId}
              disabled={isProcessing}
              onChange={(e) => {
                if (e.target.files) {
                  onBrowse(e.target.files);
                }
              }}
            />
            <label
              htmlFor={fileInputId}
              className={`inline-flex items-center px-2.5 py-1.5 text-sm font-medium rounded-md ${
                isProcessing
                  ? 'bg-gray-400 text-gray-200 cursor-not-allowed'
                  : 'text-content-inverted bg-brand-600 hover:bg-brand-700 cursor-pointer'
              }`}
            >
              <FolderOpen className="h-4 w-4 mr-1" />
              Browse
            </label>
            {isLargeFolderSupported && onLargeFolderBrowse && (
              <button
                onClick={onLargeFolderBrowse}
                disabled={isProcessing}
                title="For datasets larger than 2GB. Uses streaming to avoid memory limits."
                className={`inline-flex items-center px-2.5 py-1.5 text-sm font-medium rounded-md border ${
                  isProcessing
                    ? 'border-gray-300 text-gray-400 cursor-not-allowed'
                    : 'border-brand-600 text-brand-600 hover:bg-brand-50 dark:hover:bg-brand-900/20'
                }`}
              >
                <HardDrive className="h-4 w-4 mr-1" />
                Large Folder
              </button>
            )}
            {showLibraryButton && onLibraryClick && (
              <button
                data-tutorial="library-button"
                onClick={onLibraryClick}
                disabled={isProcessing}
                className={`inline-flex items-center px-2.5 py-1.5 text-sm font-medium rounded-md border ${
                  isProcessing
                    ? 'border-gray-300 text-gray-400 cursor-not-allowed'
                    : 'border-brand-600 text-brand-600 hover:bg-brand-50 dark:hover:bg-brand-900/20'
                }`}
              >
                <Book className="h-4 w-4 mr-1" />
                Library
              </button>
            )}
            {showBlankButton && onBlankClick && (
              <button
                data-tutorial="blank-button"
                onClick={onBlankClick}
                disabled={isProcessing}
                className={`inline-flex items-center px-2.5 py-1.5 text-sm font-medium rounded-md border ${
                  isProcessing
                    ? 'border-gray-300 text-gray-400 cursor-not-allowed'
                    : 'border-border-secondary text-content-secondary hover:bg-surface-secondary'
                }`}
              >
                <Plus className="h-4 w-4 mr-1" />
                Blank
              </button>
            )}
          </div>
        </>
      )}
    </div>
  );
};

export default DropZone;
