import React, { createContext, useContext, useEffect, useState, useRef, useCallback, useMemo, ReactNode } from 'react';
import { SchemaMetadata, SchemaTemplate } from '../types/schema';
import { Acquisition } from '../types';
import { schemaCacheManager } from '../services/SchemaCacheManager';
import { dicompareWorkerAPI } from '../services/DicompareWorkerAPI';
import { convertSchemaToAcquisitions } from '../utils/schemaToAcquisition';

interface EditingSchema {
  id: string;
  content: any;
  metadata?: any;
}

export interface SchemaAcquisition {
  id: string;
  protocolName: string;
  seriesDescription: string;
  tags?: string[];
}

interface OriginSchema {
  id: string;
  name: string;
  type: 'library' | 'uploaded';
  metadata: any;
}

interface SchemaContextValue {
  schemas: SchemaMetadata[];
  librarySchemas: SchemaTemplate[];
  schemaAcquisitions: Record<string, SchemaAcquisition[]>;
  fullAcquisitionsCache: Record<string, Acquisition[]>;
  selectedSchema: SchemaMetadata | null;
  editingSchema: EditingSchema | null;
  originSchema: OriginSchema | null;
  isLoading: boolean;
  isLibraryLoading: boolean;
  isAcquisitionsLoading: boolean;
  error: string | null;

  selectSchema: (schema: SchemaMetadata | null) => void;
  setEditingSchema: (schema: EditingSchema | null) => void;
  setOriginSchema: (schema: OriginSchema | null) => void;
  uploadSchema: (file: File, metadata?: Partial<SchemaMetadata>) => Promise<SchemaMetadata>;
  deleteSchema: (id: string) => Promise<void>;
  refreshSchemas: () => Promise<void>;
  refreshLibrarySchemas: () => Promise<void>;
  getSchemaContent: (id: string) => Promise<string | null>;
  getUniversalSchemaContent: (id: string) => Promise<string | null>;
  parseSchemaAcquisitions: (schemaId: string) => Promise<SchemaAcquisition[]>;
  loadFullAcquisitions: (schemaId: string) => Promise<Acquisition[]>;
  updateSchemaMetadata: (id: string, updates: Partial<SchemaMetadata>) => Promise<void>;
  updateExistingSchema: (originId: string, newContent: any, newMetadata: any) => Promise<void>;
  clearCache: () => Promise<void>;
  getCacheSize: () => Promise<number>;
}

const SchemaContext = createContext<SchemaContextValue | null>(null);

export const useSchemaContext = () => {
  const context = useContext(SchemaContext);
  if (!context) {
    throw new Error('useSchemaContext must be used within a SchemaProvider');
  }
  return context;
};

interface SchemaProviderProps {
  children: ReactNode;
}

export const SchemaProvider: React.FC<SchemaProviderProps> = ({ children }) => {
  const [schemas, setSchemas] = useState<SchemaMetadata[]>([]);
  const [librarySchemas, setLibrarySchemas] = useState<SchemaTemplate[]>([]);
  const [schemaAcquisitions, setSchemaAcquisitions] = useState<Record<string, SchemaAcquisition[]>>({});
  const [fullAcquisitionsCache, setFullAcquisitionsCache] = useState<Record<string, Acquisition[]>>({});
  const [selectedSchema, setSelectedSchema] = useState<SchemaMetadata | null>(null);
  const [editingSchema, setEditingSchema] = useState<EditingSchema | null>(null);
  const [originSchema, setOriginSchema] = useState<OriginSchema | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [isLibraryLoading, setIsLibraryLoading] = useState(true);
  const [isAcquisitionsLoading, setIsAcquisitionsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Refs to track loading state for full acquisitions (avoids duplicate loads)
  const fullAcquisitionsLoadingRef = useRef<Set<string>>(new Set());

  const selectSchema = (schema: SchemaMetadata | null) => {
    setSelectedSchema(schema);
  };

  const refreshSchemas = async () => {
    try {
      setError(null);
      const schemaList = await schemaCacheManager.getAllSchemaMetadata();
      setSchemas(schemaList.sort((a, b) => new Date(b.uploadDate).getTime() - new Date(a.uploadDate).getTime()));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load schemas');
    }
  };

  const refreshLibrarySchemas = async () => {
    try {
      setIsLibraryLoading(true);
      const schemas = await dicompareWorkerAPI.getExampleSchemas();
      setLibrarySchemas(schemas);
    } catch (err) {
      console.error('Failed to load library schemas:', err);
    } finally {
      setIsLibraryLoading(false);
    }
  };

  const uploadSchema = async (file: File, additionalMetadata?: Partial<SchemaMetadata>): Promise<SchemaMetadata> => {
    try {
      setError(null);

      const validation = await schemaCacheManager.validateSchemaFile(file);
      if (!validation.isValid) {
        throw new Error(validation.error || 'Invalid schema file');
      }

      const extractedMetadata = await schemaCacheManager.extractMetadataFromFile(file);
      const id = `schema_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;

      const metadata: SchemaMetadata = {
        id,
        filename: extractedMetadata.filename || file.name,
        title: extractedMetadata.title || file.name.replace(/\.[^/.]+$/, ''),
        version: extractedMetadata.version || '1.0.0',
        authors: extractedMetadata.authors || [],
        uploadDate: extractedMetadata.uploadDate || new Date().toISOString(),
        fileSize: extractedMetadata.fileSize || file.size,
        format: extractedMetadata.format || 'json',
        isValid: validation.isValid,
        description: extractedMetadata.description,
        acquisitionCount: extractedMetadata.acquisitionCount,
        ...additionalMetadata,
      };

      const content = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result as string);
        reader.onerror = () => reject(reader.error);
        reader.readAsText(file);
      });

      await schemaCacheManager.storeSchema(metadata, content);
      await refreshSchemas();

      return metadata;
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : 'Failed to load schema';
      setError(errorMessage);
      throw new Error(errorMessage);
    }
  };

  const deleteSchema = async (id: string) => {
    try {
      setError(null);
      await schemaCacheManager.deleteSchema(id);

      if (selectedSchema?.id === id) {
        setSelectedSchema(null);
      }

      await refreshSchemas();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to delete schema');
    }
  };

  const getSchemaContent = useCallback(async (id: string): Promise<string | null> => {
    try {
      const schema = await schemaCacheManager.getSchema(id);
      return schema?.content || null;
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load schema content');
      return null;
    }
  }, []);

  // Universal schema content loader (handles both uploaded and library schemas)
  const getUniversalSchemaContent = useCallback(async (schemaId: string): Promise<string | null> => {
    // Try uploaded schemas first
    const uploadedContent = await getSchemaContent(schemaId);
    if (uploadedContent) {
      return uploadedContent;
    }

    // Try library schemas (use relative path for file:// protocol compatibility)
    try {
      const response = await fetch(`${import.meta.env.BASE_URL}schemas/${schemaId}.json`);
      if (response.ok) {
        return await response.text();
      }
    } catch (err) {
      console.error(`Failed to load library schema ${schemaId}:`, err);
    }

    return null;
  }, [getSchemaContent]);

  // Parse acquisitions from schema content (with caching)
  const parseSchemaAcquisitions = async (schemaId: string): Promise<SchemaAcquisition[]> => {
    // Return cached if available
    if (schemaAcquisitions[schemaId]) {
      return schemaAcquisitions[schemaId];
    }

    try {
      const content = await getUniversalSchemaContent(schemaId);
      if (!content) {
        return [{ id: '0', protocolName: 'Unknown', seriesDescription: 'Could not load schema' }];
      }

      const schemaData = JSON.parse(content);
      const acquisitionsData = Object.entries(schemaData.acquisitions || {}).map(([name, data]: [string, any]) => ({
        protocolName: name,
        seriesDescription: `${(data.fields || []).length} fields, ${(data.series || []).length} series`,
        ...data
      }));

      const parsed = acquisitionsData.map((acq: any, index: number) => ({
        id: index.toString(),
        protocolName: acq.protocolName,
        seriesDescription: acq.seriesDescription,
        tags: acq.tags
      }));

      // Cache the result
      setSchemaAcquisitions(prev => ({ ...prev, [schemaId]: parsed }));
      return parsed;
    } catch (err) {
      console.error(`Failed to parse acquisitions for schema ${schemaId}:`, err);
      return [{ id: '0', protocolName: 'Parse Error', seriesDescription: 'Could not parse schema' }];
    }
  };

  // Pre-load acquisitions for all schemas
  const preloadAllAcquisitions = async (uploadedList: SchemaMetadata[], libraryList: SchemaTemplate[]) => {
    setIsAcquisitionsLoading(true);
    const allSchemaIds = [
      ...uploadedList.map(s => s.id),
      ...libraryList.map(s => s.id)
    ];

    for (const schemaId of allSchemaIds) {
      if (!schemaAcquisitions[schemaId]) {
        await parseSchemaAcquisitions(schemaId);
      }
    }
    setIsAcquisitionsLoading(false);
  };

  // Load full acquisition data for a schema (with detailed fields, series, etc.)
  // This is cached at the context level so it persists across component remounts
  const loadFullAcquisitions = async (schemaId: string): Promise<Acquisition[]> => {
    // Return cached if available
    if (fullAcquisitionsCache[schemaId]) {
      return fullAcquisitionsCache[schemaId];
    }

    // Check if already loading
    if (fullAcquisitionsLoadingRef.current.has(schemaId)) {
      // Wait for it to finish by polling
      return new Promise((resolve) => {
        const checkInterval = setInterval(() => {
          if (fullAcquisitionsCache[schemaId]) {
            clearInterval(checkInterval);
            resolve(fullAcquisitionsCache[schemaId]);
          }
        }, 50);
      });
    }

    fullAcquisitionsLoadingRef.current.add(schemaId);

    try {
      // Find the schema in library or uploaded
      const allSchemas = [
        ...librarySchemas.map(s => ({ ...s, acquisitions: [], isMultiAcquisition: false })),
        ...schemas.map(s => ({
          id: s.id,
          name: s.title,
          description: s.description || '',
          category: 'Uploaded Schema',
          content: '',
          format: s.format,
          version: s.version,
          authors: s.authors,
          acquisitions: [],
          isMultiAcquisition: false
        }))
      ];
      const schema = allSchemas.find(s => s.id === schemaId);

      if (schema) {
        const acquisitions = await convertSchemaToAcquisitions(schema as any, getUniversalSchemaContent);
        setFullAcquisitionsCache(prev => ({ ...prev, [schemaId]: acquisitions }));
        return acquisitions;
      }
      return [];
    } catch (err) {
      console.error(`Failed to load full acquisitions for schema ${schemaId}:`, err);
      return [];
    } finally {
      fullAcquisitionsLoadingRef.current.delete(schemaId);
    }
  };

  const updateSchemaMetadata = async (id: string, updates: Partial<SchemaMetadata>) => {
    try {
      setError(null);
      await schemaCacheManager.updateSchemaMetadata(id, updates);
      await refreshSchemas();

      if (selectedSchema?.id === id) {
        setSelectedSchema(prev => prev ? { ...prev, ...updates } : null);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to update schema');
    }
  };

  const clearCache = async () => {
    try {
      setError(null);
      await schemaCacheManager.clearCache();
      setSchemas([]);
      setSelectedSchema(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to clear cache');
    }
  };

  const getCacheSize = async (): Promise<number> => {
    try {
      return await schemaCacheManager.getCacheSize();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to get cache size');
      return 0;
    }
  };

  const updateExistingSchema = async (originId: string, newContent: any, newMetadata: any) => {
    try {
      setError(null);

      // Get the existing schema metadata to merge with new metadata
      const existingSchema = await schemaCacheManager.getSchema(originId);
      if (!existingSchema) {
        throw new Error('Original schema not found');
      }

      // Create updated metadata by merging existing with new
      const updatedMetadata = {
        ...existingSchema.metadata,
        ...newMetadata,
        id: originId, // Keep the same ID
        uploadDate: new Date().toISOString() // Update the modification time
      };

      // Use storeSchema to update both content and metadata
      await schemaCacheManager.storeSchema(updatedMetadata, JSON.stringify(newContent));

      await refreshSchemas();

      console.log('✅ Successfully updated existing schema');
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : 'Failed to update existing schema';
      setError(errorMessage);
      throw new Error(errorMessage);
    }
  };

  useEffect(() => {
    const initializeContext = async () => {
      setIsLoading(true);
      setIsLibraryLoading(true);
      setIsAcquisitionsLoading(true);

      try {
        // Initialize and load uploaded schemas
        await schemaCacheManager.initialize();
        const uploadedList = await schemaCacheManager.getAllSchemaMetadata();
        const sortedUploaded = uploadedList.sort((a, b) =>
          new Date(b.uploadDate).getTime() - new Date(a.uploadDate).getTime()
        );
        setSchemas(sortedUploaded);
        setIsLoading(false);

        // Load library schemas
        const libraryList = await dicompareWorkerAPI.getExampleSchemas();
        setLibrarySchemas(libraryList);
        setIsLibraryLoading(false);

        // Preload acquisitions metadata for all schemas
        await preloadAllAcquisitions(sortedUploaded, libraryList);

        // Preload full acquisitions for all schemas in the background
        // This ensures the schema library loads instantly
        const allSchemaIds = [
          ...sortedUploaded.map(s => s.id),
          ...libraryList.map(s => s.id)
        ];

        // Build schema objects for conversion
        const allSchemas = [
          ...libraryList.map(s => ({ ...s, acquisitions: [], isMultiAcquisition: false })),
          ...sortedUploaded.map(s => ({
            id: s.id,
            name: s.title,
            description: s.description || '',
            category: 'Uploaded Schema',
            content: '',
            format: s.format,
            version: s.version,
            authors: s.authors,
            acquisitions: [],
            isMultiAcquisition: false
          }))
        ];

        // Helper to get schema content
        const getContent = async (schemaId: string): Promise<string | null> => {
          // Try uploaded schemas first
          try {
            const schema = await schemaCacheManager.getSchema(schemaId);
            if (schema?.content) return schema.content;
          } catch {}
          // Try library schemas
          try {
            const response = await fetch(`${import.meta.env.BASE_URL}schemas/${schemaId}.json`);
            if (response.ok) return await response.text();
          } catch {}
          return null;
        };

        // Preload full acquisitions for each schema
        for (const schemaId of allSchemaIds) {
          const schema = allSchemas.find(s => s.id === schemaId);
          if (schema) {
            try {
              const acquisitions = await convertSchemaToAcquisitions(schema as any, getContent);
              setFullAcquisitionsCache(prev => ({ ...prev, [schemaId]: acquisitions }));
            } catch (err) {
              console.error(`Failed to preload full acquisitions for ${schemaId}:`, err);
            }
          }
        }
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to initialize schema cache');
        setIsLoading(false);
        setIsLibraryLoading(false);
        setIsAcquisitionsLoading(false);
      }
    };

    initializeContext();
  }, []);

  const value: SchemaContextValue = {
    schemas,
    librarySchemas,
    schemaAcquisitions,
    fullAcquisitionsCache,
    selectedSchema,
    editingSchema,
    originSchema,
    isLoading,
    isLibraryLoading,
    isAcquisitionsLoading,
    error,
    selectSchema,
    setEditingSchema,
    setOriginSchema,
    uploadSchema,
    deleteSchema,
    refreshSchemas,
    refreshLibrarySchemas,
    getSchemaContent,
    getUniversalSchemaContent,
    parseSchemaAcquisitions,
    loadFullAcquisitions,
    updateSchemaMetadata,
    updateExistingSchema,
    clearCache,
    getCacheSize,
  };

  return (
    <SchemaContext.Provider value={value}>
      {children}
    </SchemaContext.Provider>
  );
};