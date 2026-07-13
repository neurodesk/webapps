import { FieldDataType, ValidationRule } from '../types';

// Discriminated union for field values
export type FieldValue =
  | { type: 'string'; value: string }
  | { type: 'number'; value: number }
  | { type: 'list_string'; value: string[] }
  | { type: 'list_number'; value: number[] }
  | { type: 'json'; value: Record<string, any> };

// Type guards
export const isStringField = (value: FieldValue): value is { type: 'string'; value: string } =>
  value.type === 'string';

export const isNumberField = (value: FieldValue): value is { type: 'number'; value: number } =>
  value.type === 'number';

export const isListStringField = (value: FieldValue): value is { type: 'list_string'; value: string[] } =>
  value.type === 'list_string';

export const isListNumberField = (value: FieldValue): value is { type: 'list_number'; value: number[] } =>
  value.type === 'list_number';

export const isJsonField = (value: FieldValue): value is { type: 'json'; value: Record<string, any> } =>
  value.type === 'json';

// Validation and type casting
export const validateFieldValue = (value: any, dataType: FieldDataType): FieldValue => {
  switch (dataType) {
    case 'string':
      return { type: 'string', value: String(value || '') };

    case 'number':
      const numValue = Number(value);
      return {
        type: 'number',
        value: isNaN(numValue) ? 0 : numValue
      };

    case 'list_string':
      if (Array.isArray(value)) {
        return { type: 'list_string', value: value.map(String) };
      }
      if (typeof value === 'string') {
        // Split by comma, semicolon, or newline
        const items = value.split(/[,;\n]/).map(s => s.trim()).filter(Boolean);
        return { type: 'list_string', value: items };
      }
      return { type: 'list_string', value: [] };

    case 'list_number':
      if (Array.isArray(value)) {
        return {
          type: 'list_number',
          value: value.map(v => {
            const num = Number(v);
            return isNaN(num) ? 0 : num;
          })
        };
      }
      if (typeof value === 'string') {
        const items = value.split(/[,;\n]/).map(s => {
          const num = Number(s.trim());
          return isNaN(num) ? 0 : num;
        }).filter(num => !isNaN(num));
        return { type: 'list_number', value: items };
      }
      return { type: 'list_number', value: [] };

    case 'json':
      if (typeof value === 'object' && value !== null) {
        return { type: 'json', value };
      }
      if (typeof value === 'string') {
        try {
          const parsed = JSON.parse(value);
          return { type: 'json', value: parsed };
        } catch {
          return { type: 'json', value: {} };
        }
      }
      return { type: 'json', value: {} };

    default:
      return { type: 'string', value: String(value || '') };
  }
};

// Convert FieldValue back to any (for backward compatibility)
export const extractFieldValue = (fieldValue: FieldValue): any => {
  return fieldValue.value;
};

// Validate a field value against a validation rule
export const validateAgainstRule = (fieldValue: FieldValue, rule?: ValidationRule): boolean => {
  if (!rule || rule.type === 'exact') {
    return true; // Exact values are always considered valid
  }

  switch (rule.type) {
    case 'tolerance':
      if (isNumberField(fieldValue)) {
        const target = Number(rule.value || 0);
        const tolerance = Number(rule.tolerance || 0);
        return Math.abs(fieldValue.value - target) <= tolerance;
      }
      return false;

    case 'range':
      if (isNumberField(fieldValue)) {
        const min = rule.min !== undefined ? Number(rule.min) : -Infinity;
        const max = rule.max !== undefined ? Number(rule.max) : Infinity;
        return fieldValue.value >= min && fieldValue.value <= max;
      }
      return false;

    case 'contains':
      if (isStringField(fieldValue)) {
        const searchTerm = rule.contains || '';
        return fieldValue.value.includes(searchTerm);
      }
      return false;

    default:
      return true;
  }
};
