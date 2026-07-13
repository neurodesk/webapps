import React from 'react';
import { Trash2 } from 'lucide-react';

export interface DeleteConfirmModalProps {
  isOpen: boolean;
  schemaName: string;
  onConfirm: () => void;
  onCancel: () => void;
}

const DeleteConfirmModal: React.FC<DeleteConfirmModalProps> = ({
  isOpen,
  schemaName,
  onConfirm,
  onCancel
}) => {
  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center p-4 z-50">
      <div className="bg-surface-primary rounded-lg max-w-md w-full p-6">
        <div className="flex items-start mb-4">
          <div className="flex-shrink-0">
            <div className="h-12 w-12 rounded-full bg-status-error-bg flex items-center justify-center">
              <Trash2 className="h-6 w-6 text-status-error" />
            </div>
          </div>
          <div className="ml-4 flex-1">
            <h3 className="text-lg font-medium text-content-primary">Delete Schema</h3>
            <p className="mt-2 text-sm text-content-secondary">
              Are you sure you want to delete <strong>{schemaName}</strong>? This action cannot be undone.
            </p>
          </div>
        </div>
        <div className="flex justify-end space-x-3">
          <button
            onClick={onCancel}
            className="px-4 py-2 text-sm font-medium text-content-secondary bg-surface-primary border border-border-secondary rounded-md hover:bg-surface-secondary"
          >
            Cancel
          </button>
          <button
            onClick={onConfirm}
            className="px-4 py-2 text-sm font-medium text-content-inverted bg-status-error border border-transparent rounded-md hover:opacity-90"
          >
            Delete
          </button>
        </div>
      </div>
    </div>
  );
};

export default DeleteConfirmModal;
