import { DicomField, SeriesField, ValidationRule } from '../types';
import { FieldValue, validateFieldValue, extractFieldValue } from '../types/fieldValues';

/**
 * Build a ValidationRule object from raw schema field properties.
 * Schema fields may store constraints directly (e.g., tolerance, contains_all)
 * rather than in a validationRule object.
 */
export function buildValidationRuleFromField(field: any): ValidationRule | undefined {
  if (field.validationRule) {
    return field.validationRule;
  }

  if (field.tolerance !== undefined) {
    return { type: 'tolerance', value: field.value, tolerance: field.tolerance };
  } else if (field.min !== undefined || field.max !== undefined) {
    // Handle range with min-only, max-only, or both
    return { type: 'range', min: field.min, max: field.max };
  } else if (field.contains !== undefined) {
    return { type: 'contains', contains: field.contains };
  } else if (field.contains_any !== undefined) {
    return { type: 'contains_any', contains_any: field.contains_any };
  } else if (field.contains_all !== undefined) {
    return { type: 'contains_all', contains_all: field.contains_all };
  } else if (field.value !== undefined) {
    return { type: 'exact', value: field.value };
  }

  return undefined;
}

export interface FormatOptions {
  showConstraint?: boolean;
  showValue?: boolean;
}

export function formatFieldDisplay(
  value: any,
  validationRule?: ValidationRule,
  options: FormatOptions = { showConstraint: false, showValue: true }
): string {
  // If we're showing constraint and there's a non-exact constraint, show constraint format
  if (options.showConstraint && validationRule && validationRule.type !== 'exact') {
    return formatValidationRule(validationRule);
  }

  // Show the value if available
  if (options.showValue !== false) {
    const formattedValue = formatRawValue(value);
    // If value is empty/dash but we have a constraint-based validation rule, show the constraint instead
    if (formattedValue === '-' && validationRule && ['contains_any', 'contains_all', 'contains'].includes(validationRule.type)) {
      return formatValidationRule(validationRule);
    }
    return formattedValue;
  }

  return '-';
}

// Type-safe version that works with FieldValue
export function formatTypedFieldValue(
  fieldValue: FieldValue,
  validationRule?: ValidationRule,
  options: FormatOptions = { showConstraint: false, showValue: true }
): string {
  // If we're showing constraint and there's a non-exact constraint, show constraint format
  if (options.showConstraint && validationRule && validationRule.type !== 'exact') {
    return formatValidationRule(validationRule);
  }

  // Otherwise, show the typed value
  if (options.showValue !== false) {
    return formatTypedValue(fieldValue);
  }

  return '-';
}

function formatTypedValue(fieldValue: FieldValue): string {
  switch (fieldValue.type) {
    case 'string':
      return fieldValue.value || '-';
    case 'number':
      return String(fieldValue.value);
    case 'list_string':
      return fieldValue.value.length > 0 ? `[${fieldValue.value.join(', ')}]` : '-';
    case 'list_number':
      return fieldValue.value.length > 0 ? `[${fieldValue.value.join(', ')}]` : '-';
    case 'json':
      return JSON.stringify(fieldValue.value, null, 2);
    default:
      return '-';
  }
}

// Backward compatibility - formatFieldValue for DicomField
export function formatFieldValue(field: DicomField): string {
  return formatFieldDisplay(field.value, field.validationRule, { showValue: true, showConstraint: true });
}

// Format series field value - handles validation rules like formatFieldValue does for acquisition fields
export function formatSeriesFieldValue(fieldValue: any, validationRule?: ValidationRule): string {
  // Handle legacy wrapped format for backward compatibility
  // (old format had value wrapped in object with validationRule)
  if (typeof fieldValue === 'object' && fieldValue !== null && 'validationRule' in fieldValue && 'value' in fieldValue) {
    return formatRawValue(fieldValue.value);
  }

  // For non-exact constraints, show the constraint-specific format
  if (validationRule) {
    switch (validationRule.type) {
      case 'tolerance':
        // Show "value ±tolerance" format (same as acquisition fields)
        return `${validationRule.value ?? 0} ±${validationRule.tolerance ?? 0}`;
      case 'range':
        // Show mathematical notation (same as acquisition fields)
        return formatRangeConstraint(validationRule.min, validationRule.max);
      case 'contains':
        // Show "contains substring" format
        return `contains "${validationRule.contains || ''}"`;
      case 'contains_any':
        // Show the array of values to search for
        if (validationRule.contains_any) {
          return formatRawValue(validationRule.contains_any);
        }
        break;
      case 'contains_all':
        // Show the array of required values
        if (validationRule.contains_all) {
          return formatRawValue(validationRule.contains_all);
        }
        break;
    }
  }

  // Standard format: direct value (string, array, number, etc.)
  return formatRawValue(fieldValue);
}

export function formatConstraint(field: DicomField): string {
  return formatValidationRule(field.validationRule);
}

export function formatDataType(dataType: string): string {
  switch (dataType) {
    case 'string':
      return 'String';
    case 'number':
      return 'Number';
    case 'list_string':
      return 'List (string)';
    case 'list_number':
      return 'List (number)';
    case 'json':
      return 'Raw JSON';
    default:
      return dataType;
  }
}

export function formatValidationRule(rule?: ValidationRule): string {
  if (!rule) {
    return 'exact';
  }

  switch (rule.type) {
    case 'exact':
      return 'exact';
    case 'tolerance':
      return `${rule.value || 0} ±${rule.tolerance || 0}`;
    case 'range':
      return formatRangeConstraint(rule.min, rule.max);
    case 'contains':
      return `contains "${rule.contains || ''}"`;
    case 'contains_any':
      return `contains any [${(rule.contains_any || []).slice(0, 3).join(', ')}${(rule.contains_any || []).length > 3 ? '...' : ''}]`;
    case 'contains_all':
      return `contains all [${(rule.contains_all || []).slice(0, 3).join(', ')}${(rule.contains_all || []).length > 3 ? '...' : ''}]`;
    default:
      return rule.type;
  }
}

/**
 * Format a range constraint using mathematical notation.
 * - min only: "≥ min"
 * - max only: "≤ max"
 * - both: "[min, max]"
 */
export function formatRangeConstraint(min?: number, max?: number): string {
  if (min !== undefined && min !== null && max !== undefined && max !== null) {
    return `[${min}, ${max}]`;
  } else if (min !== undefined && min !== null) {
    return `≥ ${min}`;
  } else if (max !== undefined && max !== null) {
    return `≤ ${max}`;
  }
  return 'range (not set)';
}

export function formatFieldTypeInfo(dataType: string, validationRule?: ValidationRule): string {
  const formattedType = formatDataType(dataType);
  // Show only constraint type name (values shown in the value display)
  const constraintType = validationRule?.type || 'exact';
  const formattedConstraint = constraintType.replace(/_/g, ' ');
  return `${formattedType} • ${formattedConstraint}`;
}

// Format the display value based on the validation rule
export function formatConstraintValue(value: any, validationRule?: ValidationRule): string {
  if (!validationRule || validationRule.type === 'exact') {
    return formatRawValue(value);
  }

  // For non-exact constraints, show the constraint format
  return formatValidationRule(validationRule);
}

function formatRawValue(value: any): string {
  if (value === null || value === undefined) {
    return '-';
  }

  if (Array.isArray(value)) {
    // Display as array-like format for better readability
    return `[${value.join(', ')}]`;
  }

  if (typeof value === 'object') {
    return JSON.stringify(value, null, 2);
  }

  return String(value);
}