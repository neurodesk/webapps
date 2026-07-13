import { useSchemaContext, SchemaAcquisition } from '../contexts/SchemaContext';
import { SchemaTemplate } from '../types/schema';

// Re-export for backwards compatibility
export type { SchemaAcquisition } from '../contexts/SchemaContext';

export interface UnifiedSchema extends SchemaTemplate {
  acquisitions: SchemaAcquisition[];
  isMultiAcquisition: boolean;
}

export interface SchemaBinding {
  schemaId: string;
  acquisitionId?: string;
  acquisitionName?: string;
  schema: UnifiedSchema;
}

export const useSchemaService = () => {
  const {
    schemas: uploadedSchemas,
    librarySchemas,
    schemaAcquisitions,
    isLibraryLoading,
    isAcquisitionsLoading,
    getUniversalSchemaContent: getSchemaContent,
    parseSchemaAcquisitions,
    refreshLibrarySchemas
  } = useSchemaContext();

  // Get all schemas (uploaded + library) with acquisition data
  // Note: Schema-level tags don't exist per metaschema - tags are only at acquisition level
  const getAllUnifiedSchemas = (): UnifiedSchema[] => {
    const uploadedUnified: UnifiedSchema[] = uploadedSchemas.map(schema => ({
      id: schema.id,
      name: schema.title,
      description: schema.description || '',
      category: 'Uploaded Schema',
      content: '',
      format: schema.format,
      version: schema.version,
      authors: schema.authors,
      acquisitions: schemaAcquisitions[schema.id] || [],
      isMultiAcquisition: (schemaAcquisitions[schema.id] || []).length > 1
    }));

    const libraryUnified: UnifiedSchema[] = librarySchemas.map(schema => ({
      ...schema,
      acquisitions: schemaAcquisitions[schema.id] || [],
      isMultiAcquisition: (schemaAcquisitions[schema.id] || []).length > 1
    }));

    return [...uploadedUnified, ...libraryUnified];
  };

  // Get specific schema by ID
  const getUnifiedSchema = (schemaId: string): UnifiedSchema | null => {
    return getAllUnifiedSchemas().find(s => s.id === schemaId) || null;
  };

  return {
    // Schema data
    getAllUnifiedSchemas,
    getUnifiedSchema,
    getSchemaContent,
    parseSchemaAcquisitions,

    // Schema categories
    uploadedSchemas: getAllUnifiedSchemas().filter(s => s.category === 'Uploaded Schema'),
    librarySchemas: getAllUnifiedSchemas().filter(s => s.category === 'Library'),

    // State
    isLoading: isLibraryLoading || isAcquisitionsLoading,

    // Actions
    refreshLibrarySchemas
  };
};