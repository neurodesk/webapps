import React from 'react';
import { X } from 'lucide-react';
import NiivueViewer from './NiivueViewer';

interface DicomViewerModalProps {
  isOpen: boolean;
  onClose: () => void;
  files?: File[];
  urls?: { url: string; name: string }[];
  acquisitionName: string;
}

const DicomViewerModal: React.FC<DicomViewerModalProps> = ({
  isOpen,
  onClose,
  files,
  urls,
  acquisitionName,
}) => {
  if (!isOpen) return null;

  return (
    <div
      className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center p-4 z-50"
      onClick={onClose}
    >
      <div
        className="bg-surface-primary rounded-lg shadow-xl max-w-5xl w-full max-h-[90vh] flex flex-col overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-3 border-b border-border flex-shrink-0">
          <div className="min-w-0">
            <h3 className="text-lg font-semibold text-content-primary">DICOM Viewer</h3>
            <p className="text-sm text-content-secondary truncate">{acquisitionName}</p>
          </div>
          <button
            onClick={onClose}
            className="p-1.5 text-content-tertiary hover:text-content-primary hover:bg-surface-secondary rounded-lg transition-colors"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        {/* Viewer */}
        <NiivueViewer
          files={files}
          urls={urls}
          active={isOpen}
          height="70vh"
        />
      </div>
    </div>
  );
};

export default DicomViewerModal;
