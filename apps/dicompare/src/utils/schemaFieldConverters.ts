import type { DicomField, SeriesField } from '../types';
import { toSchemaField } from '../components/common/constraintModel';

/**
 * Schema field format used by the Python dicompare library.
 * This is the format expected when building schema JSON for validation.
 */
export interface SchemaFieldOutput {
  field: string;
  tag?: string;
  value?: any;
  min?: number;
  max?: number;
  tolerance?: number;
  errorMin?: number;
  errorMax?: number;
  errorTolerance?: number;
  reference?: number;
  contains?: string;
  contains_any?: any[];
  contains_all?: any[];
  severity?: 'error' | 'warning';
  notes?: string;
  warningMessage?: string;
  errorMessage?: string;
}

/**
 * Convert a DicomField or SeriesField to schema field format.
 *
 * Schema field format: { field: string, tag?: string, value?: any, tolerance?: number, ... }
 *
 * This unified function handles both acquisition-level (DicomField) and series-level (SeriesField)
 * fields since they share the same relevant properties for schema conversion.
 */
export function fieldToSchemaField(
  field: DicomField | SeriesField,
  options: { includeNotes?: boolean } = {}
): SchemaFieldOutput {
  const { includeNotes = true } = options;
  const schemaField: SchemaFieldOutput = {
    field: field.name || field.keyword || field.tag || ''
  };

  if (field.tag) {
    schemaField.tag = field.tag;
  }

  // Scalar numeric fields are the graded editor's domain: its constraint (value /
  // min / max / tolerance / error edges / reference / severity) is authoritative.
  if (field.graded) {
    Object.assign(schemaField, toSchemaField(field.graded));
  } else {
    if (field.value !== undefined && field.value !== null && field.value !== '') {
      schemaField.value = field.value;
    }
    if (field.validationRule) {
      const r = field.validationRule;
      if (r.type === 'tolerance' && r.tolerance !== undefined) {
        schemaField.tolerance = r.tolerance;
        if (r.errorTolerance !== undefined) schemaField.errorTolerance = r.errorTolerance; // list_number warn band
      }
      if (r.type === 'range') { // previously dropped — range constraints were silently lost
        if (r.min !== undefined) schemaField.min = r.min;
        if (r.max !== undefined) schemaField.max = r.max;
      }
      if (r.type === 'contains' && r.contains) schemaField.contains = r.contains;
      if (r.type === 'contains_any' && r.contains_any) schemaField.contains_any = r.contains_any;
      if (r.type === 'contains_all' && r.contains_all) schemaField.contains_all = r.contains_all;
    }
    // Only the non-default severity is serialized (omitted = 'error').
    if (field.severity === 'warning') {
      schemaField.severity = 'warning';
    }
  }

  // Custom compliance messages are orthogonal to how the constraint is stored
  // (graded or legacy) — they apply whenever the field warns / fails.
  if (field.warningMessage && field.warningMessage.trim()) {
    schemaField.warningMessage = field.warningMessage.trim();
  }
  if (field.errorMessage && field.errorMessage.trim()) {
    schemaField.errorMessage = field.errorMessage.trim();
  }

  // Series fields pass includeNotes: false. Dropping it here rather than
  // relying on SeriesField's type not declaring it, because a note can still
  // reach this at runtime from a hand-edited schema — and the metaschema
  // rejects the key on a series field, so writing it would emit invalid JSON.
  const notes = includeNotes && 'notes' in field ? field.notes : undefined;
  if (notes && notes.trim()) {
    schemaField.notes = notes.trim();
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
 *
 * Same as fieldToSchemaField except notes are dropped — a series records its
 * rationale once, on the series, not per field.
 */
export function seriesFieldToSchemaField(field: SeriesField): SchemaFieldOutput {
  return fieldToSchemaField(field, { includeNotes: false });
}
