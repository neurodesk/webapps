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
  // The schema stores the DICOM keyword ("EchoTime"); `name` can be the
  // human-readable description ("Echo Time") for fields added via search.
  const schemaField: SchemaFieldOutput = {
    field: field.keyword || field.name || field.tag || ''
  };

  // Fields without a DICOM tag record their type in `tag` ('derived', 'private',
  // 'custom') so it survives a reload (see processSchemaFieldForUI).
  schemaField.tag = field.tag || field.fieldType || 'derived';

  // Scalar numeric fields are the graded editor's domain: its constraint (value /
  // min / max / tolerance / error edges / reference / severity) is authoritative.
  if (field.graded) {
    Object.assign(schemaField, toSchemaField(field.graded));
  } else {
    const r = field.validationRule;
    let value = field.value;
    let constrained = false; // a non-value constraint stands in for `value`
    if (r?.type === 'tolerance' && r.tolerance !== undefined && r.tolerance !== null) {
      if (r.value !== undefined && r.value !== null) value = r.value;
      schemaField.tolerance = r.tolerance;
      if (r.errorTolerance !== undefined) schemaField.errorTolerance = r.errorTolerance; // list_number warn band
    } else if (r?.type === 'range') {
      // min/max are the constraint; an observed value alongside them is not
      if (r.min !== undefined) schemaField.min = r.min;
      if (r.max !== undefined) schemaField.max = r.max;
      constrained = true;
    } else if (r?.type === 'contains' && r.contains !== undefined) {
      schemaField.contains = r.contains;
      constrained = true;
    } else if (r?.type === 'contains_any' && r.contains_any) {
      schemaField.contains_any = r.contains_any;
      constrained = true;
    } else if (r?.type === 'contains_all' && r.contains_all) {
      schemaField.contains_all = r.contains_all;
      constrained = true;
    }
    // '' is kept: an empty value is a real constraint (e.g. no ContrastBolusAgent).
    if (!constrained && value !== undefined && value !== null) {
      schemaField.value = value;
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
 * Convert a series-level SeriesField to schema field format.
 *
 * Same as fieldToSchemaField except notes are dropped — a series records its
 * rationale once, on the series, not per field.
 */
export function seriesFieldToSchemaField(field: SeriesField): SchemaFieldOutput {
  return fieldToSchemaField(field, { includeNotes: false });
}
