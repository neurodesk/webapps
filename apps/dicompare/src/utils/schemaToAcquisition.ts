import { UnifiedSchema } from '../hooks/useSchemaService';
import { Acquisition, DicomField } from '../types';
import { inferDataTypeFromValue, processSchemaFieldForUI } from './datatypeInference';
import { buildValidationRuleFromField } from './fieldFormatters';

/**
 * Converts a UnifiedSchema and specific acquisition to a full Acquisition object
 * that can be used with AcquisitionTable
 */
export const convertSchemaToAcquisition = async (
  schema: UnifiedSchema,
  acquisitionId: string,
  getSchemaContent: (schemaId: string) => Promise<string | null>
): Promise<Acquisition | null> => {
  try {
    const content = await getSchemaContent(schema.id);
    if (!content) return null;

    const schemaData = JSON.parse(content);

    // Find the specific acquisition in the schema
    const acquisitionEntries = Object.entries(schemaData.acquisitions || {});
    let acquisitionEntry;

    if (acquisitionId === '0' && acquisitionEntries.length > 0) {
      // Default to first acquisition if ID is '0'
      acquisitionEntry = acquisitionEntries[0];
    } else {
      // Try to find by acquisition ID or index
      acquisitionEntry = acquisitionEntries.find(([_, data]: [string, any]) =>
        data.id === acquisitionId
      ) || acquisitionEntries[parseInt(acquisitionId) || 0];
    }

    if (!acquisitionEntry) return null;

    const [acquisitionName, acquisitionData] = acquisitionEntry as [string, any];

    // Convert schema fields to DicomField format using proper inference
    const convertFields = (fields: any[] = [], level: 'acquisition' | 'series'): DicomField[] => {
      return fields.map(field => {
        const processedField = processSchemaFieldForUI(field);
        return {
          ...processedField,
          level, // Override level from parameter
          value: processedField.value ?? field.defaultValue ?? ''
        };
      });
    };

    // Only use actual defined fields, not fields extracted from rules
    const allFields = acquisitionData.fields || [];

    // Build unique series field definitions from all series
    const seriesFieldMap = new Map();
    if (acquisitionData.series) {
      acquisitionData.series.forEach((series: any) => {
        if (series.fields && Array.isArray(series.fields)) {
          series.fields.forEach((field: any) => {
            const fieldKey = field.tag || field.name || field.field;  // Use name/field for derived fields
            if (!seriesFieldMap.has(fieldKey)) {
              const processedField = processSchemaFieldForUI(field);
              seriesFieldMap.set(fieldKey, {
                ...processedField,
                level: 'series'
              });
            }
          });
        }
      });
    }

    // Build the acquisition object
    const acquisition: Acquisition = {
      id: `schema-${schema.id}-${acquisitionId}`,
      protocolName: acquisitionName,
      seriesDescription: acquisitionData.description || '',
      detailedDescription: acquisitionData.detailed_description || '', // Map snake_case to camelCase
      totalFiles: 0, // Schema templates don't have files
      acquisitionFields: convertFields(allFields.filter((f: any) => !f.level || f.level === 'acquisition'), 'acquisition'),
      // seriesFields removed - now embedded in series[].fields[]
      series: acquisitionData.series?.map((series: any, index: number) => ({
        name: series.name || `Series ${index + 1}`,
        fields: (series.fields || []).map((field: any) => {
          const processedField = processSchemaFieldForUI(field);
          return {
            name: processedField.name,
            tag: processedField.tag,
            value: processedField.value ?? field.defaultValue ?? '',
            validationRule: processedField.validationRule || { type: 'exact' as const },
            fieldType: processedField.fieldType || field.fieldType  // Preserve field type (standard/derived)
          };
        }),
        images: series.images || [],
      })) || [],
      validationFunctions: acquisitionData.rules || acquisitionData.validationFunctions || [],
      tags: acquisitionData.tags || [],
      images: acquisitionData.images || [],
      metadata: {
        manufacturer: schema.authors?.join(', ') || 'Schema Template',
        notes: `Template from schema: ${schema.name} v${schema.version || '1.0.0'}`,
        ...acquisitionData.metadata
      }
    };

    return acquisition;
  } catch (error) {
    console.error('Failed to convert schema to acquisition:', error);
    return null;
  }
};

/**
 * Converts all acquisitions in a schema to Acquisition objects
 */
export const convertSchemaToAcquisitions = async (
  schema: UnifiedSchema,
  getSchemaContent: (schemaId: string) => Promise<string | null>
): Promise<Acquisition[]> => {
  const acquisitions: Acquisition[] = [];

  // Fetch the actual JSON content to discover acquisitions
  // (don't rely on schema.acquisitions metadata which may not be loaded yet)
  try {
    const content = await getSchemaContent(schema.id);
    if (!content) {
      console.error('Could not load schema content for:', schema.id);
      return acquisitions;
    }

    const schemaData = JSON.parse(content);
    const acquisitionEntries = Object.entries(schemaData.acquisitions || {});

    for (let index = 0; index < acquisitionEntries.length; index++) {
      const acquisition = await convertSchemaToAcquisition(schema, index.toString(), getSchemaContent);
      if (acquisition) {
        acquisitions.push(acquisition);
      }
    }
  } catch (error) {
    console.error('Failed to load acquisitions for schema:', schema.id, error);
  }

  return acquisitions;
};

/**
 * Converts raw schema acquisition data to an Acquisition object ready for AcquisitionContext.
 * This is the same logic used by handleCopyFromSchema in BuildSchema.tsx.
 *
 * @param acquisitionName - The name/key of the acquisition in the schema
 * @param targetAcquisition - The raw acquisition data from parsed schema JSON
 * @param schemaId - Optional schema ID for identification purposes
 * @param tags - Optional tags to include on the acquisition
 */
export const convertRawAcquisitionToContext = (
  acquisitionName: string,
  targetAcquisition: any,
  schemaId?: string,
  tags?: string[]
): Acquisition => {
  const newAcquisition: Acquisition = {
    id: `imported_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
    protocolName: acquisitionName,
    seriesDescription: targetAcquisition.description || (schemaId ? `Imported from ${schemaId}` : ''),
    detailedDescription: targetAcquisition.detailed_description || '',
    totalFiles: 0,
    acquisitionFields: [],
    series: [],
    validationFunctions: [],
    tags: tags || targetAcquisition.tags || [],
    images: targetAcquisition.images || [],
    metadata: targetAcquisition.metadata || {}
  };

  // Process acquisition-level fields
  if (targetAcquisition.fields && Array.isArray(targetAcquisition.fields)) {
    newAcquisition.acquisitionFields = targetAcquisition.fields.map((field: any) => {
      const processedField = processSchemaFieldForUI(field);
      return {
        ...processedField,
        level: 'acquisition' as const
      };
    });
  }

  // Process series-level fields and instances
  if (targetAcquisition.series && Array.isArray(targetAcquisition.series)) {
    newAcquisition.series = targetAcquisition.series.map((series: any) => {
      const seriesFields: any[] = [];

      if (series.fields && Array.isArray(series.fields)) {
        series.fields.forEach((f: any) => {
          const validationRule = buildValidationRuleFromField(f) || { type: 'exact' as const };

          seriesFields.push({
            tag: f.tag,
            name: f.field || f.name,
            value: f.value,
            validationRule,
            fieldType: f.fieldType
          });
        });
      }

      return {
        name: series.name,
        fields: seriesFields,
        images: series.images || [],
      };
    });
  }

  // Process validation rules
  if (targetAcquisition.rules && Array.isArray(targetAcquisition.rules)) {
    newAcquisition.validationFunctions = targetAcquisition.rules.map((rule: any) => ({
      id: rule.id,
      name: rule.name,
      description: rule.description,
      implementation: rule.implementation,
      fields: rule.fields || [],
      category: 'Custom',
      testCases: rule.testCases || [],
      customName: rule.name,
      customDescription: rule.description,
      customFields: rule.fields || [],
      customImplementation: rule.implementation,
      customTestCases: [],
      enabledSystemFields: []
    }));
  }

  return newAcquisition;
};
