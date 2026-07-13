import type { DicomField, SeriesField } from '../types';

/**
 * Schema field format used by the Python dicompare library.
 * This is the format expected when building schema JSON for validation.
 */
export interface SchemaFieldOutput {
  field: string;
  tag?: string;
  value?: any;
  tolerance?: number;
  contains?: string;
  contains_any?: any[];
  contains_all?: any[];
}

/**
 * Convert a DicomField or SeriesField to schema field format.
 *
 * Schema field format: { field: string, tag?: string, value?: any, tolerance?: number, ... }
 *
 * This unified function handles both acquisition-level (DicomField) and series-level (SeriesField)
 * fields since they share the same relevant properties for schema conversion.
 */
export function fieldToSchemaField(field: DicomField | SeriesField): SchemaFieldOutput {
  const schemaField: SchemaFieldOutput = {
    field: field.name || field.keyword || field.tag || ''
  };

  if (field.tag) {
    schemaField.tag = field.tag;
  }

  if (field.value !== undefined && field.value !== null && field.value !== '') {
    schemaField.value = field.value;
  }

  if (field.validationRule) {
    if (field.validationRule.type === 'tolerance' && field.validationRule.tolerance !== undefined) {
      schemaField.tolerance = field.validationRule.tolerance;
    }
    if (field.validationRule.type === 'contains' && field.validationRule.contains) {
      schemaField.contains = field.validationRule.contains;
    }
    if (field.validationRule.type === 'contains_any' && field.validationRule.contains_any) {
      schemaField.contains_any = field.validationRule.contains_any;
    }
    if (field.validationRule.type === 'contains_all' && field.validationRule.contains_all) {
      schemaField.contains_all = field.validationRule.contains_all;
    }
  }

  return schemaField;
}

/**
 * Convert an acquisition-level DicomField to schema field format.
 * Alias for fieldToSchemaField for semantic clarity.
 */
export function acquisitionFieldToSchemaField(field: DicomField): SchemaFieldOutput {
  return fieldToSchemaField(field);
}

/**
 * Convert a series-level SeriesField to schema field format.
 * Alias for fieldToSchemaField for semantic clarity.
 */
export function seriesFieldToSchemaField(field: SeriesField): SchemaFieldOutput {
  return fieldToSchemaField(field);
}
