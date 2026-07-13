import React, { createContext, useContext, useCallback, ReactNode, useRef, useState } from 'react';
import { Waypoints, X } from 'lucide-react';
import { Acquisition, DicomField, Series, SeriesField, SelectedValidationFunction, AcquisitionSelection } from '../types';
import { SchemaBinding, UnifiedSchema } from '../hooks/useSchemaService';
import { dicompareWorkerAPI as dicompareAPI } from '../services/DicompareWorkerAPI';
import { generateDicomsFromAcquisition } from '../utils/testDataGeneration';
import { convertSchemaToAcquisition } from '../utils/schemaToAcquisition';
import { createEmptyAcquisition } from '../utils/workspaceHelpers';
import { processUploadedFiles } from '../utils/fileUploadUtils';
import { getGradientFileType, computeGradientBindings } from '../hooks/useFileProcessing';
import { dicomFileCache } from '../utils/dicomFileCache';

// Import from new contexts
import { useProcessing } from './ProcessingContext';
import { FileHandleManager } from '../utils/fileHandleManager';
import { useSchemaMetadata } from './SchemaMetadataContext';
import { useItemManagement } from './ItemManagementContext';
import { useSchemaEditing } from './SchemaEditingContext';

// Re-export types from workspace/types.ts for backwards compatibility
export type {
  WorkspaceItem,
  SchemaMetadata,
  ProcessingProgress,
  PendingAttachmentSelection,
  PendingMatchingOperation,
} from './workspace/types';

import {
  WorkspaceItem,
  SchemaMetadata,
  ProcessingProgress,
  PendingAttachmentSelection,
  PendingMatchingOperation,
  DEFAULT_SCHEMA_METADATA,
} from './workspace/types';

import { getItemFlags } from '../utils/workspaceHelpers';

interface WorkspaceContextType {
  // State
  items: WorkspaceItem[];
  selectedId: string | null;
  schemaMetadata: SchemaMetadata;
  isProcessing: boolean;
  processingTarget: 'schema' | 'data' | 'addNew' | null;
  processingProgress: ProcessingProgress | null;
  processingError: string | null;
  pendingAttachmentSelection: PendingAttachmentSelection | null;
  pendingMatchingOperation: PendingMatchingOperation | null;

  // Add items
  addFromSchema: (selections: AcquisitionSelection[], getSchemaContent: (id: string) => Promise<string | null>, getUnifiedSchema: (id: string) => UnifiedSchema | null) => Promise<string[]>;
  addFromData: (files: FileList, mode?: 'schema-template' | 'validation-subject') => Promise<void>;
  addFromDataWithHandles: (manager: FileHandleManager, mode?: 'schema-template' | 'validation-subject') => Promise<void>;
  addFromScratch: () => string;
  addEmpty: () => string;

  // Schema management for empty items
  createSchemaForItem: (id: string) => void;
  detachCreatedSchema: (id: string) => void;

  // Item management
  selectItem: (id: string | null) => void;
  removeItem: (id: string) => void;
  reorderItems: (fromIndex: number, toIndex: number) => void;
  clearAll: () => Promise<void>;

  // Edit mode
  toggleEditing: (id: string) => void;
  setItemEditing: (id: string, isEditing: boolean) => void;

  // Data usage mode (for data-sourced items)
  setDataUsageMode: (id: string, mode: 'schema-template' | 'validation-subject') => void;

  // Attachments
  attachData: (id: string, files: FileList) => Promise<void>;
  attachSchema: (id: string, binding: SchemaBinding) => void;
  uploadSchemaForItem: (id: string, files: FileList) => Promise<void>;
  detachData: (id: string) => void;
  detachDataToNew: (id: string) => void;
  swapData: (fromId: string, toId: string) => void;
  detachSchema: (id: string) => void;
  detachValidationData: (id: string) => void;
  generateTestData: (id: string, getSchemaContent: (id: string) => Promise<string | null>) => Promise<void>;

  // Attachment selection (when multiple acquisitions found)
  confirmAttachmentSelection: (acquisitionIndex: number) => void;
  cancelAttachmentSelection: () => void;

  // Matching operation (when multiple test data acquisitions need matching to references)
  triggerManualMatching: () => void;
  confirmMatching: (matches: Array<{ uploadedIndex: number; itemId: string | null }>, operation?: PendingMatchingOperation) => void;
  cancelMatching: () => void;

  // Acquisition editing (when isEditing=true)
  updateAcquisition: (id: string, updates: Partial<Acquisition>) => void;
  updateField: (id: string, fieldTag: string, updates: Partial<DicomField>) => void;
  deleteField: (id: string, fieldTag: string) => void;
  convertFieldLevel: (id: string, fieldTag: string, toLevel: 'acquisition' | 'series', mode?: 'separate-series' | 'single-series') => void;
  addFields: (id: string, fieldTags: string[]) => Promise<void>;
  updateSeries: (id: string, seriesIndex: number, fieldTag: string, updates: Partial<SeriesField>) => void;
  addSeries: (id: string) => void;
  deleteSeries: (id: string, seriesIndex: number) => void;
  updateSeriesName: (id: string, seriesIndex: number, name: string) => void;
  addValidationFunction: (id: string, func: SelectedValidationFunction) => void;
  updateValidationFunction: (id: string, index: number, func: SelectedValidationFunction) => void;
  deleteValidationFunction: (id: string, index: number) => void;

  // Test data notes (for print report only)
  updateTestDataNotes: (id: string, notes: string) => void;

  // Schema metadata
  setSchemaMetadata: (metadata: SchemaMetadata) => void;

  // Export
  getSchemaExport: (getSchemaContent: (id: string) => Promise<string | null>) => Promise<{ acquisitions: Acquisition[]; metadata: SchemaMetadata }>;

  // Helpers
  getSchemaAcquisition: (binding: SchemaBinding, getSchemaContent: (id: string) => Promise<string | null>) => Promise<Acquisition | null>;

  // Load entire schema for editing
  loadSchema: (schemaId: string, getSchemaContent: (id: string) => Promise<string | null>, getUnifiedSchema: (id: string) => UnifiedSchema | null) => Promise<void>;
}

const WorkspaceContext = createContext<WorkspaceContextType | undefined>(undefined);

interface WorkspaceProviderProps {
  children: ReactNode;
}

export const WorkspaceProvider: React.FC<WorkspaceProviderProps> = ({ children }) => {
  // Consume the new contexts
  const { isProcessing, processingTarget, processingProgress, processingError, processFiles, processFileHandles } = useProcessing();
  const { schemaMetadata, setSchemaMetadata, resetMetadata } = useSchemaMetadata();
  const { items, selectedId, setItems, selectItem, removeItem, reorderItems, clearItems, flashItems } = useItemManagement();
  const editing = useSchemaEditing();

  // Local state for attachment selection modal
  const [pendingAttachmentSelection, setPendingAttachmentSelection] = useState<PendingAttachmentSelection | null>(null);

  // Local state for multi-acquisition matching modal
  const [pendingMatchingOperation, setPendingMatchingOperation] = useState<PendingMatchingOperation | null>(null);

  // Transient notice shown when a dropped gradient file couldn't be matched.
  const [gradientNotice, setGradientNotice] = useState<string | null>(null);

  // Cache for schema acquisitions
  const schemaAcquisitionsRef = useRef<Map<string, Acquisition>>(new Map());

  // Helper to get or load schema acquisition
  const getSchemaAcquisition = useCallback(async (
    binding: SchemaBinding,
    getSchemaContent: (id: string) => Promise<string | null>
  ): Promise<Acquisition | null> => {
    const key = `${binding.schemaId}-${binding.acquisitionId || 'default'}`;

    if (schemaAcquisitionsRef.current.has(key)) {
      return schemaAcquisitionsRef.current.get(key)!;
    }

    try {
      const acquisition = await convertSchemaToAcquisition(
        binding.schema,
        binding.acquisitionId || '0',
        getSchemaContent
      );
      if (acquisition) {
        schemaAcquisitionsRef.current.set(key, acquisition);
      }
      return acquisition;
    } catch (error) {
      console.error('Failed to get schema acquisition:', error);
      return null;
    }
  }, []);

  // Helper to check if an item is completely empty and should be auto-removed
  const isItemCompletelyEmpty = useCallback((item: WorkspaceItem): boolean => {
    return (
      item.source === 'empty' &&
      !item.hasCreatedSchema &&
      !item.attachedSchema &&
      !item.attachedData
    );
  }, []);

  // Helper to update an item and auto-remove if it becomes empty
  const updateItemWithCleanup = useCallback((
    id: string,
    updateFn: (item: WorkspaceItem) => WorkspaceItem
  ) => {
    setItems(prev => {
      const updated = prev.map(item => item.id === id ? updateFn(item) : item);
      const targetItem = updated.find(item => item.id === id);
      const shouldRemove = targetItem && isItemCompletelyEmpty(targetItem);

      if (shouldRemove) {
        if (selectedId === id) {
          selectItem('__add_from_data__');
        }
        return updated.filter(item => item.id !== id);
      }
      return updated;
    });
  }, [isItemCompletelyEmpty, selectedId, setItems, selectItem]);

  // Add items from schema selections
  const addFromSchema = useCallback(async (
    selections: AcquisitionSelection[],
    getSchemaContent: (id: string) => Promise<string | null>,
    getUnifiedSchema: (id: string) => UnifiedSchema | null
  ) => {
    const newItems: WorkspaceItem[] = [];

    for (const selection of selections) {
      const schema = getUnifiedSchema(selection.schemaId);
      if (!schema) continue;

      const acquisition = await convertSchemaToAcquisition(
        schema,
        selection.acquisitionIndex.toString(),
        getSchemaContent
      );

      if (acquisition) {
        newItems.push({
          id: `ws_${Date.now()}_${selection.acquisitionIndex}`,
          acquisition,
          source: 'schema',
          isEditing: false,
          schemaOrigin: {
            schemaId: selection.schemaId,
            acquisitionIndex: selection.acquisitionIndex,
            schemaName: selection.schemaName,
            acquisitionName: selection.acquisitionName
          }
        });
      }
    }

    setItems(prev => [...prev, ...newItems]);
    return newItems.map(item => item.id);
  }, [setItems]);

  // Add items from DICOM files or protocol files
  const addFromData = useCallback(async (files: FileList, mode: 'schema-template' | 'validation-subject' = 'schema-template') => {
    const fileArray = Array.from(files);

    // Gradient-only drop: don't create new items — bind the descriptors to the
    // matching diffusion acquisitions already in the workspace. Scope the match
    // to the side the file was dropped on: a gradient dropped on the Reference
    // area only attaches to reference acquisitions, and one dropped on the Test
    // data area only to test-data acquisitions.
    if (fileArray.length > 0 && fileArray.every(f => getGradientFileType(f.name) !== null)) {
      const wantTestData = mode === 'validation-subject';
      const acqIsTestData = (it: WorkspaceItem) =>
        it.source === 'data' && it.dataUsageMode === 'validation-subject';
      const acqIsReference = (it: WorkspaceItem) =>
        it.source === 'schema' ||
        (it.source === 'data' && it.dataUsageMode !== 'validation-subject') ||
        (it.source === 'empty' && !!it.hasCreatedSchema);
      const candidates = items.filter(it =>
        it.acquisition && (wantTestData ? acqIsTestData(it) : acqIsReference(it))
      );
      const existingAcqs = candidates.map(it => it.acquisition) as Acquisition[];
      const bindings = await computeGradientBindings(existingAcqs, fileArray);
      if (bindings.length === 0) {
        const names = fileArray.map(f => f.name).join(', ');
        setGradientNotice(
          `Read the gradient file (${names}), but found no matching diffusion acquisition to attach it to. ` +
          `Load the corresponding protocol or DICOMs first — the file binds to the acquisition whose direction set it names.`
        );
        return;
      }
      const fieldsById = new Map(bindings.map(b => [b.acquisition.id, b.fields]));
      const matchedIds = items
        .filter(it => it.acquisition && fieldsById.has(it.acquisition.id))
        .map(it => it.id);
      setItems(prev => prev.map(it =>
        it.acquisition && fieldsById.has(it.acquisition.id)
          ? { ...it, acquisition: { ...it.acquisition, acquisitionFields: fieldsById.get(it.acquisition.id)! } }
          : it
      ));
      // Navigate to one matched acquisition and flash all that were updated.
      if (matchedIds.length > 0) {
        selectItem(matchedIds[0]);
        flashItems(matchedIds);
      }
      return;
    }

    const target = mode === 'validation-subject' ? 'data' : 'schema';
    const { acquisitions: newAcquisitions, dicomFileBatchId } = await processFiles(files, target);

    // Create new items for all uploaded acquisitions
    // User can use "Assign data to references" panel to match them to existing references
    const newItems: WorkspaceItem[] = newAcquisitions.map((acq, idx) => ({
      id: `ws_${Date.now()}_${acq.id || idx}`,
      acquisition: acq,
      source: 'data' as const,
      isEditing: false,
      dataUsageMode: mode,
      dicomFileBatchId,
    }));

    setItems(prev => [...prev, ...newItems]);

    if (newItems.length > 0) {
      // If uploading multiple validation-subject items, check if there are reference slots without data
      if (newItems.length > 1 && mode === 'validation-subject') {
        // Check current items for references without attached data
        const hasUnfilledReferenceSlots = items.some(item => {
          const flags = getItemFlags(item);
          return flags.hasSchema && !flags.hasData;
        });

        if (hasUnfilledReferenceSlots) {
          // Navigate to matching panel
          selectItem('__assign_data__');
          return;
        }
      }

      // Only navigate into an acquisition when a single one was added; for
      // multiple, stay on the From data page so the user keeps their overview.
      if (newItems.length === 1) {
        selectItem(newItems[0].id);
      }
    }
  }, [processFiles, setItems, selectItem, items]);

  // Add items from DICOM files using File System Access API (for large datasets >2GB)
  const addFromDataWithHandles = useCallback(async (
    manager: FileHandleManager,
    mode: 'schema-template' | 'validation-subject' = 'schema-template'
  ) => {
    const target = mode === 'validation-subject' ? 'data' : 'schema';
    const { acquisitions: newAcquisitions, dicomFileBatchId } = await processFileHandles(manager, target);

    const newItems: WorkspaceItem[] = newAcquisitions.map((acq, idx) => ({
      id: `ws_${Date.now()}_${acq.id || idx}`,
      acquisition: acq,
      source: 'data' as const,
      isEditing: false,
      dataUsageMode: mode,
      dicomFileBatchId,
    }));

    setItems(prev => [...prev, ...newItems]);

    if (newItems.length > 0) {
      // If uploading multiple validation-subject items, check if there are reference slots without data
      if (newItems.length > 1 && mode === 'validation-subject') {
        // Check current items for references without attached data
        const hasUnfilledReferenceSlots = items.some(item => {
          const flags = getItemFlags(item);
          return flags.hasSchema && !flags.hasData;
        });

        if (hasUnfilledReferenceSlots) {
          // Navigate to matching panel
          selectItem('__assign_data__');
          return;
        }
      }

      // Only navigate into an acquisition when a single one was added; for
      // multiple, stay on the From data page so the user keeps their overview.
      if (newItems.length === 1) {
        selectItem(newItems[0].id);
      }
    }
  }, [processFileHandles, setItems, selectItem, items]);

  // Add a new empty acquisition from scratch
  const addFromScratch = useCallback((): string => {
    const newId = `ws_${Date.now()}_scratch`;
    const newItem: WorkspaceItem = {
      id: newId,
      acquisition: createEmptyAcquisition(newId, 'New Acquisition'),
      source: 'schema',
      isEditing: true
    };

    setItems(prev => [...prev, newItem]);
    selectItem(newId);
    return newId;
  }, [setItems, selectItem]);

  // Add a truly empty item
  const addEmpty = useCallback((): string => {
    const newId = `ws_${Date.now()}_empty`;
    const newItem: WorkspaceItem = {
      id: newId,
      acquisition: createEmptyAcquisition(newId),
      source: 'empty',
      isEditing: false
    };

    setItems(prev => [...prev, newItem]);
    selectItem(newId);
    return newId;
  }, [setItems, selectItem]);

  // Create empty schema for an empty item
  const createSchemaForItem = useCallback((id: string) => {
    setItems(prev => prev.map(item => {
      if (item.id !== id) return item;

      return {
        ...item,
        hasCreatedSchema: true,
        attachedSchema: undefined,
        isEditing: true,
        acquisition: {
          ...item.acquisition,
          protocolName: item.acquisition.protocolName || 'New Acquisition',
        }
      };
    }));
  }, [setItems]);

  // Remove created schema from an item
  const detachCreatedSchema = useCallback((id: string) => {
    updateItemWithCleanup(id, item => ({
      ...item,
      hasCreatedSchema: false,
      isEditing: false,
      schemaOrigin: undefined,
      acquisition: {
        ...item.acquisition,
        protocolName: '',
        seriesDescription: '',
        acquisitionFields: [],
        series: [],
        validationFunctions: [],
        detailedDescription: undefined,
        tags: undefined
      }
    }));
  }, [updateItemWithCleanup]);

  // Clear all items
  const clearAll = useCallback(async () => {
    clearItems();
    resetMetadata();
    schemaAcquisitionsRef.current = new Map();
    dicomFileCache.clear();
    try {
      await dicompareAPI.clearSessionCache();
    } catch (error) {
      console.error('Failed to clear session cache:', error);
    }
  }, [clearItems, resetMetadata]);

  // Toggle editing mode for an item
  const toggleEditing = useCallback((id: string) => {
    setItems(prev => prev.map(item =>
      item.id === id ? { ...item, isEditing: !item.isEditing } : item
    ));
  }, [setItems]);

  // Set editing mode explicitly
  const setItemEditing = useCallback((id: string, isEditing: boolean) => {
    setItems(prev => prev.map(item =>
      item.id === id ? { ...item, isEditing } : item
    ));
  }, [setItems]);

  // Set data usage mode for data-sourced items
  const setDataUsageMode = useCallback((id: string, mode: 'schema-template' | 'validation-subject') => {
    setItems(prev => prev.map(item => {
      if (item.id !== id || item.source !== 'data') return item;

      const newIsEditing = mode === 'validation-subject' ? false : item.isEditing;
      return { ...item, dataUsageMode: mode, isEditing: newIsEditing };
    }));
  }, [setItems]);

  // Attach data to a schema-sourced item
  const attachData = useCallback(async (id: string, files: FileList) => {
    const { acquisitions: allAcquisitions, dicomFileBatchId } = await processFiles(files, 'data');

    if (allAcquisitions.length === 1) {
      // Single acquisition: attach directly to the item
      setItems(prev => prev.map(item =>
        item.id === id ? { ...item, attachedData: allAcquisitions[0], attachedDataBatchId: dicomFileBatchId } : item
      ));
    } else if (allAcquisitions.length > 1) {
      // Multiple acquisitions: create items for all and navigate to matching panel
      const newItems: WorkspaceItem[] = allAcquisitions.map((acq, idx) => ({
        id: `ws_${Date.now()}_${acq.id || idx}`,
        acquisition: acq,
        source: 'data' as const,
        isEditing: false,
        dataUsageMode: 'validation-subject' as const,
        dicomFileBatchId,
      }));

      setItems(prev => [...prev, ...newItems]);

      // Navigate to the matching panel so user can assign data to references
      selectItem('__assign_data__');
    }
  }, [processFiles, setItems, selectItem]);

  // Attach schema to an item
  const attachSchema = useCallback((id: string, binding: SchemaBinding) => {
    setItems(prev => prev.map(item => {
      if (item.id !== id) return item;

      let updatedAcquisition = item.acquisition;
      if (item.source === 'empty') {
        const acquisitionIndex = binding.acquisitionId ? parseInt(binding.acquisitionId) : 0;
        const schemaAcquisition = binding.schema.acquisitions?.[acquisitionIndex];

        updatedAcquisition = {
          ...item.acquisition,
          protocolName: binding.acquisitionName || item.acquisition.protocolName,
          seriesDescription: schemaAcquisition?.seriesDescription || item.acquisition.seriesDescription || '',
          tags: schemaAcquisition?.tags || item.acquisition.tags
        };
      }

      return {
        ...item,
        attachedSchema: binding,
        hasCreatedSchema: false,
        acquisition: updatedAcquisition
      };
    }));
  }, [setItems]);

  // Upload files to build a schema for an existing item
  const uploadSchemaForItem = useCallback(async (id: string, files: FileList) => {
    const { acquisitions: newAcquisitions } = await processFiles(files, 'schema');

    if (newAcquisitions.length > 0) {
      const schemaAcquisition = newAcquisitions[0];
      setItems(prev => prev.map(item => {
        if (item.id !== id) return item;

        const preservedData = item.dataUsageMode === 'validation-subject'
          ? item.acquisition
          : item.attachedData;

        return {
          ...item,
          source: 'data' as const,
          dataUsageMode: 'schema-template' as const,
          hasCreatedSchema: false,
          attachedSchema: undefined,
          isEditing: false,
          acquisition: schemaAcquisition,
          attachedData: preservedData
        };
      }));
    }
  }, [processFiles, setItems]);

  // Detach data
  const detachData = useCallback((id: string) => {
    updateItemWithCleanup(id, item => ({ ...item, attachedData: undefined }));
  }, [updateItemWithCleanup]);

  // Detach data and create a new acquisition with it
  const detachDataToNew = useCallback((id: string) => {
    setItems(prev => {
      const sourceItem = prev.find(item => item.id === id);
      if (!sourceItem) return prev;

      // Get the data to move (could be attachedData or the main acquisition data if source is 'data')
      const dataToMove = sourceItem.attachedData || (sourceItem.source === 'data' ? sourceItem.acquisition : null);
      if (!dataToMove) return prev;

      // Create new item with the data
      const newId = `data_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
      const newItem: WorkspaceItem = {
        id: newId,
        source: 'data',
        dataUsageMode: 'validation-subject',
        acquisition: dataToMove,
        isEditing: false,
      };

      // Update source item to remove its data
      const updatedItems = prev.map(item => {
        if (item.id !== id) return item;

        if (item.source === 'data' && !item.attachedData) {
          // Source was data-sourced, convert to empty with just schema if it has one
          if (item.attachedSchema) {
            return {
              ...item,
              source: 'schema' as const,
              dataUsageMode: undefined,
              acquisition: createEmptyAcquisition(item.id, item.acquisition.protocolName),
            };
          }
          // No schema, item should be removed
          return null;
        }

        // Just remove attachedData
        return { ...item, attachedData: undefined };
      }).filter((item): item is WorkspaceItem => item !== null);

      return [...updatedItems, newItem];
    });
  }, [setItems]);

  // Swap data between two items
  const swapData = useCallback((fromId: string, toId: string) => {
    setItems(prev => {
      const fromItem = prev.find(item => item.id === fromId);
      const toItem = prev.find(item => item.id === toId);

      if (!fromItem || !toItem) return prev;

      // Get data from source (attachedData or acquisition if source is 'data')
      const fromData = fromItem.attachedData || (fromItem.source === 'data' ? fromItem.acquisition : null);
      const toData = toItem.attachedData || (toItem.source === 'data' ? toItem.acquisition : null);

      if (!fromData) return prev; // Nothing to swap from source

      return prev.map(item => {
        if (item.id === fromId) {
          // Put toData into fromItem (or remove data if toData is null)
          if (fromItem.source === 'data' && !fromItem.attachedData) {
            // fromItem's main acquisition is the data, replace it
            if (toData) {
              return { ...item, acquisition: toData };
            } else {
              // No data to put back, convert to empty or schema-only
              if (item.attachedSchema) {
                return {
                  ...item,
                  source: 'schema' as const,
                  dataUsageMode: undefined,
                  acquisition: createEmptyAcquisition(item.id, item.acquisition.protocolName),
                };
              }
              return { ...item, source: 'empty' as const, dataUsageMode: undefined, acquisition: createEmptyAcquisition(item.id) };
            }
          } else {
            // fromItem has attachedData - remove it or replace with toData
            // Explicitly remove attachedData by destructuring it out
            const { attachedData: _, ...rest } = item;
            if (toData) {
              return { ...rest, attachedData: toData };
            } else {
              return rest; // No attachedData property at all
            }
          }
        }

        if (item.id === toId) {
          // Put fromData into toItem
          if (toItem.source === 'data' && !toItem.attachedData) {
            // toItem's main acquisition is the data, replace it
            return { ...item, acquisition: fromData };
          } else {
            // toItem has attachedData or is not data-sourced - add fromData
            return { ...item, attachedData: fromData };
          }
        }

        return item;
      });
    });
  }, [setItems]);

  // Detach validation data
  const detachValidationData = useCallback((id: string) => {
    updateItemWithCleanup(id, item => {
      if (item.source !== 'data' || item.dataUsageMode !== 'validation-subject') return item;

      return {
        ...item,
        source: 'empty' as const,
        dataUsageMode: undefined,
        acquisition: createEmptyAcquisition(
          item.id,
          item.attachedSchema ? (item.acquisition.protocolName || '') : ''
        ),
        attachedSchema: item.attachedSchema
      } as WorkspaceItem;
    });
  }, [updateItemWithCleanup]);

  // Detach schema
  const detachSchema = useCallback((id: string) => {
    updateItemWithCleanup(id, item => {
      if (item.source === 'schema') {
        return {
          ...item,
          source: 'empty' as const,
          schemaOrigin: undefined,
          attachedSchema: undefined,
          hasCreatedSchema: false,
          isEditing: false,
          acquisition: createEmptyAcquisition(item.id),
          attachedData: item.attachedData
        };
      }
      if (item.source === 'data' && item.dataUsageMode !== 'validation-subject') {
        return {
          ...item,
          source: 'empty' as const,
          dataUsageMode: undefined,
          attachedSchema: undefined,
          hasCreatedSchema: false,
          isEditing: false,
          acquisition: createEmptyAcquisition(item.id),
          attachedData: item.attachedData
        };
      }
      if (item.source === 'empty' && item.attachedSchema) {
        return {
          ...item,
          attachedSchema: undefined,
          acquisition: {
            ...item.acquisition,
            protocolName: '',
            seriesDescription: '',
            tags: undefined
          },
          attachedData: item.attachedData
        };
      }
      return {
        ...item,
        attachedSchema: undefined,
        attachedData: item.attachedData
      };
    });
  }, [updateItemWithCleanup]);

  // Confirm attachment selection
  const confirmAttachmentSelection = useCallback((acquisitionIndex: number) => {
    if (!pendingAttachmentSelection) return;

    const { targetItemId, acquisitions } = pendingAttachmentSelection;
    const selectedAcquisition = acquisitions[acquisitionIndex];

    if (selectedAcquisition) {
      setItems(prev => prev.map(item =>
        item.id === targetItemId ? { ...item, attachedData: selectedAcquisition } : item
      ));
    }

    setPendingAttachmentSelection(null);
  }, [pendingAttachmentSelection, setItems]);

  // Cancel attachment selection
  const cancelAttachmentSelection = useCallback(() => {
    setPendingAttachmentSelection(null);
  }, []);

  // Confirm matching operation - apply matches and handle reassignments
  const confirmMatching = useCallback((
    matches: Array<{ uploadedIndex: number; itemId: string | null }>,
    operation?: PendingMatchingOperation
  ) => {
    // Use passed operation or fall back to pendingMatchingOperation state
    const op = operation || pendingMatchingOperation;
    if (!op) return;

    const { uploadedAcquisitions, sourceItemIds, initialAssignments } = op;

    // Build maps for efficient lookup
    // newAssignments: targetItemId -> acquisition to attach
    const newAssignments = new Map<string, Acquisition>();
    // sourceItemsToRemove: source item IDs that should be removed (data moved elsewhere)
    const sourceItemsToRemove = new Set<string>();
    // targetsWithData: items that will have data after this operation
    const targetsWithData = new Set<string>();
    // unmatchedAcquisitions: data that was explicitly left unmatched (should become standalone items)
    const unmatchedAcquisitions: Acquisition[] = [];

    // Build initial assignment map for comparison
    const initialAssignmentMap = new Map<number, string>();
    initialAssignments?.forEach(a => initialAssignmentMap.set(a.uploadedIndex, a.itemId));

    // Process each match
    matches.forEach(({ uploadedIndex, itemId }) => {
      const acq = uploadedAcquisitions[uploadedIndex];
      if (!acq) return;

      const sourceItemId = sourceItemIds?.[uploadedIndex];
      const previousTargetId = initialAssignmentMap.get(uploadedIndex);

      if (itemId) {
        // Data is assigned to a target
        newAssignments.set(itemId, acq);
        targetsWithData.add(itemId);

        // If data came from a standalone item (not attached to a schema item),
        // and it's now being assigned to a different item, remove the standalone
        if (sourceItemId && sourceItemId !== itemId && sourceItemId !== previousTargetId) {
          // Check if source was a standalone data item (validation-subject without schema)
          // We'll check this during the setItems call
          sourceItemsToRemove.add(sourceItemId);
        }
      } else {
        // itemId is null - data is unmatched
        // Determine if we need to create a standalone item for this data

        // Data was assigned somewhere (attached to a reference or validation-subject with schema)
        const wasAssigned = previousTargetId !== undefined;

        // Data's source item is being removed (assigned to a different reference)
        const isSourceBeingRemoved = sourceItemId && sourceItemsToRemove.has(sourceItemId);

        // Check if this is already a standalone item that will remain in place
        // Standalone data items (validation-subject without attached schema) have sourceItemId
        // but are NOT in initialAssignments, so previousTargetId is undefined
        const isExistingStandalone = sourceItemId && !previousTargetId;

        // Create standalone if:
        // 1. Data was assigned and is being detached (and not already a standalone)
        // 2. OR data's source is being removed
        if ((wasAssigned && !isExistingStandalone) || isSourceBeingRemoved) {
          unmatchedAcquisitions.push(acq);
        }
      }
    });

    // Apply all changes in one atomic update
    setItems(prev => {
      let updated = prev.map(item => {
        // Check if this item should get new data attached
        if (newAssignments.has(item.id)) {
          return { ...item, attachedData: newAssignments.get(item.id) };
        }

        // Check if this item had data but it's been moved elsewhere
        // (item was a target before, but not in the new assignments)
        if (item.attachedData) {
          // Find if this item's attached data was in the uploaded list
          const wasSource = uploadedAcquisitions.some((acq, idx) => {
            const prevTarget = initialAssignmentMap.get(idx);
            return prevTarget === item.id && !targetsWithData.has(item.id);
          });
          if (wasSource) {
            // Remove attached data from this item
            const { attachedData: _, ...rest } = item;
            return rest as WorkspaceItem;
          }
        }

        return item;
      });

      // Remove standalone data items that were assigned elsewhere
      if (sourceItemsToRemove.size > 0) {
        updated = updated.filter(item => {
          if (!sourceItemsToRemove.has(item.id)) return true;
          // Only remove if it's a standalone data item (validation-subject without schema attached)
          const flags = getItemFlags(item);
          return !(item.source === 'data' && item.dataUsageMode === 'validation-subject' && !flags.hasSchema);
        });
      }

      // Create new standalone items for data that was moved to "Unmatched"
      if (unmatchedAcquisitions.length > 0) {
        const newItems: WorkspaceItem[] = unmatchedAcquisitions.map((acq, idx) => ({
          id: `ws_${Date.now()}_unmatched_${idx}`,
          acquisition: acq,
          source: 'data' as const,
          isEditing: false,
          dataUsageMode: 'validation-subject' as const
        }));
        updated = [...updated, ...newItems];
      }

      return updated;
    });

    // Only clear pendingMatchingOperation if we were using it (not a passed operation)
    if (!operation && pendingMatchingOperation) {
      setPendingMatchingOperation(null);
    }
  }, [pendingMatchingOperation, setItems]);

  // Cancel matching operation
  const cancelMatching = useCallback(() => {
    if (!pendingMatchingOperation) return;

    const { uploadedAcquisitions, sourceItemIds } = pendingMatchingOperation;

    // For manual matching (has sourceItemIds), just close the modal - data already exists
    if (sourceItemIds) {
      setPendingMatchingOperation(null);
      return;
    }

    // For new data upload, create items for the uploaded acquisitions
    const newItems: WorkspaceItem[] = uploadedAcquisitions.map((acq, idx) => ({
      id: `ws_${Date.now()}_${acq.id || idx}`,
      acquisition: acq,
      source: 'data' as const,
      isEditing: false,
      dataUsageMode: 'validation-subject' as const
    }));

    setItems(prev => [...prev, ...newItems]);

    if (newItems.length > 0) {
      selectItem(newItems[0].id);
    }

    setPendingMatchingOperation(null);
  }, [pendingMatchingOperation, setItems, selectItem]);

  // Trigger manual matching - shows all data and all references with current assignments
  const triggerManualMatching = useCallback(() => {
    // Collect all data from items (attachedData or data-sourced items)
    const dataEntries: Array<{ acquisition: Acquisition; sourceItemId: string; assignedToItemId?: string }> = [];

    // First, collect data attached to schema items (these have assignments)
    items.forEach(item => {
      const flags = getItemFlags(item);
      if (item.attachedData) {
        // This data is attached to this item (assigned)
        dataEntries.push({
          acquisition: item.attachedData,
          sourceItemId: item.id, // The item itself is the "source" for attached data
          assignedToItemId: flags.hasSchema ? item.id : undefined
        });
      }
    });

    // Then, collect standalone data items (data-sourced without being attached elsewhere)
    items.forEach(item => {
      if (item.source === 'data') {
        const flags = getItemFlags(item);
        // If it's a validation-subject with attached schema, it's assigned to itself
        // If it's a schema-template, it's its own schema (don't include as moveable data)
        if (item.dataUsageMode === 'validation-subject') {
          dataEntries.push({
            acquisition: item.acquisition,
            sourceItemId: item.id,
            assignedToItemId: flags.hasSchema ? item.id : undefined
          });
        }
      }
    });

    // Collect all items with schema as available slots
    const schemaItems = items.filter(item => {
      const flags = getItemFlags(item);
      return flags.hasSchema;
    });

    if (dataEntries.length === 0 || schemaItems.length === 0) return;

    // Build the operation data
    const uploadedAcquisitions = dataEntries.map(e => e.acquisition);
    const sourceItemIds = dataEntries.map(e => e.sourceItemId);
    const initialAssignments = dataEntries
      .map((e, idx) => e.assignedToItemId ? { uploadedIndex: idx, itemId: e.assignedToItemId } : null)
      .filter((a): a is { uploadedIndex: number; itemId: string } => a !== null);

    const availableSlots = schemaItems.map(item => ({
      itemId: item.id,
      item
    }));

    setPendingMatchingOperation({
      uploadedAcquisitions,
      availableSlots,
      sourceItemIds,
      initialAssignments
    });
  }, [items]);

  // Generate test data for a schema-sourced item
  const generateTestData = useCallback(async (
    id: string,
    getSchemaContent: (id: string) => Promise<string | null>
  ) => {
    const item = items.find(i => i.id === id);
    if (!item || !item.schemaOrigin) return;

    try {
      const dicomFiles = await generateDicomsFromAcquisition(item.acquisition, () => {});

      const fileList = new DataTransfer();
      dicomFiles.forEach(file => fileList.items.add(file));

      const fileObjects = await processUploadedFiles(fileList.files, {});
      const result = await dicompareAPI.analyzeFilesForUI(fileObjects, () => {});

      if (result && result.length > 0) {
        setItems(prev => prev.map(item =>
          item.id === id ? { ...item, attachedData: result[0] } : item
        ));
      }
    } catch (error) {
      console.error('Failed to generate test data:', error);
    }
  }, [items, setItems]);

  // Get acquisitions for schema export
  const getSchemaExport = useCallback(async (getSchemaContent: (id: string) => Promise<string | null>) => {
    const acquisitions: Acquisition[] = [];

    for (const item of items) {
      const hasSchemaContent =
        item.attachedSchema ||
        item.hasCreatedSchema ||
        item.source === 'schema' ||
        (item.source === 'data' && item.dataUsageMode !== 'validation-subject');

      if (!hasSchemaContent) {
        continue;
      }

      if (item.attachedSchema) {
        const schemaAcq = await convertSchemaToAcquisition(
          item.attachedSchema.schema,
          item.attachedSchema.acquisitionId || '0',
          getSchemaContent
        );
        if (schemaAcq) {
          acquisitions.push({
            ...schemaAcq,
            protocolName: item.acquisition.protocolName || schemaAcq.protocolName,
            seriesDescription: item.acquisition.seriesDescription || schemaAcq.seriesDescription,
            tags: item.acquisition.tags || schemaAcq.tags,
          });
        }
      } else {
        acquisitions.push(item.acquisition);
      }
    }

    return { acquisitions, metadata: schemaMetadata };
  }, [items, schemaMetadata]);

  // Load entire schema for editing
  const loadSchema = useCallback(async (
    schemaId: string,
    getSchemaContent: (id: string) => Promise<string | null>,
    getUnifiedSchema: (id: string) => UnifiedSchema | null
  ) => {
    const schema = getUnifiedSchema(schemaId);
    if (!schema) {
      console.error('Schema not found:', schemaId);
      return;
    }

    clearItems();
    schemaAcquisitionsRef.current = new Map();
    try {
      await dicompareAPI.clearSessionCache();
    } catch (error) {
      console.error('Failed to clear session cache:', error);
    }

    setSchemaMetadata({
      name: schema.name || '',
      description: schema.description || '',
      authors: schema.authors || [],
      version: schema.version || '1.0',
    });

    const acquisitionCount = schema.acquisitions?.length || 1;
    const newItems: WorkspaceItem[] = [];

    for (let i = 0; i < acquisitionCount; i++) {
      const acquisition = await convertSchemaToAcquisition(schema, i.toString(), getSchemaContent);
      if (acquisition) {
        newItems.push({
          id: `ws_${Date.now()}_${i}`,
          acquisition,
          source: 'schema',
          isEditing: false,
          schemaOrigin: {
            schemaId: schema.id,
            acquisitionIndex: i,
            schemaName: schema.name,
            acquisitionName: acquisition.protocolName
          }
        });
      }
    }

    setItems(newItems);

    if (newItems.length > 0) {
      selectItem(newItems[0].id);
    }
  }, [clearItems, setItems, selectItem, setSchemaMetadata]);

  const value: WorkspaceContextType = {
    items,
    selectedId,
    schemaMetadata,
    isProcessing,
    processingTarget,
    processingProgress,
    processingError,
    pendingAttachmentSelection,
    pendingMatchingOperation,
    addFromSchema,
    addFromData,
    addFromDataWithHandles,
    addFromScratch,
    addEmpty,
    createSchemaForItem,
    detachCreatedSchema,
    selectItem,
    removeItem,
    reorderItems,
    clearAll,
    toggleEditing,
    setItemEditing,
    setDataUsageMode,
    attachData,
    attachSchema,
    uploadSchemaForItem,
    detachData,
    detachDataToNew,
    swapData,
    detachSchema,
    detachValidationData,
    confirmAttachmentSelection,
    cancelAttachmentSelection,
    triggerManualMatching,
    confirmMatching,
    cancelMatching,
    generateTestData,
    // From SchemaEditingContext
    updateAcquisition: editing.updateAcquisition,
    updateField: editing.updateField,
    deleteField: editing.deleteField,
    convertFieldLevel: editing.convertFieldLevel,
    addFields: editing.addFields,
    updateSeries: editing.updateSeries,
    addSeries: editing.addSeries,
    deleteSeries: editing.deleteSeries,
    updateSeriesName: editing.updateSeriesName,
    addValidationFunction: editing.addValidationFunction,
    updateValidationFunction: editing.updateValidationFunction,
    deleteValidationFunction: editing.deleteValidationFunction,
    updateTestDataNotes: editing.updateTestDataNotes,
    setSchemaMetadata,
    getSchemaExport,
    getSchemaAcquisition,
    loadSchema
  };

  return (
    <WorkspaceContext.Provider value={value}>
      {children}
      {gradientNotice && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
          onClick={() => setGradientNotice(null)}
        >
          <div
            className="bg-surface-primary rounded-lg shadow-xl max-w-md w-full p-6"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-start gap-3">
              <div className="p-2 bg-amber-100 dark:bg-amber-900/30 rounded-full flex-shrink-0">
                <Waypoints className="h-5 w-5 text-amber-600 dark:text-amber-400" />
              </div>
              <div className="flex-1 min-w-0">
                <h3 className="text-sm font-semibold text-content-primary">Gradient file not attached</h3>
                <p className="text-sm text-content-secondary mt-1">{gradientNotice}</p>
              </div>
              <button
                onClick={() => setGradientNotice(null)}
                className="p-1 rounded text-content-tertiary hover:text-content-primary hover:bg-surface-secondary flex-shrink-0"
              >
                <X className="h-4 w-4" />
              </button>
            </div>
            <div className="mt-4 flex justify-end">
              <button
                onClick={() => setGradientNotice(null)}
                className="px-4 py-2 text-sm font-medium rounded-lg bg-brand-600 text-white hover:bg-brand-700"
              >
                Got it
              </button>
            </div>
          </div>
        </div>
      )}
    </WorkspaceContext.Provider>
  );
};

export const useWorkspace = (): WorkspaceContextType => {
  const context = useContext(WorkspaceContext);
  if (context === undefined) {
    throw new Error('useWorkspace must be used within a WorkspaceProvider');
  }
  return context;
};
