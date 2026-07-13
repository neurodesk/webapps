import React, { createContext, useContext, useState, useCallback, useRef, ReactNode, Dispatch, SetStateAction } from 'react';
import { WorkspaceItem } from './workspace/types';
import { dicomFileCache } from '../utils/dicomFileCache';

export type { WorkspaceItem };

interface ItemManagementContextType {
  items: WorkspaceItem[];
  selectedId: string | null;
  setItems: Dispatch<SetStateAction<WorkspaceItem[]>>;
  selectItem: (id: string | null) => void;
  removeItem: (id: string) => void;
  reorderItems: (fromIndex: number, toIndex: number) => void;
  clearItems: () => void;
  getSelectedItem: () => WorkspaceItem | undefined;
  /** Item ids currently flashing (transient highlight in the list). */
  flashItemIds: Set<string>;
  /** Briefly flash the given item ids in the acquisitions list. */
  flashItems: (ids: string[]) => void;
}

const ItemManagementContext = createContext<ItemManagementContextType | undefined>(undefined);

interface ItemManagementProviderProps {
  children: ReactNode;
}

export const ItemManagementProvider: React.FC<ItemManagementProviderProps> = ({ children }) => {
  const [items, setItems] = useState<WorkspaceItem[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [flashItemIds, setFlashItemIds] = useState<Set<string>>(new Set());
  const flashTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const selectItem = useCallback((id: string | null) => {
    setSelectedId(id);
  }, []);

  const flashItems = useCallback((ids: string[]) => {
    if (ids.length === 0) return;
    if (flashTimeoutRef.current) clearTimeout(flashTimeoutRef.current);
    setFlashItemIds(new Set(ids));
    flashTimeoutRef.current = setTimeout(() => setFlashItemIds(new Set()), 1600);
  }, []);

  const removeItem = useCallback((id: string) => {
    setItems(prev => {
      const removedItem = prev.find(item => item.id === id);
      const newItems = prev.filter(item => item.id !== id);
      const index = prev.findIndex(item => item.id === id);

      // Clean up DICOM file cache if batch is no longer referenced
      if (removedItem) {
        for (const batchId of [removedItem.dicomFileBatchId, removedItem.attachedDataBatchId]) {
          if (batchId && !newItems.some(item => item.dicomFileBatchId === batchId || item.attachedDataBatchId === batchId)) {
            dicomFileCache.delete(batchId);
          }
        }
      }

      // Auto-select another item if needed
      if (id === selectedId && newItems.length > 0) {
        const newIndex = Math.min(index, newItems.length - 1);
        setSelectedId(newItems[newIndex].id);
      } else if (newItems.length === 0) {
        setSelectedId(null);
      }

      return newItems;
    });
  }, [selectedId]);

  const reorderItems = useCallback((fromIndex: number, toIndex: number) => {
    setItems(prev => {
      const newItems = [...prev];
      const [movedItem] = newItems.splice(fromIndex, 1);
      newItems.splice(toIndex, 0, movedItem);
      return newItems;
    });
  }, []);

  const clearItems = useCallback(() => {
    setItems([]);
    setSelectedId(null);
  }, []);

  const getSelectedItem = useCallback(() => {
    return items.find(item => item.id === selectedId);
  }, [items, selectedId]);

  return (
    <ItemManagementContext.Provider value={{
      items,
      selectedId,
      setItems,
      selectItem,
      removeItem,
      reorderItems,
      clearItems,
      getSelectedItem,
      flashItemIds,
      flashItems,
    }}>
      {children}
    </ItemManagementContext.Provider>
  );
};

export function useItemManagement(): ItemManagementContextType {
  const context = useContext(ItemManagementContext);
  if (context === undefined) {
    throw new Error('useItemManagement must be used within an ItemManagementProvider');
  }
  return context;
}
