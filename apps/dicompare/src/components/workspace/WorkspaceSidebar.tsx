import React, { useState } from 'react';
import { Plus, FileText, FlaskConical, X, GripVertical, UploadCloud, Trash2, Home, Link2 } from 'lucide-react';
import { useDroppable } from '@dnd-kit/core';
import { useSortable } from '@dnd-kit/sortable';
import { SortableContext, verticalListSortingStrategy } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { WorkspaceItem, SchemaMetadata } from '../../contexts/WorkspaceContext';
import { useItemManagement } from '../../contexts/ItemManagementContext';
import { getItemFlags } from '../../utils/workspaceHelpers';

interface WorkspaceSidebarProps {
  items: WorkspaceItem[];
  selectedId: string | null;
  isOverDropZone: boolean;
  schemaMetadata: SchemaMetadata;
  schemaInfoTab: 'welcome' | 'metadata' | 'preview';
  onSelect: (id: string | null) => void;
  onSelectSchemaInfo: (tab: 'welcome' | 'metadata') => void;
  onRemove: (id: string) => void;
  onReset: () => void;
}

export const ADD_NEW_ID = '__add_new__';
export const ADD_FROM_DATA_ID = '__add_from_data__';
export const SCHEMA_INFO_ID = '__schema_info__';
export const ASSIGN_DATA_ID = '__assign_data__';

// Sortable workspace item
const SortableWorkspaceItem: React.FC<{
  item: WorkspaceItem;
  isSelected: boolean;
  onSelect: () => void;
  onRemove: () => void;
}> = ({ item, isSelected, onSelect, onRemove }) => {
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: item.id });

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.5 : 1,
  };

  const { hasSchema, hasData } = getItemFlags(item);
  const isMatched = hasSchema && hasData;
  const { flashItemIds } = useItemManagement();
  const isFlashing = flashItemIds.has(item.id);

  return (
    <div
      ref={setNodeRef}
      style={style}
      onClick={onSelect}
      data-tutorial={isMatched ? 'matched-item' : undefined}
      className={`border rounded-lg p-3 cursor-pointer transition-all ${isFlashing ? 'animate-flash-green' : ''} ${
        isSelected
          ? 'border-brand-500 bg-brand-50 dark:bg-brand-900/20 shadow-md'
          : 'border-border hover:border-brand-300 dark:hover:border-brand-700 hover:bg-surface-secondary'
      }`}
    >
      <div className="flex items-start">
        {/* Drag handle for reordering */}
        <div
          {...attributes}
          {...listeners}
          className="cursor-grab active:cursor-grabbing touch-none mr-2"
          onClick={(e) => e.stopPropagation()}
        >
          <GripVertical className="h-4 w-4 text-content-muted mt-0.5 flex-shrink-0" />
        </div>

        {/* Content */}
        <div className="flex-1 min-w-0">
          <div className="flex items-center space-x-2">
            <FileText className="h-4 w-4 text-content-tertiary flex-shrink-0" />
            <h3 className="text-sm font-medium text-content-primary truncate">
              {item.acquisition.protocolName || 'Untitled'}
            </h3>
          </div>

          {/* Status indicators */}
          <div className="flex items-center mt-2 text-xs space-x-3">
            {hasSchema ? (
              <span className="text-brand-600 dark:text-brand-400 flex items-center">
                <FileText className="h-3 w-3 mr-1" />
                Reference
              </span>
            ) : (
              <span className="text-content-muted flex items-center">
                <FileText className="h-3 w-3 mr-1" />
                No reference
              </span>
            )}
            {hasData ? (
              <span className="text-amber-600 dark:text-amber-400 flex items-center">
                <FlaskConical className="h-3 w-3 mr-1" />
                Data
              </span>
            ) : (
              <span className="text-content-muted flex items-center">
                <FlaskConical className="h-3 w-3 mr-1" />
                No data
              </span>
            )}
          </div>
        </div>

        {/* Remove button */}
        <button
          onClick={(e) => {
            e.stopPropagation();
            onRemove();
          }}
          className="p-1 text-content-tertiary hover:text-status-error rounded ml-1"
          title="Remove"
        >
          <X className="h-3.5 w-3.5" />
        </button>
      </div>
    </div>
  );
};

const WorkspaceSidebar: React.FC<WorkspaceSidebarProps> = ({
  items,
  selectedId,
  isOverDropZone,
  schemaMetadata,
  schemaInfoTab,
  onSelect,
  onSelectSchemaInfo,
  onRemove,
  onReset,
}) => {
  const { setNodeRef } = useDroppable({ id: 'sidebar-drop-zone' });
  const [showResetConfirm, setShowResetConfirm] = useState(false);

  // Check if assign button should be shown:
  // - More than one acquisition
  // - At least one item has data (attachedData or data-sourced)
  // - At least one item has a reference/schema
  const hasAnyData = items.some(item =>
    item.attachedData !== undefined || item.source === 'data'
  );
  const hasAnyRef = items.some(item => {
    const { hasSchema } = getItemFlags(item);
    return hasSchema;
  });
  const showAssignButton = items.length > 1 && hasAnyData && hasAnyRef;

  // Check if there's unassigned data or references (for amber highlighting)
  const hasUnassignedData = items.some(item => {
    const flags = getItemFlags(item);
    // Standalone data item (validation-subject without attached schema)
    if (item.source === 'data' && item.dataUsageMode === 'validation-subject' && !flags.hasAttachedSchema) {
      return true;
    }
    return false;
  });
  const hasUnassignedRef = items.some(item => {
    const flags = getItemFlags(item);
    // Reference item without attached data
    return flags.hasSchema && !flags.hasData;
  });
  const hasUnassignedItems = hasUnassignedData && hasUnassignedRef;

  const isFromDataSelected = selectedId === ADD_FROM_DATA_ID;
  const isSchemaLibrarySelected = selectedId === ADD_NEW_ID;
  const isSchemaInfoSelected = selectedId === SCHEMA_INFO_ID || (!selectedId && items.length === 0) || !selectedId;

  // Determine if schema has a name set
  const hasSchemaName = schemaMetadata.name && schemaMetadata.name.trim() !== '';
  const displayTitle = hasSchemaName ? schemaMetadata.name : 'Acquisitions';

  // Check if there's anything to reset
  const hasContent = items.length > 0 || hasSchemaName || schemaMetadata.authors?.length > 0 || schemaMetadata.description;

  const handleReset = () => {
    onReset();
    setShowResetConfirm(false);
  };

  return (
    <div
      ref={setNodeRef}
      className={`bg-surface-primary rounded-lg border shadow-sm transition-colors flex flex-col h-[calc(100vh-130px)] max-h-[calc(100vh-130px)] ${
        isOverDropZone ? 'border-brand-500 bg-brand-50/50 dark:bg-brand-900/10' : 'border-border'
      }`}
    >
      {/* Header - Shows schema name or "Acquisitions" as placeholder */}
      <div
        className={`px-4 py-3 border-b transition-colors cursor-pointer flex-shrink-0 ${
          isSchemaInfoSelected
            ? 'border-brand-500 bg-brand-50 dark:bg-brand-900/20'
            : 'border-border hover:bg-surface-secondary'
        }`}
        onClick={() => onSelectSchemaInfo('welcome')}
      >
        <div className="flex items-center justify-between">
          <div className="flex-1 min-w-0">
            <h3 className={`text-lg font-medium truncate ${
              hasSchemaName ? 'text-content-primary' : 'text-content-tertiary'
            }`}>
              {displayTitle}
            </h3>
          </div>
          <div className="flex items-center gap-1">
            <button
              onClick={(e) => {
                e.stopPropagation();
                onSelectSchemaInfo('welcome');
              }}
              className={`p-1.5 rounded transition-colors ${
                isSchemaInfoSelected && schemaInfoTab === 'welcome'
                  ? 'text-brand-600 bg-brand-100 dark:bg-brand-800/30'
                  : 'text-content-tertiary hover:text-content-secondary hover:bg-surface-tertiary'
              }`}
              title="Go to welcome screen"
            >
              <Home className="h-4 w-4" />
            </button>
            <button
              data-tutorial="save-button"
              onClick={(e) => {
                e.stopPropagation();
                onSelectSchemaInfo('metadata');
              }}
              className={`p-1.5 rounded transition-colors ${
                isSchemaInfoSelected && schemaInfoTab === 'metadata'
                  ? 'text-brand-600 bg-brand-100 dark:bg-brand-800/30'
                  : 'text-content-tertiary hover:text-content-secondary hover:bg-surface-tertiary'
              }`}
              title="Save schema"
            >
              <UploadCloud className="h-4 w-4" />
            </button>
            <button
              onClick={(e) => {
                e.stopPropagation();
                if (hasContent) {
                  setShowResetConfirm(true);
                }
              }}
              disabled={!hasContent}
              className={`p-1.5 rounded transition-colors ${
                hasContent
                  ? 'text-content-tertiary hover:text-status-error hover:bg-red-50 dark:hover:bg-red-900/20'
                  : 'text-content-muted cursor-not-allowed opacity-40'
              }`}
              title="Reset workspace"
            >
              <Trash2 className="h-4 w-4" />
            </button>
          </div>
        </div>
      </div>

      {/* Reset Confirmation Modal */}
      {showResetConfirm && (
        <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50">
          <div className="bg-surface-primary rounded-lg shadow-xl max-w-sm w-full mx-4 p-6">
            <div className="flex items-center gap-3 mb-4">
              <div className="p-2 bg-red-100 dark:bg-red-900/30 rounded-full">
                <Trash2 className="h-5 w-5 text-red-600 dark:text-red-400" />
              </div>
              <h3 className="text-lg font-semibold text-content-primary">Reset Workspace</h3>
            </div>
            <p className="text-content-secondary mb-6">
              This will clear all acquisitions and schema metadata. This action cannot be undone.
            </p>
            <div className="flex justify-end gap-3">
              <button
                onClick={() => setShowResetConfirm(false)}
                className="px-4 py-2 text-sm font-medium rounded-lg border border-border-secondary text-content-secondary hover:bg-surface-secondary"
              >
                Cancel
              </button>
              <button
                onClick={handleReset}
                className="px-4 py-2 text-sm font-medium rounded-lg bg-red-600 text-white hover:bg-red-700"
              >
                Reset
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Content */}
      <div className="p-2 space-y-2 flex-1 overflow-y-auto min-h-0">
        {/* Action Buttons */}
        <div className="flex gap-2">
          {/* From Data Button */}
          <button
            data-tutorial="from-data-button"
            onClick={() => onSelect(ADD_FROM_DATA_ID)}
            className={`flex-1 flex items-center justify-center gap-1.5 px-2 py-2.5 border rounded-lg transition-all group ${
              isFromDataSelected
                ? 'border-brand-500 bg-brand-50 dark:bg-brand-900/20 shadow-md'
                : 'border-dashed border-border-secondary hover:border-brand-400 hover:bg-brand-50 dark:hover:bg-brand-900/20'
            }`}
          >
            <Plus className="h-3.5 w-3.5 text-brand-500 group-hover:scale-110 transition-transform flex-shrink-0" />
            <span className="text-xs font-medium text-content-primary whitespace-nowrap">From data</span>
          </button>

          {/* From Schema Button */}
          <button
            data-tutorial="from-schema-button"
            onClick={() => onSelect(ADD_NEW_ID)}
            className={`flex-1 flex items-center justify-center gap-1.5 px-2 py-2.5 border rounded-lg transition-all group ${
              isSchemaLibrarySelected
                ? 'border-brand-500 bg-brand-50 dark:bg-brand-900/20 shadow-md'
                : 'border-dashed border-border-secondary hover:border-brand-400 hover:bg-brand-50 dark:hover:bg-brand-900/20'
            }`}
          >
            <FileText className="h-3.5 w-3.5 text-brand-500 group-hover:scale-110 transition-transform flex-shrink-0" />
            <span className="text-xs font-medium text-content-primary whitespace-nowrap">From schema</span>
          </button>
        </div>

        {/* Assign button - always visible, faded when unavailable, amber when unassigned items exist */}
        <button
          data-tutorial="assign-button"
          onClick={() => showAssignButton && onSelect(ASSIGN_DATA_ID)}
          disabled={!showAssignButton}
          className={`w-full flex items-center justify-center gap-2 px-3 py-2 border rounded-lg text-sm font-medium transition-colors ${
            !showAssignButton
              ? 'bg-gray-50 dark:bg-gray-800/50 border-gray-200 dark:border-gray-700 text-gray-400 dark:text-gray-500 cursor-not-allowed opacity-60'
              : selectedId === ASSIGN_DATA_ID
                ? 'bg-brand-50 dark:bg-brand-900/20 border-brand-500 text-brand-700 dark:text-brand-300 shadow-md'
                : hasUnassignedItems
                  ? 'bg-amber-50 dark:bg-amber-900/20 border-amber-300 dark:border-amber-700 text-amber-700 dark:text-amber-300 hover:bg-amber-100 dark:hover:bg-amber-900/30'
                  : 'bg-surface-secondary border-border-secondary text-content-secondary hover:bg-surface-tertiary hover:border-border'
          }`}
        >
          <Link2 className="h-4 w-4" />
          Assign data to references
        </button>

        {/* Drop zone indicator - always visible when From schema is open, highlighted when dragging */}
        {(isSchemaLibrarySelected || isOverDropZone) && items.length === 0 && (
          <div className={`p-3 text-center text-sm border-2 border-dashed rounded-lg transition-colors ${
            isOverDropZone
              ? 'text-brand-600 dark:text-brand-400 border-brand-500 bg-brand-50 dark:bg-brand-900/30'
              : 'text-content-tertiary border-border-secondary bg-surface-secondary'
          }`}>
            Drop schemas to add
          </div>
        )}

        {/* Sortable items */}
        <div data-tutorial="workspace-items">
          <SortableContext
            items={items.map(item => item.id)}
            strategy={verticalListSortingStrategy}
          >
            {items.map(item => (
              <SortableWorkspaceItem
                key={item.id}
                item={item}
                isSelected={selectedId === item.id}
                onSelect={() => onSelect(item.id)}
                onRemove={() => onRemove(item.id)}
              />
            ))}
          </SortableContext>
        </div>

        {/* Drop zone indicator when items exist - always visible when From schema is open */}
        {(isSchemaLibrarySelected || isOverDropZone) && items.length > 0 && (
          <div
            data-tutorial="sidebar-drop-zone"
            className={`p-3 text-center text-sm border-2 border-dashed rounded-lg transition-colors ${
              isOverDropZone
                ? 'text-brand-600 dark:text-brand-400 border-brand-500 bg-brand-50 dark:bg-brand-900/30'
                : 'text-content-tertiary border-border-secondary bg-surface-secondary'
            }`}
          >
            Drop schemas to add
          </div>
        )}
      </div>
    </div>
  );
};

export default WorkspaceSidebar;
