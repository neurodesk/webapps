import React from 'react';
import { UnifiedSchema } from '../../../hooks/useSchemaService';
import { AcquisitionSelection } from '../../../types';
import UnifiedSchemaSelector from '../../schema/UnifiedSchemaSelector';

interface SchemaLibraryPanelProps {
  librarySchemas: UnifiedSchema[];
  uploadedSchemas: UnifiedSchema[];
  pendingSchemaSelections: AcquisitionSelection[];
  getSchemaContent: (id: string) => Promise<string | null>;
  onSchemaToggle: (selection: AcquisitionSelection) => void;
  onConfirmSchemas: () => void;
  onSchemaReadmeClick: (schemaId: string, schemaName: string) => void;
  onAcquisitionReadmeClick: (schemaId: string, schemaName: string, acquisitionIndex: number) => void;
  onSchemaEdit: (schemaId: string) => void;
  onSchemaUpload: (file: File) => Promise<void>;
}

const SchemaLibraryPanel: React.FC<SchemaLibraryPanelProps> = ({
  librarySchemas,
  uploadedSchemas,
  pendingSchemaSelections,
  getSchemaContent,
  onSchemaToggle,
  onConfirmSchemas,
  onSchemaReadmeClick,
  onAcquisitionReadmeClick,
  onSchemaEdit,
  onSchemaUpload,
}) => {
  return (
    <div className="border border-border rounded-lg bg-surface-primary shadow-sm flex flex-col h-full">
      {/* Header */}
      <div className="px-4 py-3 border-b border-border">
        <h2 className="text-base font-semibold text-content-primary">Schema Library</h2>
        <p className="text-sm text-content-secondary">Select acquisitions to add to your workspace</p>
      </div>

      {/* Schema Browser */}
      <div className="flex-1 overflow-y-auto p-4">
        <UnifiedSchemaSelector
          librarySchemas={librarySchemas}
          uploadedSchemas={uploadedSchemas}
          selectionMode="acquisition"
          multiSelectMode={true}
          selectedAcquisitions={pendingSchemaSelections}
          onAcquisitionToggle={onSchemaToggle}
          expandable={true}
          getSchemaContent={getSchemaContent}
          enableDragDrop={true}
          onSchemaReadmeClick={onSchemaReadmeClick}
          onAcquisitionReadmeClick={onAcquisitionReadmeClick}
          onSchemaEdit={onSchemaEdit}
          onSchemaUpload={onSchemaUpload}
          onOpenSchema={(schemaId) => window.open(`${import.meta.env.BASE_URL}schema/${schemaId}`, '_blank')}
        />
      </div>

      {/* Footer with Add Button */}
      <div className="px-4 py-3 border-t border-border flex items-center justify-between bg-surface-secondary">
        <p className="text-sm text-content-secondary">
          {pendingSchemaSelections.length} selected
        </p>
        <button
          onClick={onConfirmSchemas}
          disabled={pendingSchemaSelections.length === 0}
          className={`px-4 py-2 rounded-lg ${
            pendingSchemaSelections.length === 0
              ? 'bg-surface-tertiary text-content-muted cursor-not-allowed'
              : 'bg-brand-600 text-content-inverted hover:bg-brand-700'
          }`}
        >
          Add {pendingSchemaSelections.length} Acquisition{pendingSchemaSelections.length !== 1 ? 's' : ''}
        </button>
      </div>
    </div>
  );
};

export default SchemaLibraryPanel;
