import React, { createContext, useContext, useCallback, ReactNode } from 'react';
import { Acquisition, DicomField, SeriesField, SelectedValidationFunction } from '../types';
import { useItemManagement } from './ItemManagementContext';
import { useWorkspaceEditing } from '../hooks/useWorkspaceEditing';

interface SchemaEditingContextType {
  // Acquisition-level updates
  updateAcquisition: (id: string, updates: Partial<Acquisition>) => void;

  // Field operations
  updateField: (id: string, fieldTag: string, updates: Partial<DicomField>) => void;
  deleteField: (id: string, fieldTag: string) => void;
  convertFieldLevel: (id: string, fieldTag: string, toLevel: 'acquisition' | 'series', mode?: 'separate-series' | 'single-series') => void;
  addFields: (id: string, fieldTags: string[]) => Promise<void>;

  // Series operations
  updateSeries: (id: string, seriesIndex: number, fieldTag: string, updates: Partial<SeriesField>) => void;
  addSeries: (id: string) => void;
  deleteSeries: (id: string, seriesIndex: number) => void;
  updateSeriesName: (id: string, seriesIndex: number, name: string) => void;

  // Validation function operations
  addValidationFunction: (id: string, func: SelectedValidationFunction) => void;
  updateValidationFunction: (id: string, index: number, func: SelectedValidationFunction) => void;
  deleteValidationFunction: (id: string, index: number) => void;

  // Test data notes
  updateTestDataNotes: (id: string, notes: string) => void;
}

const SchemaEditingContext = createContext<SchemaEditingContextType | undefined>(undefined);

interface SchemaEditingProviderProps {
  children: ReactNode;
}

export const SchemaEditingProvider: React.FC<SchemaEditingProviderProps> = ({ children }) => {
  const { setItems } = useItemManagement();

  const editing = useWorkspaceEditing(setItems);

  const updateTestDataNotes = useCallback((id: string, notes: string) => {
    setItems(prev => prev.map(item =>
      item.id === id ? { ...item, testDataNotes: notes } : item
    ));
  }, [setItems]);

  return (
    <SchemaEditingContext.Provider value={{
      ...editing,
      updateTestDataNotes,
    }}>
      {children}
    </SchemaEditingContext.Provider>
  );
};

export function useSchemaEditing(): SchemaEditingContextType {
  const context = useContext(SchemaEditingContext);
  if (context === undefined) {
    throw new Error('useSchemaEditing must be used within a SchemaEditingProvider');
  }
  return context;
}
