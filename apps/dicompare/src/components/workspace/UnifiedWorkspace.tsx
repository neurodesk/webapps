import React, { useState, useCallback, useEffect, useRef, useMemo } from 'react';
import { AlertTriangle, FileText, Image, GripVertical, List, Check, X } from 'lucide-react';
import {
  DndContext,
  DragOverlay,
  closestCenter,
  pointerWithin,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
  DragStartEvent,
  DragEndEvent,
  DragOverEvent,
} from '@dnd-kit/core';
import {
  arrayMove,
  sortableKeyboardCoordinates,
} from '@dnd-kit/sortable';
import { useWorkspace, WorkspaceItem, SchemaMetadata } from '../../contexts/WorkspaceContext';
import { useSchemaService, SchemaBinding } from '../../hooks/useSchemaService';
import { AcquisitionSelection } from '../../types';
import WorkspaceSidebar, { SCHEMA_INFO_ID, ADD_FROM_DATA_ID, ADD_NEW_ID, ASSIGN_DATA_ID } from './WorkspaceSidebar';
import WorkspaceDetailPanel, { SchemaInfoTab } from './WorkspaceDetailPanel';
import { getItemFlags } from '../../utils/workspaceHelpers';
import AttachSchemaModal from './AttachSchemaModal';
import SchemaReadmeModal from '../schema/SchemaReadmeModal';
import { useReadmeModal } from '../../hooks/useReadmeModal';
import { useFileSystemAccess } from '../../hooks/useFileSystemAccess';
import { useSchemaImportFromViewer } from '../../hooks/useSchemaImportFromViewer';
import { useSessionPersistence } from '../../contexts/SessionPersistenceContext';

const UnifiedWorkspace: React.FC = () => {
  const {
    items,
    selectedId,
    isProcessing,
    processingProgress,
    processingError,
    schemaMetadata,
    setSchemaMetadata,
    addFromSchema,
    addFromData,
    addFromDataWithHandles,
    addEmpty,
    createSchemaForItem,
    detachCreatedSchema,
    selectItem,
    removeItem,
    reorderItems,
    toggleEditing,
    attachData,
    attachSchema,
    uploadSchemaForItem,
    detachData,
    detachSchema,
    detachValidationData,
    confirmMatching,
    generateTestData,
    updateAcquisition,
    clearAll,
  } = useWorkspace();

  const {
    getSchemaContent,
    getUnifiedSchema,
    librarySchemas,
    uploadedSchemas,
    isLoading: schemasLoading
  } = useSchemaService();

  // README modal hook
  const {
    showReadmeModal,
    readmeModalData,
    handleSchemaReadmeClick,
    handleAcquisitionReadmeClick,
    closeReadmeModal
  } = useReadmeModal(getSchemaContent);

  // File System Access API hook for large file support
  const {
    isDirectoryPickerSupported,
    pickAndScanDirectory,
  } = useFileSystemAccess();

  // Import schema from Schema Viewer page (if navigated via "Open in Workspace")
  useSchemaImportFromViewer();

  // Session persistence
  const { endSession } = useSessionPersistence();

  const handleReset = useCallback(async () => {
    await clearAll();
    endSession();
  }, [clearAll, endSession]);

  // Local UI state
  const [schemaInfoTab, setSchemaInfoTab] = useState<SchemaInfoTab>('welcome');
  const [showAttachSchemaModal, setShowAttachSchemaModal] = useState(false);
  const [isAttachModalFromStaged, setIsAttachModalFromStaged] = useState(false); // Track if modal opened from staged view
  const [pendingSchemaSelections, setPendingSchemaSelections] = useState<AcquisitionSelection[]>([]);
  const [activeDragId, setActiveDragId] = useState<string | null>(null);
  const [activeDragData, setActiveDragData] = useState<any>(null);
  const [activeDragWidth, setActiveDragWidth] = useState<number | null>(null);
  const [isOverDropZone, setIsOverDropZone] = useState(false);

  // Track previous selection to exit edit mode when navigating away
  const previousSelectedId = useRef<string | null>(null);
  useEffect(() => {
    if (previousSelectedId.current && previousSelectedId.current !== selectedId) {
      // Find the previous item and exit edit mode if it was editing
      const previousItem = items.find(item => item.id === previousSelectedId.current);
      if (previousItem?.isEditing) {
        toggleEditing(previousSelectedId.current);
      }
    }
    previousSelectedId.current = selectedId;
  }, [selectedId, items, toggleEditing]);

  // DnD Kit sensors
  const sensors = useSensors(
    useSensor(PointerSensor, {
      activationConstraint: {
        distance: 8,
      },
    }),
    useSensor(KeyboardSensor, {
      coordinateGetter: sortableKeyboardCoordinates,
    })
  );

  // Schema selection handlers
  const handleSchemaFirstToggle = (selection: AcquisitionSelection) => {
    setPendingSchemaSelections(prev => {
      const exists = prev.some(
        s => s.schemaId === selection.schemaId && s.acquisitionIndex === selection.acquisitionIndex
      );
      if (exists) {
        return prev.filter(
          s => !(s.schemaId === selection.schemaId && s.acquisitionIndex === selection.acquisitionIndex)
        );
      } else {
        return [...prev, selection];
      }
    });
  };

  const confirmSchemaSelections = async () => {
    if (pendingSchemaSelections.length > 0) {
      await addFromSchema(pendingSchemaSelections, getSchemaContent, getUnifiedSchema);
      setPendingSchemaSelections([]);
    }
  };

  // Data upload handler
  const handleFileUpload = useCallback(async (files: FileList | null, mode: 'schema-template' | 'validation-subject' = 'schema-template') => {
    if (!files) return;
    await addFromData(files, mode);
  }, [addFromData]);

  // Large folder upload handler (File System Access API for >2GB datasets)
  const handleLargeFolderBrowse = useCallback(async (mode: 'schema-template' | 'validation-subject' = 'schema-template') => {
    const manager = await pickAndScanDirectory();
    if (manager && manager.fileCount > 0) {
      await addFromDataWithHandles(manager, mode);
    }
  }, [pickAndScanDirectory, addFromDataWithHandles]);

  // Create schema for current empty item
  const handleCreateSchema = useCallback(() => {
    if (selectedId && selectedId !== ADD_NEW_ID) {
      createSchemaForItem(selectedId);
    }
  }, [selectedId, createSchemaForItem]);

  // Staged handlers - create item first, then perform action
  const handleStagedCreateBlank = useCallback(() => {
    const newId = addEmpty();
    createSchemaForItem(newId);
  }, [addEmpty, createSchemaForItem]);

  const handleStagedAttachSchema = useCallback(() => {
    setIsAttachModalFromStaged(true); // Mark that we're opening from staged view
    setShowAttachSchemaModal(true);
  }, []);

  // Detach created schema from current item
  const handleDetachCreatedSchema = useCallback(() => {
    if (selectedId && selectedId !== ADD_NEW_ID) {
      detachCreatedSchema(selectedId);
    }
  }, [selectedId, detachCreatedSchema]);

  // Attach schema handler
  const handleAttachSchema = useCallback((binding: SchemaBinding) => {
    if (isAttachModalFromStaged) {
      // Create item first, then attach schema
      const newId = addEmpty();
      attachSchema(newId, binding);
    } else if (selectedId && selectedId !== ADD_NEW_ID) {
      attachSchema(selectedId, binding);
    }
    setShowAttachSchemaModal(false);
    setIsAttachModalFromStaged(false);
  }, [selectedId, attachSchema, isAttachModalFromStaged, addEmpty]);

  // Detach schema handler
  const handleDetachSchema = useCallback(() => {
    if (selectedId && selectedId !== ADD_NEW_ID) {
      detachSchema(selectedId);
    }
  }, [selectedId, detachSchema]);

  // Attach data handler
  const handleAttachData = useCallback(async (files: FileList) => {
    if (selectedId && selectedId !== ADD_NEW_ID) {
      await attachData(selectedId, files);
    }
  }, [selectedId, attachData]);

  // Upload schema for current item handler
  const handleUploadSchemaForItem = useCallback(async (files: FileList) => {
    if (selectedId && selectedId !== ADD_NEW_ID) {
      await uploadSchemaForItem(selectedId, files);
    }
  }, [selectedId, uploadSchemaForItem]);

  // Detach data handler
  const handleDetachData = useCallback(() => {
    if (selectedId && selectedId !== ADD_NEW_ID) {
      detachData(selectedId);
    }
  }, [selectedId, detachData]);

  // Detach validation data handler (for validation-subject items)
  const handleDetachValidationData = useCallback(() => {
    if (selectedId && selectedId !== ADD_NEW_ID) {
      detachValidationData(selectedId);
    }
  }, [selectedId, detachValidationData]);

  // Generate test data handler
  const handleGenerateTestData = useCallback(async () => {
    if (selectedId && selectedId !== ADD_NEW_ID) {
      await generateTestData(selectedId, getSchemaContent);
    }
  }, [selectedId, generateTestData, getSchemaContent]);

  // DnD handlers
  const handleDndDragStart = (event: DragStartEvent) => {
    setActiveDragId(event.active.id as string);
    setActiveDragData(event.active.data.current);
    // Capture the width of the dragged element for the overlay
    const width = event.active.rect.current.initial?.width;
    setActiveDragWidth(width ?? null);
  };

  const handleDndDragOver = (event: DragOverEvent) => {
    const { active, over } = event;
    const activeId = active.id as string;
    const isFromSchemaBrowser = activeId.startsWith('schema-drag-') || activeId.startsWith('acq-drag-');

    if (!isFromSchemaBrowser || !over) {
      setIsOverDropZone(false);
      return;
    }

    const overId = over.id as string;
    const isValidTarget = overId === 'sidebar-drop-zone' || items.some(item => item.id === overId);
    setIsOverDropZone(isValidTarget);
  };

  const handleDndDragEnd = async (event: DragEndEvent) => {
    const { active, over } = event;
    setActiveDragId(null);
    setActiveDragData(null);
    setActiveDragWidth(null);
    setIsOverDropZone(false);

    if (!over) return;

    const activeId = active.id as string;
    const overId = over.id as string;
    const dragData = active.data.current;

    const isFromSchemaBrowser = activeId.startsWith('schema-drag-') || activeId.startsWith('acq-drag-');
    const isValidTarget = overId === 'sidebar-drop-zone' || items.some(item => item.id === overId);

    // Handle drop from schema browser
    if (isFromSchemaBrowser && isValidTarget) {
      if (dragData?.type === 'acquisition') {
        const selection: AcquisitionSelection = dragData.selection;
        await addFromSchema([selection], getSchemaContent, getUnifiedSchema);
      } else if (dragData?.type === 'schema') {
        // Add all acquisitions from schema
        const content = await getSchemaContent(dragData.schemaId);
        if (content) {
          const schemaData = JSON.parse(content);
          const selections: AcquisitionSelection[] = Object.keys(schemaData.acquisitions || {}).map((name, index) => ({
            schemaId: dragData.schemaId,
            acquisitionIndex: index,
            schemaName: dragData.schemaName,
            acquisitionName: name
          }));
          await addFromSchema(selections, getSchemaContent, getUnifiedSchema);
        }
      }
      return;
    }

    // Reordering within list
    if (activeId !== overId) {
      const activeIndex = items.findIndex(item => item.id === activeId);
      const overIndex = items.findIndex(item => item.id === overId);

      if (activeIndex !== -1 && overIndex !== -1) {
        reorderItems(activeIndex, overIndex);
      }
    }
  };

  // Get selected item
  const selectedItem = items.find(item => item.id === selectedId);

  // Build matching data when ASSIGN_DATA_ID is selected
  const matchingData = useMemo(() => {
    if (selectedId !== ASSIGN_DATA_ID) return undefined;

    // Collect all data acquisitions
    const dataItems: { acquisition: any; itemId: string }[] = [];
    // Collect all reference items (items with schema)
    const refItems: { itemId: string; item: any }[] = [];
    // Track current assignments
    const currentAssignments: Array<{ uploadedIndex: number; itemId: string }> = [];

    items.forEach(item => {
      // Use getItemFlags for consistent logic
      const flags = getItemFlags(item);

      // Item has a reference - it's an available slot
      if (flags.hasSchema) {
        refItems.push({ itemId: item.id, item });
      }

      // Item has data - collect it
      if (flags.hasData) {
        const dataAcq = item.attachedData || item.acquisition;
        const dataIndex = dataItems.length;
        dataItems.push({ acquisition: dataAcq, itemId: item.id });

        // If this data is already attached to a reference item, record the assignment
        if (item.attachedData && flags.hasSchema) {
          // Data is attached to this reference item
          currentAssignments.push({ uploadedIndex: dataIndex, itemId: item.id });
        } else if (item.source === 'data' && item.dataUsageMode === 'validation-subject' && flags.hasAttachedSchema) {
          // Validation-subject item with attached schema - assigned to itself
          currentAssignments.push({ uploadedIndex: dataIndex, itemId: item.id });
        }
      }
    });

    return {
      uploadedAcquisitions: dataItems.map(d => d.acquisition),
      availableSlots: refItems,
      initialAssignments: currentAssignments,
      dataItemIds: dataItems.map(d => d.itemId) // Track which item each data came from
    };
  }, [selectedId, items]);

  // Handle matching confirmation
  const handleConfirmMatching = useCallback((matches: Array<{ uploadedIndex: number; itemId: string | null }>) => {
    if (!matchingData) return;

    // Build the operation data to pass to confirmMatching
    const operation = {
      uploadedAcquisitions: matchingData.uploadedAcquisitions,
      availableSlots: matchingData.availableSlots,
      sourceItemIds: matchingData.dataItemIds,
      initialAssignments: matchingData.initialAssignments
    };

    // Call confirmMatching with the matches and operation data
    confirmMatching(matches, operation);

    // Stay on the matching panel - user can navigate away manually
  }, [matchingData, confirmMatching]);

  return (
    <div className="max-w-7xl mx-auto">
      {/* Processing error */}
      {processingError && (
        <div className="mb-4 p-3 bg-status-error-bg border border-status-error/30 text-status-error rounded flex items-start">
          <AlertTriangle className="h-5 w-5 mr-2 flex-shrink-0 mt-0.5" />
          <div>
            <p className="font-medium">Error</p>
            <p className="text-sm mt-1">{processingError}</p>
          </div>
        </div>
      )}

      {/* Main Content */}
      <DndContext
        sensors={sensors}
        collisionDetection={pointerWithin}
        onDragStart={handleDndDragStart}
        onDragOver={handleDndDragOver}
        onDragEnd={handleDndDragEnd}
      >
        <div className="grid grid-cols-12 gap-6">
          {/* Left Sidebar */}
          <div className="col-span-12 md:col-span-3">
            <WorkspaceSidebar
              items={items}
              selectedId={selectedId}
              isOverDropZone={isOverDropZone}
              schemaMetadata={schemaMetadata}
              schemaInfoTab={schemaInfoTab}
              onSelect={selectItem}
              onSelectSchemaInfo={(tab) => {
                selectItem(SCHEMA_INFO_ID);
                setSchemaInfoTab(tab);
              }}
              onRemove={removeItem}
              onReset={handleReset}
            />
          </div>

          {/* Right Detail Panel */}
          <div className="col-span-12 md:col-span-9 h-[calc(100vh-130px)]">
            <WorkspaceDetailPanel
              selectedItem={selectedItem}
              isAddNew={selectedId === ADD_NEW_ID}
              isAddFromData={selectedId === ADD_FROM_DATA_ID}
              isSchemaInfo={selectedId === SCHEMA_INFO_ID || (!selectedId && !selectedItem)}
              isAssignData={selectedId === ASSIGN_DATA_ID}
              schemaInfoTab={schemaInfoTab}
              setSchemaInfoTab={setSchemaInfoTab}
              isProcessing={isProcessing}
              processingProgress={processingProgress}
              pendingSchemaSelections={pendingSchemaSelections}
              librarySchemas={librarySchemas}
              uploadedSchemas={uploadedSchemas}
              schemaMetadata={schemaMetadata}
              getSchemaContent={getSchemaContent}
              getUnifiedSchema={getUnifiedSchema}
              onSchemaToggle={handleSchemaFirstToggle}
              onConfirmSchemas={confirmSchemaSelections}
              onFileUpload={handleFileUpload}
              onLargeFolderBrowse={handleLargeFolderBrowse}
              isLargeFolderSupported={isDirectoryPickerSupported}
              onCreateSchema={handleCreateSchema}
              onDetachCreatedSchema={handleDetachCreatedSchema}
              onToggleEditing={() => selectedId && toggleEditing(selectedId)}
              onAttachData={handleAttachData}
              onUploadSchemaForItem={handleUploadSchemaForItem}
              onDetachData={handleDetachData}
              onDetachValidationData={handleDetachValidationData}
              onAttachSchema={() => setShowAttachSchemaModal(true)}
              onDetachSchema={handleDetachSchema}
              onGenerateTestData={handleGenerateTestData}
              onRemove={() => selectedId && removeItem(selectedId)}
              onUpdateAcquisition={(updates) => selectedId && updateAcquisition(selectedId, updates)}
              onUpdateSchemaMetadata={(updates) => setSchemaMetadata({
                ...schemaMetadata,
                name: updates.name ?? schemaMetadata?.name ?? '',
                description: updates.description ?? schemaMetadata?.description ?? '',
                authors: updates.authors ?? schemaMetadata?.authors ?? [],
                version: updates.version ?? schemaMetadata?.version ?? '1.0',
              })}
              onSchemaReadmeClick={handleSchemaReadmeClick}
              onAcquisitionReadmeClick={handleAcquisitionReadmeClick}
              onStagedCreateBlank={handleStagedCreateBlank}
              onStagedAttachSchema={handleStagedAttachSchema}
              matchingData={matchingData}
              onConfirmMatching={handleConfirmMatching}
            />
          </div>
        </div>

        {/* Drag Overlay */}
        <DragOverlay dropAnimation={null}>
          {activeDragId ? (() => {
            // For workspace items being reordered
            const draggedItem = items.find(i => i.id === activeDragId);
            if (draggedItem) {
              const { hasData, hasSchema } = getItemFlags(draggedItem);
              return (
                <div className="border rounded-lg p-3 bg-surface-primary shadow-lg border-brand-500 w-64">
                  <div className="flex items-start">
                    <GripVertical className="h-4 w-4 text-content-muted mt-0.5 flex-shrink-0 mr-2" />
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center space-x-2">
                        <FileText className="h-4 w-4 text-content-tertiary flex-shrink-0" />
                        <h3 className="text-sm font-medium text-content-primary truncate">
                          {draggedItem.acquisition.protocolName || 'Untitled'}
                        </h3>
                      </div>
                      <div className="flex items-center mt-2 text-xs space-x-3">
                        <span className={`flex items-center ${hasSchema ? 'text-brand-600 dark:text-brand-400' : 'text-content-muted'}`}>
                          <FileText className="h-3 w-3 mr-1" />
                          {hasSchema ? 'Schema' : 'No schema'}
                        </span>
                        <span className={`flex items-center ${hasData ? 'text-brand-600 dark:text-brand-400' : 'text-content-muted'}`}>
                          <Image className="h-3 w-3 mr-1" />
                          {hasData ? 'Data' : 'No data'}
                        </span>
                      </div>
                    </div>
                  </div>
                </div>
              );
            }
            // For schema drags from schema browser
            if (activeDragId.startsWith('schema-drag-')) {
              return (
                <div className="border rounded-lg p-3 bg-surface-primary shadow-lg border-brand-500">
                  <div className="flex items-center space-x-2">
                    <FileText className="h-4 w-4 text-brand-600" />
                    <span className="text-sm font-medium text-content-primary">
                      {activeDragData?.schemaName || 'Schema'} (all acquisitions)
                    </span>
                  </div>
                </div>
              );
            }
            // For acquisition drag from schema browser - render full preview using stored drag data
            if (activeDragData?.type === 'acquisition' && activeDragData.acquisition) {
              const acq = activeDragData.acquisition;
              const tags = activeDragData.tags || [];
              const fieldCount = (acq.acquisitionFields?.length || 0) + (acq.series?.reduce((acc: number, s: any) => acc + (s.fields?.length || 0), 0) || 0);
              const ruleCount = acq.validationFunctions?.length || 0;
              return (
                <div
                  className="border rounded-lg p-3 bg-surface-primary shadow-lg border-brand-500"
                  style={activeDragWidth ? { width: activeDragWidth } : undefined}
                >
                  <div className="flex items-start space-x-3">
                    <GripVertical className="h-4 w-4 text-content-muted mt-0.5 flex-shrink-0" />
                    <div className="w-5 h-5 rounded border-2 flex items-center justify-center flex-shrink-0 mt-0.5 bg-brand-600 border-brand-600">
                      <Check className="h-3 w-3 text-white" />
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="font-medium text-sm text-content-primary">
                        {acq.protocolName || 'Acquisition'}
                      </div>
                      {acq.seriesDescription && (
                        <div className="text-xs text-content-secondary mt-1 line-clamp-2">
                          {acq.seriesDescription}
                        </div>
                      )}
                      {tags.length > 0 && (
                        <div className="flex flex-wrap gap-1 mt-2">
                          {tags.slice(0, 4).map((tag: string) => (
                            <span key={tag} className="px-1.5 py-0.5 text-xs rounded bg-surface-tertiary text-content-tertiary">
                              {tag}
                            </span>
                          ))}
                          {tags.length > 4 && (
                            <span className="px-1.5 py-0.5 text-xs rounded bg-surface-tertiary text-content-tertiary">
                              +{tags.length - 4}
                            </span>
                          )}
                        </div>
                      )}
                      <div className="flex items-center space-x-4 mt-2 text-xs text-content-tertiary">
                        {fieldCount > 0 && (
                          <span className="flex items-center">
                            <List className="h-3 w-3 mr-1" />
                            {fieldCount} fields
                          </span>
                        )}
                        {ruleCount > 0 && (
                          <span>{ruleCount} validation rules</span>
                        )}
                      </div>
                    </div>
                  </div>
                </div>
              );
            }
            // Fallback for acquisition drag without full data
            return (
              <div className="border rounded-lg p-3 bg-surface-primary shadow-lg border-brand-500">
                <div className="flex items-center space-x-2">
                  <FileText className="h-4 w-4 text-brand-600" />
                  <span className="text-sm font-medium text-content-primary">Acquisition</span>
                </div>
              </div>
            );
          })() : null}
        </DragOverlay>
      </DndContext>

      {/* Attach Schema Modal */}
      <AttachSchemaModal
        isOpen={showAttachSchemaModal}
        onClose={() => {
          setShowAttachSchemaModal(false);
          setIsAttachModalFromStaged(false);
        }}
        onSelect={handleAttachSchema}
        librarySchemas={librarySchemas}
        uploadedSchemas={uploadedSchemas}
        getSchemaContent={getSchemaContent}
        testDataAcquisition={
          // Data from validation-subject mode
          (selectedItem?.source === 'data' && selectedItem?.dataUsageMode === 'validation-subject')
            ? selectedItem.acquisition
            // Data attached to an empty item (e.g., after detaching schema)
            : (selectedItem?.source === 'empty' && selectedItem?.attachedData)
              ? selectedItem.attachedData
              : undefined
        }
        onSchemaReadmeClick={handleSchemaReadmeClick}
        onAcquisitionReadmeClick={handleAcquisitionReadmeClick}
      />

      {/* README Modal */}
      <SchemaReadmeModal
        isOpen={showReadmeModal}
        onClose={closeReadmeModal}
        schemaName={readmeModalData?.schemaName || ''}
        readmeItems={readmeModalData?.readmeItems || []}
        initialSelection={readmeModalData?.initialSelection || 'schema'}
      />

    </div>
  );
};

export default UnifiedWorkspace;
