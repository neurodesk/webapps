import React from 'react';
import Modal from '../common/Modal';
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
  return (
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      title="DICOM Viewer"
      subtitle={acquisitionName}
      size="2xl"
    >
      {/* Viewer */}
      <NiivueViewer
        files={files}
        urls={urls}
        active={isOpen}
        height="70vh"
      />
    </Modal>
  );
};

export default DicomViewerModal;
