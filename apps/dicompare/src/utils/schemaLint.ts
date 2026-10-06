import { ValidationRule } from '../types';
import fieldRegistry from '../data/fieldRegistry.json';

/**
 * Lightweight, high-signal "linting" for schema field constraints, surfaced in
 * the schema builder to catch constraints that look fine but will not match real
 * DICOM data (e.g. an exact match on a floating-point field, or a console
 * display string like "A >> P" where DICOM stores "COL").
 *
 * Field vocabularies and continuous-field classification come from the
 * canonical field registry in dicompare-pip (dicompare/fields.py) — the same
 * source of truth the protocol importers use. Regenerate with:
 *   python -m dicompare.fields > src/data/fieldRegistry.json
 */
export interface FieldLintWarning {
  code: 'exact-float' | 'enum-mismatch' | 'display-string';
  message: string;
}

/** Field to lint — a subset of DicomField that is available while editing. */
export interface LintableField {
  keyword?: string;
  name?: string;
  value?: any;
  validationRule?: ValidationRule;
}

interface RegistryEntry {
  valueType: string;
  tag?: string;
  vr?: string;
  unit?: string;
  vocabulary?: (string | number)[];
  continuous?: boolean;
  suggestedTolerance?: number;
}

const REGISTRY: Record<string, RegistryEntry> = fieldRegistry;

// Continuous physical parameters where an exact match is brittle even when the
// authored value happens to be an integer (e.g. EchoTime 66).
const CONTINUOUS_FIELDS = new Set<string>(
  Object.entries(REGISTRY)
    .filter(([, entry]) => entry.continuous)
    .map(([keyword]) => keyword)
);

// Enumerated fields with their canonical vocabularies. A value outside the
// set will never match real data.
const ENUMERATED_CS_FIELDS: Record<string, string[]> = Object.fromEntries(
  Object.entries(REGISTRY)
    .filter(([, entry]) => entry.vocabulary !== undefined)
    .map(([keyword, entry]) => [keyword, entry.vocabulary!.map(v => String(v))])
);

const DISPLAY_STRING_PATTERN = /(>>|<<|→|←|->|<-)/;

/**
 * The canonical set of allowed values (enum vocabulary) for a field, or undefined
 * if the field is not enumerated. Sourced from the dicompare registry, so it stays
 * in sync with the Python single source of truth. Used to drive dropdown value entry.
 */
export function getFieldVocabulary(keyword?: string, name?: string): string[] | undefined {
  return ENUMERATED_CS_FIELDS[keyword || name || ''];
}

function fieldKey(field: LintableField): string {
  return field.keyword || field.name || '';
}

function toArray(value: any): any[] {
  return Array.isArray(value) ? value : [value];
}

/**
 * Compute lint warnings for a single field constraint. Returns an empty array
 * when nothing looks wrong.
 */
export function lintField(field: LintableField): FieldLintWarning[] {
  const warnings: FieldLintWarning[] = [];
  const rule: ValidationRule = field.validationRule ?? { type: 'exact' };
  const key = fieldKey(field);

  // The value the constraint compares against (exact/tolerance store it on the
  // rule; otherwise fall back to the field value).
  const constraintValue = rule.value ?? field.value;

  // A) Exact match on a continuous / floating-point numeric field.
  if (rule.type === 'exact') {
    const nums = toArray(constraintValue);
    const allNumeric = nums.length > 0 && nums.every(v => typeof v === 'number' && !isNaN(v));
    const hasFloat = nums.some(v => typeof v === 'number' && !Number.isInteger(v));
    if (allNumeric && (hasFloat || CONTINUOUS_FIELDS.has(key))) {
      warnings.push({
        code: 'exact-float',
        message: `Exact match on ${key || 'this numeric field'} is brittle — real scans vary slightly. Consider a ± tolerance.`,
      });
    }
  }

  // B) Value outside a known enumerated set (only meaningful for exact match).
  // Numeric values count as offenders too: on an enumerated string field they
  // are usually a raw vendor code (e.g. ucCoilCombineMode 2) leaking through.
  const enumSet = ENUMERATED_CS_FIELDS[key];
  if (enumSet && rule.type === 'exact') {
    const strVals = toArray(constraintValue)
      .filter(v => (typeof v === 'string' && v.trim() !== '') || typeof v === 'number');
    const offender = strVals.find(
      v => !enumSet.some(allowed => allowed.toLowerCase() === String(v).trim().toLowerCase())
    );
    if (offender !== undefined) {
      warnings.push({
        code: 'enum-mismatch',
        message: `"${offender}" is not a valid ${key} value (DICOM uses ${enumSet.join(', ')}), so this will never match real data.`,
      });
    }
  }

  // C) Looks like a scanner-console display value (e.g. "A >> P").
  const looksLikeDisplay = toArray(constraintValue)
    .some(v => typeof v === 'string' && DISPLAY_STRING_PATTERN.test(v));
  if (looksLikeDisplay) {
    warnings.push({
      code: 'display-string',
      message: 'This looks like a scanner-console display value, which usually differs from the stored DICOM value and may not match.',
    });
  }

  return warnings;
}
