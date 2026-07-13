import { FieldDataType, ValidationRule } from '../types';
import { getDataTypeFromVR } from './vrMapping';
import { searchDicomFields, suggestDataType } from '../services/dicomFieldService';

/**
 * Builds a ValidationRule from schema field properties (tolerance, min/max, contains, etc.)
 * Used by both acquisition and series field processors
 */
export function buildValidationRuleFromSchema(schemaField: any): ValidationRule {
  if (schemaField.tolerance !== undefined) {
    return { type: 'tolerance', value: schemaField.value, tolerance: schemaField.tolerance };
  }
  if (schemaField.min !== undefined || schemaField.max !== undefined) {
    // Handle range with min-only, max-only, or both
    return { type: 'range', min: schemaField.min, max: schemaField.max };
  }
  if (schemaField.contains !== undefined) {
    return { type: 'contains', contains: schemaField.contains };
  }
  if (schemaField.contains_any !== undefined) {
    return { type: 'contains_any', contains_any: schemaField.contains_any };
  }
  if (schemaField.contains_all !== undefined) {
    return { type: 'contains_all', contains_all: schemaField.contains_all };
  }
  return { type: 'exact', value: schemaField.value };
}

/**
 * Infers the data type from a given value
 * Used consistently across the application for both acquisition and series fields
 */
export function inferDataTypeFromValue(value: any): FieldDataType {
  if (value === null || value === undefined || value === '') {
    return 'string'; // Default to string for empty values
  }

  if (Array.isArray(value)) {
    if (value.length === 0) {
      return 'list_string'; // Default to string list for empty arrays
    }

    // Check if all elements are numbers
    const allNumbers = value.every(item =>
      typeof item === 'number' && !isNaN(item)
    );

    return allNumbers ? 'list_number' : 'list_string';
  }

  if (typeof value === 'number' && !isNaN(value)) {
    return 'number';
  }

  if (typeof value === 'object') {
    return 'json';
  }

  return 'string';
}

/**
 * Converts a value to match the specified data type
 * Used when changing data types in the UI
 */
export function convertValueToDataType(value: any, dataType: FieldDataType): any {
  switch (dataType) {
    case 'string':
      if (Array.isArray(value)) {
        return value.join(', ');
      }
      return String(value || '');

    case 'number':
      if (Array.isArray(value)) {
        const first = value.length > 0 ? Number(value[0]) : 0;
        return isNaN(first) ? 0 : first;
      }
      const num = Number(value);
      return isNaN(num) ? 0 : num;

    case 'list_string':
      if (Array.isArray(value)) {
        return value.map(v => String(v));
      }
      if (typeof value === 'string' && value.includes(',')) {
        return value.split(',').map(v => v.trim()).filter(v => v.length > 0);
      }
      return value ? [String(value)] : [];

    case 'list_number':
      if (Array.isArray(value)) {
        return value.map(v => Number(v) || 0);
      }
      if (typeof value === 'string' && value.includes(',')) {
        return value.split(',')
          .map(v => v.trim())
          .filter(v => v.length > 0)
          .map(v => Number(v) || 0);
      }
      return value !== '' && !isNaN(Number(value)) ? [Number(value)] : [];

    case 'json':
      if (typeof value === 'string') {
        try {
          return JSON.parse(value);
        } catch {
          return value;
        }
      }
      return value;

    default:
      return value;
  }
}

/**
 * Convert schema field format to UI field format while preserving validation rules
 * This should be used instead of processFieldForUI for schema data
 */
export function processSchemaFieldForUI(schemaField: any): any {
  // Try to get proper data type from VR and VM if available, otherwise check for known field patterns
  let dataType;
  // First, respect explicit dataType from the schema JSON if provided
  if (schemaField.dataType) {
    dataType = schemaField.dataType;
  } else if (schemaField.vr && schemaField.valueMultiplicity) {
    dataType = getDataTypeFromVR(schemaField.vr, schemaField.valueMultiplicity, schemaField.value);
  } else if (schemaField.tag) {
    // Check for known multi-value fields by tag

    // Known multi-value numeric fields
    const knownListNumberFields = [
      '0018,1149', // Field of View Dimensions
      '0028,0030', // Pixel Spacing
      '0018,1310', // Acquisition Matrix
      '0020,0032', // Image Position Patient
      '0020,0037', // Image Orientation Patient
    ];

    // Known multi-value string fields
    const knownListStringFields = [
      '0008,0008', // Image Type
      '0018,0021', // Sequence Variant
      '0018,0022', // Scan Options
    ];

    const normalizedTag = schemaField.tag.replace(/[()]/g, '');

    if (knownListNumberFields.includes(normalizedTag)) {
      dataType = 'list_number';
    } else if (knownListStringFields.includes(normalizedTag)) {
      dataType = 'list_string';
    } else {
      // Fallback to value-based inference
      dataType = inferDataTypeFromValue(schemaField.value);
    }
  } else {
    // Fallback to value-based inference
    dataType = inferDataTypeFromValue(schemaField.value);
  }

  const validationRule = buildValidationRuleFromSchema(schemaField);

  // Determine fieldType: use explicit fieldType if provided, otherwise infer from tag value
  // Tag values can be: standard DICOM format (XXXX,XXXX), or special values: "derived", "private", "custom"
  let fieldType = schemaField.fieldType;
  if (!fieldType && schemaField.tag) {
    if (schemaField.tag === 'derived') {
      fieldType = 'derived';
    } else if (schemaField.tag === 'private') {
      fieldType = 'private';
    } else if (schemaField.tag === 'custom') {
      fieldType = 'custom';
    }
    // If tag is a valid DICOM format, fieldType defaults to 'standard' (handled elsewhere)
  }

  return {
    tag: schemaField.tag,
    name: schemaField.field || schemaField.name || schemaField.tag,
    keyword: schemaField.field, // Schema format stores DICOM keyword in 'field'
    value: schemaField.value,
    vr: schemaField.vr || 'UN',
    level: schemaField.level || 'acquisition',
    dataType,
    validationRule,
    fieldType  // Preserve explicit field type or infer from tag
  };
}

/**
 * Process series field value for schema data
 */
export function processSchemaSeriesFieldValue(schemaField: any, fieldName?: string, tag?: string): any {
  const dataType = inferDataTypeFromValue(schemaField.value);
  const validationRule = buildValidationRuleFromSchema(schemaField);

  return {
    value: schemaField.value,
    field: fieldName || schemaField.field || schemaField.name,
    dataType,
    validationRule
  };
}