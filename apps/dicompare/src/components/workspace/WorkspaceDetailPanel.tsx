import React, { useCallback, useState, useEffect, useRef } from 'react';
import { FileText, Edit2, Save, Database, X, Book, Printer, ImageIcon } from 'lucide-react';
import { WorkspaceItem, ProcessingProgress, SchemaMetadata } from '../../contexts/WorkspaceContext';
import { UnifiedSchema } from '../../hooks/useSchemaService';
import { Acquisition, AcquisitionSelection } from '../../types';
import { ComplianceFieldResult } from '../../types/schema';
import AcquisitionTable from '../schema/AcquisitionTable';
import InlineTagInput from '../common/InlineTagInput';
import DetailedDescriptionModal from '../schema/DetailedDescriptionModal';
import ImageManagerModal from '../schema/ImageManagerModal';
import SchemaReadmeModal, { ReadmeItem } from '../schema/SchemaReadmeModal';

import { useWorkspace } from '../../contexts/WorkspaceContext';
import { useSchemaContext } from '../../contexts/SchemaContext';
import { useTagSuggestions } from '../../hooks/useTagSuggestions';
import { convertSchemaToAcquisition } from '../../utils/schemaToAcquisition';
import { buildReadmeItems } from '../../utils/readmeHelpers';
import { fetchAndParseSchema } from '../../utils/schemaHelpers';
import { getItemFlags } from '../../utils/workspaceHelpers';
import { dicomFileCache } from '../../utils/dicomFileCache';
import { generatePrintReportHtml, openPrintWindow, isElectron, exportToPdf, PrintSectionOptions } from '../../utils/printReportGenerator';
import PrintOptionsModal from '../common/PrintOptionsModal';
import { useDropZone } from '../../hooks/useDropZone';
import GradientDropZone from './GradientDropZone';
import DropZone from '../common/DropZone';
import { SchemaLibraryPanel, AddFromDataPanel, SchemaInfoPanel, MatchingPanel } from './panels';
import type { SchemaInfoTab } from './panels';

export type { SchemaInfoTab };

interface WorkspaceDetailPanelProps {
  selectedItem: WorkspaceItem | undefined;
  isAddNew: boolean;
  isAddFromData: boolean;
  isSchemaInfo: boolean;
  isAssignData: boolean;
  schemaInfoTab: SchemaInfoTab;
  setSchemaInfoTab: (tab: SchemaInfoTab) => void;
  isProcessing: boolean;
  processingProgress: ProcessingProgress | null;
  pendingSchemaSelections: AcquisitionSelection[];
  librarySchemas: UnifiedSchema[];
  uploadedSchemas: UnifiedSchema[];
  schemaMetadata: SchemaMetadata | null;
  getSchemaContent: (id: string) => Promise<string | null>;
  getUnifiedSchema: (id: string) => UnifiedSchema | null;
  onSchemaToggle: (selection: AcquisitionSelection) => void;
  onConfirmSchemas: () => void;
  onFileUpload: (files: FileList | null, mode?: 'schema-template' | 'validation-subject') => void;
  onLargeFolderBrowse?: (mode: 'schema-template' | 'validation-subject') => void;
  isLargeFolderSupported?: boolean;
  onCreateSchema: () => void;  // Create schema for current empty item
  onDetachCreatedSchema: () => void;  // Detach created schema from current item
  onToggleEditing: () => void;
  onAttachData: (files: FileList) => void;
  onUploadSchemaForItem: (files: FileList) => void;  // Upload DICOMs to build schema for current item
  onDetachData: () => void;
  onDetachValidationData: () => void;
  onAttachSchema: () => void;
  onDetachSchema: () => void;
  onGenerateTestData: () => void;
  onRemove: () => void;
  onUpdateAcquisition: (updates: Partial<Acquisition>) => void;
  onUpdateSchemaMetadata: (updates: Partial<SchemaMetadata>) => void;
  onSchemaReadmeClick: (schemaId: string, schemaName: string) => void;
  onAcquisitionReadmeClick: (schemaId: string, schemaName: string, acquisitionIndex: number) => void;
  // Staged "from data" handlers - create item first, then perform action
  onStagedCreateBlank: () => void;
  onStagedAttachSchema: () => void;
  // Matching panel props
  matchingData?: {
    uploadedAcquisitions: Acquisition[];
    availableSlots: Array<{ itemId: string; item: WorkspaceItem }>;
    initialAssignments?: Array<{ uploadedIndex: number; itemId: string }>;
  };
  onConfirmMatching?: (matches: Array<{ uploadedIndex: number; itemId: string | null }>) => void;
}

const WorkspaceDetailPanel: React.FC<WorkspaceDetailPanelProps> = ({
  selectedItem,
  isAddNew,
  isAddFromData,
  isSchemaInfo,
  isAssignData,
  schemaInfoTab,
  setSchemaInfoTab,
  isProcessing,
  processingProgress,
  pendingSchemaSelections,
  librarySchemas,
  uploadedSchemas,
  schemaMetadata,
  getSchemaContent,
  getUnifiedSchema,
  onSchemaToggle,
  onConfirmSchemas,
  onFileUpload,
  onLargeFolderBrowse,
  isLargeFolderSupported = false,
  onCreateSchema,
  onDetachCreatedSchema,
  onToggleEditing,
  onAttachData,
  onUploadSchemaForItem,
  onDetachData,
  onDetachValidationData,
  onAttachSchema,
  onDetachSchema,
  onGenerateTestData,
  onRemove,
  onUpdateAcquisition,
  onUpdateSchemaMetadata,
  onSchemaReadmeClick,
  onAcquisitionReadmeClick,
  onStagedCreateBlank,
  onStagedAttachSchema,
  matchingData,
  onConfirmMatching,
}) => {
  const workspace = useWorkspace();
  const { processingTarget } = workspace;
  const { uploadSchema } = useSchemaContext();
  const { allTags } = useTagSuggestions();

  // Drop zones using shared hook
  const mainDropZone = useDropZone({
    onDrop: (files) => isAddNew ? onFileUpload(files) : onAttachData(files),
    disabled: isProcessing,
  });
  const referenceDropZone = useDropZone({
    onDrop: (files) => onFileUpload(files, 'schema-template'),
    disabled: isProcessing,
  });
  const schemaDropZone = useDropZone({
    onDrop: (files) => {
      // For empty items or validation-subject items needing a schema, upload to current item
      const shouldUploadToCurrentItem = selectedItem?.source === 'empty' ||
        (selectedItem?.dataUsageMode === 'validation-subject' && !selectedItem?.attachedSchema);
      if (shouldUploadToCurrentItem) {
        onUploadSchemaForItem(files);
      } else {
        onFileUpload(files, 'schema-template');
      }
    },
    disabled: isProcessing,
  });
  const testDropZone = useDropZone({
    onDrop: (files) => onFileUpload(files, 'validation-subject'),
    disabled: isProcessing,
  });

  // Modal and editing state
  const [showDetailedDescription, setShowDetailedDescription] = useState(false);
  const [showImageManager, setShowImageManager] = useState(false);
  const [imageManagerInitialTab, setImageManagerInitialTab] = useState<'reference' | 'schema' | 'test' | undefined>(undefined);
  const [imageManagerInitialMatchFiles, setImageManagerInitialMatchFiles] = useState<File[] | undefined>(undefined);
  const [showTestDataNotes, setShowTestDataNotes] = useState(false);
  const [showPrintOptions, setShowPrintOptions] = useState(false);
  const [loadedSchemaAcquisition, setLoadedSchemaAcquisition] = useState<Acquisition | null>(null);

  // Use a ref to store latest compliance results for print view (refs update synchronously)
  const complianceResultsRef = useRef<ComplianceFieldResult[]>([]);

  // Schema README modal state (with sidebar showing all acquisitions from schema)
  const [showReadmeModal, setShowReadmeModal] = useState(false);
  const [readmeModalData, setReadmeModalData] = useState<{
    schemaName: string;
    readmeItems: ReadmeItem[];
    initialSelection: string;
  } | null>(null);

  // Load schema acquisition when attachedSchema changes (for data-sourced or empty items)
  useEffect(() => {
    if ((selectedItem?.source === 'data' || selectedItem?.source === 'empty') && selectedItem?.attachedSchema) {
      const loadSchemaAcquisition = async () => {
        const schemaAcq = await convertSchemaToAcquisition(
          selectedItem.attachedSchema!.schema,
          selectedItem.attachedSchema!.acquisitionId || '0',
          getSchemaContent
        );
        setLoadedSchemaAcquisition(schemaAcq);
      };
      loadSchemaAcquisition();
    } else {
      setLoadedSchemaAcquisition(null);
    }
  }, [selectedItem?.id, selectedItem?.source, selectedItem?.attachedSchema?.schemaId, selectedItem?.attachedSchema?.acquisitionId, getSchemaContent]);

  // Clear cached compliance results when the reference (schema or data) changes
  // This prevents stale results from appearing in print view after switching references
  useEffect(() => {
    complianceResultsRef.current = [];
  }, [selectedItem?.id, selectedItem?.attachedSchema?.schemaId, selectedItem?.attachedSchema?.acquisitionId, selectedItem?.attachedData?.protocolName]);

  // Open README with sidebar showing all acquisitions from the schema
  const openReadmeWithSidebar = async () => {
    if (!selectedItem) return;

    // Determine which schema to use
    const schemaId = selectedItem.schemaOrigin?.schemaId || selectedItem.attachedSchema?.schemaId;
    const acquisitionIndex = selectedItem.schemaOrigin?.acquisitionIndex ??
      (selectedItem.attachedSchema?.acquisitionId ? parseInt(selectedItem.attachedSchema.acquisitionId) : 0);

    if (!schemaId) {
      // No schema context - fall back to simple modal
      setShowDetailedDescription(true);
      return;
    }

    const schemaData = await fetchAndParseSchema(schemaId, getSchemaContent);
    if (schemaData) {
      const schemaName = schemaData.name || selectedItem.schemaOrigin?.schemaName ||
        selectedItem.attachedSchema?.schema.name || 'Schema';
      setReadmeModalData({
        schemaName,
        readmeItems: buildReadmeItems(schemaData, schemaName),
        initialSelection: `acquisition-${acquisitionIndex}`
      });
      setShowReadmeModal(true);
    } else {
      // Fallback to simple modal if schema content unavailable
      setShowDetailedDescription(true);
    }
  };

  // Handle editing a schema (load entire schema into workspace)
  const handleSchemaEdit = useCallback(async (schemaId: string) => {
    // Check if workspace has unsaved changes
    if (workspace.items.length > 0) {
      const confirmLoad = window.confirm(
        'Loading a schema will replace your current workspace. Continue?'
      );
      if (!confirmLoad) return;
    }

    await workspace.loadSchema(schemaId, getSchemaContent, getUnifiedSchema);
  }, [workspace, getSchemaContent, getUnifiedSchema]);

  // Handle schema upload from the schema selector
  const handleSchemaUpload = useCallback(async (file: File) => {
    try {
      await uploadSchema(file);
    } catch (error) {
      console.error('Failed to upload schema:', error);
    }
  }, [uploadSchema]);

  // State for PDF export status
  const [pdfExporting, setPdfExporting] = useState(false);

  // Print acquisition (browser) or export to PDF (Electron)
  const handlePrintAcquisition = useCallback(async (sections?: PrintSectionOptions) => {
    if (!selectedItem) return;

    setPdfExporting(true);
    try {
      const html = await generatePrintReportHtml({
        selectedItem,
        loadedSchemaAcquisition,
        complianceResults: complianceResultsRef.current,
        schemaMetadata,
        dicomFiles: selectedItem.dicomFileBatchId
          ? dicomFileCache.get(selectedItem.dicomFileBatchId)
          : undefined,
        testDicomFiles: selectedItem.attachedDataBatchId
          ? dicomFileCache.get(selectedItem.attachedDataBatchId)
          : undefined,
        sections,
      });

      // In Electron, export to PDF
      if (isElectron()) {
        const filename = `${selectedItem.acquisition.protocolName || 'acquisition'}-report.pdf`;
        const result = await exportToPdf(html, filename);
        if (!result.success && result.message !== 'Export cancelled') {
          alert(result.message || 'Failed to export PDF');
        }
      } else {
        // In browser, open print window
        if (!openPrintWindow(html)) {
          alert('Please allow popups to print the acquisition.');
        }
      }
    } finally {
      setPdfExporting(false);
      setShowPrintOptions(false);
    }
  }, [selectedItem, loadedSchemaAcquisition, schemaMetadata]);

  // Render Matching Panel for assigning data to references
  if (isAssignData && matchingData && onConfirmMatching) {
    // Generate a key that changes when items change to force remount and fresh state
    const matchingKey = [
      ...matchingData.availableSlots.map(s => s.itemId),
      ...matchingData.uploadedAcquisitions.map(a => a.id || a.protocolName)
    ].join('|');

    return (
      <MatchingPanel
        key={matchingKey}
        uploadedAcquisitions={matchingData.uploadedAcquisitions}
        availableSlots={matchingData.availableSlots}
        initialAssignments={matchingData.initialAssignments}
        onConfirm={onConfirmMatching}
      />
    );
  }

  // Render Schema Info editing view
  if (isSchemaInfo) {
    return (
      <SchemaInfoPanel
        schemaInfoTab={schemaInfoTab}
        setSchemaInfoTab={setSchemaInfoTab}
        schemaMetadata={schemaMetadata}
        getSchemaContent={getSchemaContent}
        onUpdateSchemaMetadata={onUpdateSchemaMetadata}
      />
    );
  }

  // Render Schema Library browser
  if (isAddNew) {
    return (
      <SchemaLibraryPanel
        librarySchemas={librarySchemas}
        uploadedSchemas={uploadedSchemas}
        pendingSchemaSelections={pendingSchemaSelections}
        getSchemaContent={getSchemaContent}
        onSchemaToggle={onSchemaToggle}
        onConfirmSchemas={onConfirmSchemas}
        onSchemaReadmeClick={onSchemaReadmeClick}
        onAcquisitionReadmeClick={onAcquisitionReadmeClick}
        onSchemaEdit={handleSchemaEdit}
        onSchemaUpload={handleSchemaUpload}
      />
    );
  }

  // Render staged "From Data" view - same layout as empty item but not yet in list
  if (isAddFromData) {
    return (
      <AddFromDataPanel
        isProcessing={isProcessing}
        processingProgress={processingProgress}
        processingTarget={processingTarget}
        schemaDropZone={schemaDropZone}
        testDropZone={testDropZone}
        onFileUpload={onFileUpload}
        onLargeFolderBrowse={onLargeFolderBrowse}
        isLargeFolderSupported={isLargeFolderSupported}
        onStagedAttachSchema={onStagedAttachSchema}
        onStagedCreateBlank={onStagedCreateBlank}
      />
    );
  }

  // Use shared helper for derived state
  const {
    isEmptyItem,
    hasCreatedSchema,
    hasAttachedData,
    hasAttachedSchema,
    hasSchema,
    hasData,
    isUsedAsSchema,
  } = getItemFlags(selectedItem);

  const canEdit = hasSchema;

  // Helper to render acquisition info panel
  const renderAcquisitionInfo = (isSchema: boolean) => {
    const isEditable = selectedItem.isEditing && canEdit && !hasAttachedData && !hasAttachedSchema;
    const icon = isSchema ? (
      <FileText className="h-5 w-5 text-brand-600" />
    ) : (
      <Database className="h-5 w-5 text-amber-600" />
    );

    // For items with attached schema, use the loaded schema acquisition for display
    const displayAcquisition = (isSchema && hasAttachedSchema && loadedSchemaAcquisition)
      ? loadedSchemaAcquisition
      : selectedItem.acquisition;

    return (
      <div className="flex-1 min-w-0">
        <div className="flex items-start gap-3">
          <div className={`p-2 rounded-lg flex-shrink-0 ${isSchema ? 'bg-brand-100 dark:bg-brand-900/30' : 'bg-amber-100 dark:bg-amber-900/30'}`}>
            {icon}
          </div>
          <div className="flex-1 min-w-0">
            {isEditable ? (
              <div className="space-y-1">
                <input
                  type="text"
                  value={selectedItem.acquisition.protocolName || ''}
                  onChange={(e) => onUpdateAcquisition({ protocolName: e.target.value })}
                  className="text-lg font-semibold text-content-primary bg-surface-primary border border-border-secondary rounded px-2 py-1 w-full focus:outline-none focus:ring-1 focus:ring-brand-500"
                  placeholder="Acquisition Name"
                  data-tutorial="acquisition-name-input"
                />
                <input
                  type="text"
                  value={selectedItem.acquisition.seriesDescription || ''}
                  onChange={(e) => onUpdateAcquisition({ seriesDescription: e.target.value })}
                  className="text-sm text-content-secondary bg-surface-primary border border-border-secondary rounded px-2 py-1 w-full focus:outline-none focus:ring-1 focus:ring-brand-500"
                  placeholder="Short description"
                  data-tutorial="acquisition-description-input"
                />
              </div>
            ) : (
              <>
                <h4 className="text-lg font-semibold text-content-primary truncate">
                  {displayAcquisition.protocolName || 'Untitled Acquisition'}
                </h4>
                <p className="text-sm text-content-secondary truncate">
                  {displayAcquisition.seriesDescription || 'No description'}
                </p>
              </>
            )}
            {/* Origin info for schema-sourced items */}
            {isSchema && selectedItem.schemaOrigin && (
              <p className="text-xs text-content-tertiary mt-1 truncate">
                From {selectedItem.schemaOrigin.schemaName}
              </p>
            )}
            {/* Origin info for items with attached schema */}
            {isSchema && hasAttachedSchema && selectedItem.attachedSchema && (
              <p className="text-xs text-content-tertiary mt-1 truncate">
                From {selectedItem.attachedSchema.schema?.name || 'Schema'}
              </p>
            )}
            {/* Source indicator for data items */}
            {!isSchema && selectedItem.source === 'data' && (
              <p className="text-xs text-content-tertiary mt-1">
                {selectedItem.dataUsageMode === 'validation-subject' ? 'Data attached for validation' : 'Reference data'}
              </p>
            )}
          </div>
        </div>
        {/* Tags - only show in schema panel */}
        {isSchema && (selectedItem.isEditing || (selectedItem.acquisition.tags && selectedItem.acquisition.tags.length > 0)) && (
          <div className="mt-3 pl-12">
            <InlineTagInput
              tags={selectedItem.acquisition.tags || []}
              onChange={(tags) => onUpdateAcquisition({ tags })}
              suggestions={allTags}
              placeholder="Add tags..."
              disabled={!selectedItem.isEditing || hasAttachedData || hasAttachedSchema}
            />
          </div>
        )}
        {/* Supplementary diffusion gradient files - shown for diffusion
            acquisitions on both the Reference and Test data sides. */}
        {!hasAttachedData && !hasAttachedSchema &&
          (selectedItem.acquisition.acquisitionFields || []).some(
            f => (f.keyword || f.name) === 'DiffusionBValue' || (f.keyword || f.name) === 'DiffusionDirectionSet'
          ) && (
          <div className="mt-3 pl-12">
            <GradientDropZone
              acquisition={selectedItem.acquisition}
              onUpdateAcquisition={onUpdateAcquisition}
            />
          </div>
        )}
      </div>
    );
  };

  // Helper to render attachment zone (for missing schema or data)
  const renderAttachmentZone = (type: 'schema' | 'data') => {
    const isSchemaZone = type === 'schema';

    if (isSchemaZone) {
      // Schema attachment zone (for validation-subject items)
      if (hasAttachedSchema && selectedItem.attachedSchema) {
        // Show attached schema info
        return (
          <div className="flex-1 min-w-0">
            <div className="flex items-start gap-3">
              <div className="p-2 rounded-lg flex-shrink-0 bg-brand-100 dark:bg-brand-900/30">
                <FileText className="h-5 w-5 text-brand-600" />
              </div>
              <div className="flex-1 min-w-0">
                <h4 className="text-lg font-semibold text-content-primary truncate">
                  {selectedItem.attachedSchema.schema?.name || 'Schema'}
                </h4>
                {selectedItem.attachedSchema.acquisitionName && (
                  <p className="text-sm text-content-secondary truncate">
                    {selectedItem.attachedSchema.acquisitionName}
                  </p>
                )}
                <p className="text-xs text-content-tertiary mt-1">
                  Schema attached for validation
                </p>
              </div>
            </div>
          </div>
        );
      }
      // Show schema attachment/creation prompt with upload option
      const handleSchemaBrowse = (files: FileList) => {
        // For empty items or validation-subject items needing a schema,
        // load to the current item (preserving attachedData)
        // For other cases, create new items
        const shouldLoadToCurrentItem = isEmptyItem ||
          (selectedItem.dataUsageMode === 'validation-subject' && !hasSchema);
        if (shouldLoadToCurrentItem) {
          onUploadSchemaForItem(files);
        } else {
          onFileUpload(files, 'schema-template');
        }
      };

      return (
        <div className="flex-1 min-w-0">
          <DropZone
            variant="schema"
            isProcessing={isProcessing}
            processingProgress={processingProgress}
            processingTarget={processingTarget}
            onBrowse={handleSchemaBrowse}
            dropZone={schemaDropZone}
            onLibraryClick={onAttachSchema}
            onBlankClick={onCreateSchema}
            showLibraryButton
            showBlankButton={!hasAttachedData && isEmptyItem}
            emptyLabel="No reference"
            fileInputId={`load-schema-ref-${selectedItem.id}`}
            className="h-full flex flex-col items-center justify-center"
          />
        </div>
      );
    } else {
      // Data attachment zone (for schema items)
      if (hasAttachedData && selectedItem.attachedData) {
        // Show attached data info
        return (
          <div className="flex-1 min-w-0">
            <div className="flex items-start gap-3">
              <div className="p-2 rounded-lg flex-shrink-0 bg-amber-100 dark:bg-amber-900/30">
                <Database className="h-5 w-5 text-amber-600" />
              </div>
              <div className="flex-1 min-w-0">
                <h4 className="text-lg font-semibold text-content-primary">
                  {selectedItem.attachedData.protocolName || 'DICOM Data'}
                </h4>
                <p className="text-sm text-content-secondary truncate">
                  {selectedItem.attachedData.seriesDescription || `${selectedItem.attachedData.totalFiles || 0} files`}
                </p>
                <p className="text-xs text-content-tertiary mt-1">
                  Data attached for validation
                </p>
              </div>
            </div>
          </div>
        );
      }
      // Show data attachment prompt with drop zone
      return (
        <div className="flex-1 min-w-0" data-tutorial="item-test-data-dropzone">
          <DropZone
            variant="data"
            isProcessing={isProcessing}
            processingProgress={processingProgress}
            processingTarget={processingTarget}
            onBrowse={onAttachData}
            dropZone={mainDropZone}
            emptyLabel="No test data"
            fileInputId={`load-data-${selectedItem.id}`}
            className="h-full flex flex-col items-center justify-center"
          />
        </div>
      );
    }
  };

  return (
    <div className="bg-surface-primary rounded-lg border border-border shadow-sm relative flex flex-col h-[calc(100vh-130px)] max-h-[calc(100vh-130px)]">
      {/* Print/Export PDF button as floating tab extending upward */}
      <button
        data-tutorial="print-button"
        onClick={() => setShowPrintOptions(true)}
        className="absolute -top-7 right-4 inline-flex items-center px-2.5 py-1.5 text-xs rounded-t border border-b-0 border-border bg-surface-primary z-10 text-content-secondary hover:bg-surface-secondary hover:text-content-primary"
        title={isElectron() ? "Export acquisition report as PDF" : "Print acquisition report"}
      >
        <Printer className="h-3.5 w-3.5 mr-1" />
        {isElectron() ? 'Export PDF' : 'Print'}
      </button>

      {/* Header with split layout - fixed height */}
      <div className="px-6 py-4 border-b border-border flex-shrink-0">
        {/* Split layout: Schema (left) | Data (right) */}
        <div className="grid grid-cols-2 gap-6">
          {/* Left side - Schema */}
          <div className="border-r border-border pr-6 flex flex-col">
            <div className="flex items-center justify-between mb-3">
              {/* Left: label */}
              <div className="text-xs font-medium text-content-tertiary uppercase tracking-wider">Reference</div>
              {/* Right: README, Edit, and X buttons */}
              {isUsedAsSchema && (
                <div className="flex items-center gap-1.5">
                  {/* Images button */}
                  <button
                    onClick={() => setShowImageManager(true)}
                    className="inline-flex items-center px-2 py-1 border text-xs rounded border-border-secondary text-content-secondary hover:bg-surface-secondary"
                    title="View/edit images"
                  >
                    <ImageIcon className="h-3.5 w-3.5 mr-1" />
                    Images
                  </button>

                  {/* README button - always opens editable modal */}
                  <button
                    onClick={() => setShowDetailedDescription(true)}
                    className={`inline-flex items-center px-2 py-1 border text-xs rounded ${
                      selectedItem.acquisition.detailedDescription
                        ? 'text-blue-700 border-blue-500/30 bg-blue-50 hover:bg-blue-100 dark:text-blue-400 dark:bg-blue-900/20 dark:hover:bg-blue-900/30'
                        : 'border-border-secondary text-content-secondary hover:bg-surface-secondary'
                    }`}
                    title={selectedItem.acquisition.detailedDescription ? 'View/edit README' : 'Add README'}
                    data-tutorial="readme-button"
                  >
                    <Book className="h-3.5 w-3.5 mr-1" />
                    README
                  </button>

                  {/* Edit toggle */}
                  {canEdit && (
                    <button
                      onClick={onToggleEditing}
                      disabled={hasAttachedData}
                      className={`inline-flex items-center px-2 py-1 border text-xs rounded ${
                        hasAttachedData
                          ? 'border-border-secondary text-content-muted cursor-not-allowed opacity-50'
                          : selectedItem.isEditing
                            ? 'border-brand-500 text-brand-600 bg-brand-50 dark:bg-brand-900/20'
                            : 'border-border-secondary text-content-secondary hover:bg-surface-secondary'
                      }`}
                      title={hasAttachedData ? "Detach data to edit" : undefined}
                      data-tutorial="edit-button"
                    >
                      {selectedItem.isEditing ? (
                        <>
                          <Save className="h-3.5 w-3.5 mr-1" />
                          Save
                        </>
                      ) : (
                        <>
                          <Edit2 className="h-3.5 w-3.5 mr-1" />
                          Edit
                        </>
                      )}
                    </button>
                  )}

                  {/* Detach X button - consolidated from multiple conditions */}
                  {!selectedItem.isEditing && isUsedAsSchema && (
                    <button
                      onClick={() => {
                        if (isEmptyItem && hasCreatedSchema) {
                          onDetachCreatedSchema();
                        } else {
                          onDetachSchema();
                        }
                      }}
                      className="inline-flex items-center p-1 text-content-tertiary hover:text-red-600 rounded hover:bg-red-50 dark:hover:bg-red-900/20"
                      title={isEmptyItem && hasCreatedSchema ? "Remove schema" : "Detach schema"}
                    >
                      <X className="h-3.5 w-3.5" />
                    </button>
                  )}
                </div>
              )}
            </div>
            {isUsedAsSchema ? (
              // This item IS the schema - show its info
              renderAcquisitionInfo(true)
            ) : (
              // This item is data - show schema attachment zone
              renderAttachmentZone('schema')
            )}
          </div>

          {/* Right side - Data */}
          <div className="pl-0 flex flex-col">
            <div className="flex items-center justify-between mb-3">
              {/* Left: label */}
              <div className="text-xs font-medium text-content-tertiary uppercase tracking-wider">Test data</div>
              {/* Right: View, Notes, and X buttons when data is attached */}
              {(hasAttachedData || (selectedItem.source === 'data' && selectedItem.dataUsageMode === 'validation-subject')) && (
                <div className="flex items-center gap-1">
                  {/* View test data images button */}
                  {(() => {
                    const testDataBatchId = selectedItem.source === 'data' && selectedItem.dataUsageMode === 'validation-subject'
                      ? selectedItem.dicomFileBatchId
                      : selectedItem.attachedDataBatchId;
                    return testDataBatchId && dicomFileCache.has(testDataBatchId) ? (
                      <button
                        onClick={() => {
                          setImageManagerInitialTab('test');
                          setShowImageManager(true);
                        }}
                        className="inline-flex items-center px-2 py-1 border text-xs rounded border-border-secondary text-content-secondary hover:bg-surface-secondary"
                        title="View test data images"
                      >
                        <ImageIcon className="h-3 w-3 mr-1" />
                        Images
                      </button>
                    ) : null;
                  })()}
                  <button
                    onClick={() => setShowTestDataNotes(true)}
                    className={`inline-flex items-center px-2 py-1 border text-xs rounded ${
                      selectedItem.testDataNotes
                        ? 'text-amber-700 border-amber-500/30 bg-amber-50 hover:bg-amber-100 dark:text-amber-400 dark:bg-amber-900/20 dark:hover:bg-amber-900/30'
                        : 'border-border-secondary text-content-secondary hover:bg-surface-secondary'
                    }`}
                    title={selectedItem.testDataNotes ? 'View/edit notes' : 'Add notes'}
                  >
                    <FileText className="h-3 w-3 mr-1" />
                    Notes
                  </button>
                  <button
                    onClick={selectedItem.source === 'data' && selectedItem.dataUsageMode === 'validation-subject'
                      ? onDetachValidationData
                      : onDetachData}
                    className="inline-flex items-center p-1 text-content-tertiary hover:text-red-600 rounded hover:bg-red-50 dark:hover:bg-red-900/20"
                    title="Detach data"
                  >
                    <X className="h-3.5 w-3.5" />
                  </button>
                </div>
              )}
            </div>
            {selectedItem.source === 'data' && selectedItem.dataUsageMode === 'validation-subject' ? (
              // This item IS the data (validation-subject) - show its info
              renderAcquisitionInfo(false)
            ) : isUsedAsSchema ? (
              // This item is schema - show data attachment zone
              renderAttachmentZone('data')
            ) : isEmptyItem ? (
              // Empty item - always show data attachment zone (whether data attached or not)
              renderAttachmentZone('data')
            ) : (
              // Fallback - show acquisition info
              renderAcquisitionInfo(false)
            )}
          </div>
        </div>
      </div>

      {/* Content - AcquisitionTable - scrollable area */}
      <div className="px-6 py-4 space-y-4 flex-1 overflow-auto min-h-0">
        <AcquisitionTable
            acquisition={
              // For items with attached schema (empty or data-sourced), show the loaded schema acquisition
              // For schema items (schema-sourced or data-as-schema), show the item's own acquisition
              // For empty items with only attached data (no schema), show the attached data
              hasAttachedSchema && loadedSchemaAcquisition
                ? loadedSchemaAcquisition
                : (isEmptyItem && !hasCreatedSchema && !hasAttachedSchema && hasAttachedData && selectedItem.attachedData)
                  ? selectedItem.attachedData
                  : selectedItem.acquisition
            }
            isEditMode={selectedItem.isEditing}
            mode={
              // Compliance mode requires BOTH schema and data to compare
              // - Validation-subject with attachedSchema: compliance mode
              // - Schema items with attachedData: compliance mode
              // - Empty items with attachedSchema: compliance mode (if also has data)
              (selectedItem.source === 'data' && selectedItem.dataUsageMode === 'validation-subject' && hasAttachedSchema) ||
              (isUsedAsSchema && hasAttachedData) ||
              (!isUsedAsSchema && hasAttachedSchema)
                ? 'compliance'
                : 'edit'
            }
            realAcquisition={
              // For validation-subject items, the acquisition itself is the real data
              // For other schema items, attached data is the "real" data to validate
              selectedItem.source === 'data' && selectedItem.dataUsageMode === 'validation-subject'
                ? selectedItem.acquisition      // Validation-subject: acquisition is real data
                : isUsedAsSchema
                  ? selectedItem.attachedData   // Schema mode: attached data is real data
                  : selectedItem.acquisition    // Fallback: acquisition is real data
            }
            schemaId={
              // Priority: attachedSchema > schemaOrigin
              // Empty items with attachedSchema use attachedSchema
              // Schema-sourced items use schemaOrigin
              // Data-as-schema items don't have a schemaId
              selectedItem.attachedSchema?.schemaId ||
              selectedItem.schemaOrigin?.schemaId
            }
            schemaAcquisitionId={
              // Priority: attachedSchema > schemaOrigin
              selectedItem.attachedSchema?.acquisitionId ||
              selectedItem.schemaOrigin?.acquisitionIndex?.toString()
            }
            schemaAcquisition={
              // For data-as-schema items without a schemaId or attachedSchema, pass the acquisition directly
              isUsedAsSchema && !selectedItem.schemaOrigin?.schemaId && !selectedItem.attachedSchema?.schemaId
                ? selectedItem.acquisition
                : undefined
            }
            getSchemaContent={getSchemaContent}
            hideHeader={true}
            onUpdate={(key, value) => onUpdateAcquisition({ [key]: value })}
            onDelete={onRemove}
            onFieldUpdate={(fieldTag, updates) => workspace.updateField(selectedItem.id, fieldTag, updates)}
            onFieldConvert={(fieldTag, toLevel, mode) => workspace.convertFieldLevel(selectedItem.id, fieldTag, toLevel, mode)}
            onFieldDelete={(fieldTag) => workspace.deleteField(selectedItem.id, fieldTag)}
            onFieldAdd={(fieldTags) => workspace.addFields(selectedItem.id, fieldTags)}
            onSeriesUpdate={(seriesIndex, fieldTag, updates) => workspace.updateSeries(selectedItem.id, seriesIndex, fieldTag, updates)}
            onSeriesAdd={() => workspace.addSeries(selectedItem.id)}
            onSeriesDelete={(seriesIndex) => workspace.deleteSeries(selectedItem.id, seriesIndex)}
            onSeriesNameUpdate={(seriesIndex, name) => workspace.updateSeriesName(selectedItem.id, seriesIndex, name)}
            onValidationFunctionAdd={(func) => workspace.addValidationFunction(selectedItem.id, func)}
            onValidationFunctionUpdate={(index, func) => workspace.updateValidationFunction(selectedItem.id, index, func)}
            onValidationFunctionDelete={(index) => workspace.deleteValidationFunction(selectedItem.id, index)}
            onComplianceResultsChange={(results) => {
              // Update ref synchronously for print view
              complianceResultsRef.current = results;
            }}
            onSeriesView={(() => {
              const mapping = selectedItem.acquisition?.seriesFileMapping;
              const batchId = selectedItem.dicomFileBatchId;
              if (!mapping || !batchId || !dicomFileCache.has(batchId)) return undefined;

              return (_seriesIndex: number, seriesName: string) => {
                const filenames = mapping[seriesName];
                if (!filenames) return;
                const allFiles = dicomFileCache.get(batchId) || [];
                const filenameSet = new Set(filenames);
                const seriesFiles = allFiles.filter(f => {
                  const key = (f as any).webkitRelativePath || f.name;
                  return filenameSet.has(key);
                });
                if (seriesFiles.length > 0) {
                  setImageManagerInitialTab('reference');
                  setImageManagerInitialMatchFiles(seriesFiles);
                  setShowImageManager(true);
                }
              };
            })()}
            onSeriesViewTestData={(() => {
              const attached = selectedItem.attachedData;
              const mapping = attached?.seriesFileMapping;
              const batchId = selectedItem.attachedDataBatchId;
              if (!mapping || !batchId || !dicomFileCache.has(batchId)) return undefined;

              return (_seriesIndex: number, seriesName: string) => {
                const filenames = mapping[seriesName];
                if (!filenames) return;
                const allFiles = dicomFileCache.get(batchId) || [];
                const filenameSet = new Set(filenames);
                const seriesFiles = allFiles.filter(f => {
                  const key = (f as any).webkitRelativePath || f.name;
                  return filenameSet.has(key);
                });
                if (seriesFiles.length > 0) {
                  setImageManagerInitialTab('test');
                  setImageManagerInitialMatchFiles(seriesFiles);
                  setShowImageManager(true);
                }
              };
            })()}
          />
      </div>


      {/* Detailed Description Modal - always editable */}
      <DetailedDescriptionModal
        isOpen={showDetailedDescription}
        onClose={() => setShowDetailedDescription(false)}
        title={selectedItem.acquisition.protocolName || 'Acquisition'}
        description={
          // Use loaded schema acquisition's README as starting point when available (for Library-attached schemas)
          // but allow editing to create custom README
          selectedItem.acquisition.detailedDescription ||
          (hasAttachedSchema && loadedSchemaAcquisition?.detailedDescription) ||
          ''
        }
        onSave={(description) => onUpdateAcquisition({ detailedDescription: description })}
        acquisitionNames={workspace.items
          .map(it => it.acquisition?.protocolName)
          .filter((n): n is string => !!n)}
        onNavigateToAcquisition={(name) => {
          const target = workspace.items.find(it => it.acquisition?.protocolName === name);
          if (target) {
            setShowDetailedDescription(false);
            workspace.selectItem(target.id);
          }
        }}
      />

      {/* Image Manager Modal */}
      <ImageManagerModal
        isOpen={showImageManager}
        onClose={() => {
          setShowImageManager(false);
          setImageManagerInitialTab(undefined);
          setImageManagerInitialMatchFiles(undefined);
        }}
        title={selectedItem.acquisition.protocolName || 'Acquisition'}
        images={selectedItem.acquisition.images || []}
        onSave={(images) => onUpdateAcquisition({ images })}
        dicomFiles={
          selectedItem.source === 'data' && selectedItem.dicomFileBatchId
            ? dicomFileCache.get(selectedItem.dicomFileBatchId)
            : undefined
        }
        testDicomFiles={
          selectedItem.attachedDataBatchId
            ? dicomFileCache.get(selectedItem.attachedDataBatchId)
            : undefined
        }
        initialTab={imageManagerInitialTab}
        initialMatchFiles={imageManagerInitialMatchFiles}
      />

      {/* Test Data Notes Modal - for adding notes about test data (print report only) */}
      <DetailedDescriptionModal
        isOpen={showTestDataNotes}
        onClose={() => setShowTestDataNotes(false)}
        title={`Notes: ${selectedItem.attachedData?.protocolName || selectedItem.acquisition.protocolName || 'Test Data'}`}
        description={selectedItem.testDataNotes || ''}
        onSave={(notes) => workspace.updateTestDataNotes(selectedItem.id, notes)}
      />

      {/* Schema README Modal - for viewing mode with schema context (shows sidebar with all acquisitions) */}
      <SchemaReadmeModal
        isOpen={showReadmeModal}
        onClose={() => setShowReadmeModal(false)}
        schemaName={readmeModalData?.schemaName || ''}
        readmeItems={readmeModalData?.readmeItems || []}
        initialSelection={readmeModalData?.initialSelection || 'schema'}
      />

      {/* Print Options Modal */}
      <PrintOptionsModal
        isOpen={showPrintOptions}
        onClose={() => setShowPrintOptions(false)}
        onPrint={handlePrintAcquisition}
        isPrinting={pdfExporting}
        printLabel={isElectron() ? 'Export PDF' : 'Print'}
        availableSections={(() => {
          const sections: Array<'header' | 'readme' | 'schemaImages' | 'referenceDicoms' | 'testDicoms' | 'testNotes' | 'validationRules' | 'fieldsTable' | 'seriesTable' | 'uncheckedFields' | 'uncheckedSeriesFields'> = ['header', 'readme', 'fieldsTable', 'seriesTable', 'validationRules'];
          if (selectedItem.acquisition.images && selectedItem.acquisition.images.length > 0) sections.push('schemaImages');
          if (selectedItem.dicomFileBatchId && dicomFileCache.has(selectedItem.dicomFileBatchId)) sections.push('referenceDicoms');
          if (selectedItem.attachedDataBatchId && dicomFileCache.has(selectedItem.attachedDataBatchId)) sections.push('testDicoms');
          if (selectedItem.testDataNotes) sections.push('testNotes');
          if (hasAttachedSchema || hasCreatedSchema) {
            sections.push('uncheckedFields', 'uncheckedSeriesFields');
          }
          return sections;
        })()}
        hasImages
        schemaImages={selectedItem.acquisition.images?.map(img => ({ label: img.label || '', url: img.url }))}
      />

    </div>
  );
};

export default WorkspaceDetailPanel;
