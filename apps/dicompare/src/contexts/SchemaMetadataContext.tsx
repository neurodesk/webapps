import React, { createContext, useContext, useState, useCallback, ReactNode } from 'react';
import { SchemaMetadata, DEFAULT_SCHEMA_METADATA } from './workspace/types';

export type { SchemaMetadata };

interface SchemaMetadataContextType {
  schemaMetadata: SchemaMetadata;
  setSchemaMetadata: (metadata: SchemaMetadata) => void;
  resetMetadata: () => void;
}

const SchemaMetadataContext = createContext<SchemaMetadataContextType | undefined>(undefined);

interface SchemaMetadataProviderProps {
  children: ReactNode;
}

export const SchemaMetadataProvider: React.FC<SchemaMetadataProviderProps> = ({ children }) => {
  const [schemaMetadata, setSchemaMetadataState] = useState<SchemaMetadata>(DEFAULT_SCHEMA_METADATA);

  const setSchemaMetadata = useCallback((metadata: SchemaMetadata) => {
    setSchemaMetadataState(metadata);
  }, []);

  const resetMetadata = useCallback(() => {
    setSchemaMetadataState(DEFAULT_SCHEMA_METADATA);
  }, []);

  return (
    <SchemaMetadataContext.Provider value={{ schemaMetadata, setSchemaMetadata, resetMetadata }}>
      {children}
    </SchemaMetadataContext.Provider>
  );
};

export function useSchemaMetadata(): SchemaMetadataContextType {
  const context = useContext(SchemaMetadataContext);
  if (context === undefined) {
    throw new Error('useSchemaMetadata must be used within a SchemaMetadataProvider');
  }
  return context;
}
