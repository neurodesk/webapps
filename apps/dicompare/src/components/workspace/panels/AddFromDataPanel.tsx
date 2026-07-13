import React from 'react';
import { ShieldCheck } from 'lucide-react';
import { ProcessingProgress } from '../../../contexts/WorkspaceContext';
import { UseDropZoneReturn } from '../../../hooks/useDropZone';
import DropZone from '../../common/DropZone';

interface AddFromDataPanelProps {
  isProcessing: boolean;
  processingProgress: ProcessingProgress | null;
  processingTarget: 'schema' | 'data' | 'addNew' | null;
  schemaDropZone: UseDropZoneReturn;
  testDropZone: UseDropZoneReturn;
  onFileUpload: (files: FileList | null, mode?: 'schema-template' | 'validation-subject') => void;
  onLargeFolderBrowse?: (mode: 'schema-template' | 'validation-subject') => void;
  isLargeFolderSupported?: boolean;
  onStagedAttachSchema: () => void;
  onStagedCreateBlank: () => void;
}

const AddFromDataPanel: React.FC<AddFromDataPanelProps> = ({
  isProcessing,
  processingProgress,
  processingTarget,
  schemaDropZone,
  testDropZone,
  onFileUpload,
  onLargeFolderBrowse,
  isLargeFolderSupported = false,
  onStagedAttachSchema,
  onStagedCreateBlank,
}) => {
  return (
    <div className="bg-surface-primary rounded-lg border border-border shadow-sm">
      {/* Header with split layout */}
      <div className="px-6 py-4 border-b border-border">
        {/* Split layout: Reference (left) | Test data (right) */}
        <div className="grid grid-cols-2 gap-6">
          {/* Left side - Reference */}
          <div className="border-r border-border pr-6">
            <div className="flex items-center justify-between mb-3">
              <div className="text-xs font-medium text-content-tertiary uppercase tracking-wider">Reference</div>
            </div>
            {/* Reference attachment zone */}
            <div className="flex-1 min-w-0" data-tutorial="reference-dropzone">
              <DropZone
                variant="schema"
                isProcessing={isProcessing}
                processingProgress={processingProgress}
                processingTarget={processingTarget}
                onBrowse={(files) => onFileUpload(files, 'schema-template')}
                onLargeFolderBrowse={onLargeFolderBrowse ? () => onLargeFolderBrowse('schema-template') : undefined}
                isLargeFolderSupported={isLargeFolderSupported}
                dropZone={schemaDropZone}
                onLibraryClick={onStagedAttachSchema}
                onBlankClick={onStagedCreateBlank}
                showLibraryButton
                showBlankButton
                emptyLabel="No reference"
                fileInputId="staged-load-schema"
              />
            </div>
          </div>

          {/* Right side - Test data */}
          <div className="pl-0">
            <div className="flex items-center justify-between mb-3">
              <div className="text-xs font-medium text-content-tertiary uppercase tracking-wider">Test data</div>
            </div>
            {/* Data attachment zone */}
            <div className="flex-1 min-w-0" data-tutorial="test-data-dropzone">
              <DropZone
                variant="data"
                isProcessing={isProcessing}
                processingProgress={processingProgress}
                processingTarget={processingTarget}
                onBrowse={(files) => onFileUpload(files, 'validation-subject')}
                onLargeFolderBrowse={onLargeFolderBrowse ? () => onLargeFolderBrowse('validation-subject') : undefined}
                isLargeFolderSupported={isLargeFolderSupported}
                dropZone={testDropZone}
                emptyLabel="No test data"
                fileInputId="staged-load-data"
              />
            </div>
          </div>
        </div>
      </div>

      {/* Privacy notice - prominent */}
      <div className="px-6 py-4 bg-green-50 dark:bg-green-900/20 border-t border-green-200 dark:border-green-800">
        <p className="text-sm text-green-800 dark:text-green-200 flex items-center justify-center gap-2 font-medium">
          <ShieldCheck className="h-5 w-5 flex-shrink-0" />
          <span>Your data never leaves your computer — all processing happens locally in your browser</span>
        </p>
      </div>
    </div>
  );
};

export default AddFromDataPanel;
