/**
 * Build a dicompare schema from workspace acquisitions.
 *
 * This replaces the Python build_schema_from_ui_acquisitions call for save,
 * preview and download. Fields go through fieldToSchemaField /
 * seriesFieldToSchemaField, the same converters the validation path uses, so
 * graded constraints and custom messages are written out the same way they are
 * validated.
 */

import type { Acquisition, SeriesField, SelectedValidationFunction } from '../types';
import { fieldToSchemaField, seriesFieldToSchemaField, SchemaFieldOutput } from './schemaFieldConverters';

export interface SchemaBuildMetadata {
  name?: string;
  description?: string;
  version?: string;
  authors?: string[];
}

// Keys that make a series field a constraint rather than an empty placeholder.
const CONSTRAINT_KEYS: (keyof SchemaFieldOutput)[] = [
  'value', 'tolerance', 'min', 'max', 'errorMin', 'errorMax',
  'contains', 'contains_any', 'contains_all',
];

const hasConstraint = (f: SchemaFieldOutput) => CONSTRAINT_KEYS.some(k => f[k] !== undefined);

const trimmed = (s: unknown): string | undefined =>
  typeof s === 'string' && s.trim() ? s.trim() : undefined;

// Older acquisitions can wrap a field's value as { value, validationRule, dataType }.
function unwrapValue<T extends { value: any; validationRule?: any }>(field: T): T {
  const v = field.value;
  if (v && typeof v === 'object' && !Array.isArray(v) && ('validationRule' in v || 'dataType' in v)) {
    return { ...field, value: v.value, validationRule: v.validationRule ?? field.validationRule };
  }
  return field;
}

// Older acquisitions can store series fields as { [name]: value | { value, validationRule } }.
function seriesFieldList(fields: unknown): SeriesField[] {
  if (Array.isArray(fields)) return fields;
  if (fields && typeof fields === 'object') {
    return Object.entries(fields).map(([k, v]: [string, any]) => ({
      name: k,
      tag: k,
      value: v && typeof v === 'object' ? v.value : v,
      validationRule: (v && typeof v === 'object' && v.validationRule) || { type: 'exact' },
    }));
  }
  return [];
}

function ruleToSchema(func: SelectedValidationFunction, acqName: string, idx: number) {
  const f = func as SelectedValidationFunction & { parameters?: unknown };
  const rule: Record<string, unknown> = {
    id: f.id ?? `rule_${acqName.toLowerCase().replace(/ /g, '_')}_${idx}`,
    name: f.customName ?? f.name ?? '',
    description: f.customDescription ?? f.description ?? '',
    implementation: f.customImplementation ?? f.implementation ?? '',
    // Configured values drive execution; typed declarations are kept so a
    // reloaded schema can still render parameter inputs when editing the rule.
    parameters: f.configuredParams || {},
    parameterDefinitions: Array.isArray(f.parameterDefinitions)
      ? f.parameterDefinitions
      // Legacy UI shape kept declarations in `parameters`
      : (Array.isArray(f.parameters) ? f.parameters : []),
    fields: f.customFields ?? f.fields ?? [],
    optional_fields: f.optional_fields || [],
    testCases: f.customTestCases ?? f.testCases ?? [],
  };
  // System fields (e.g. Count) the rule editor feeds into test cases.
  if (f.enabledSystemFields?.length) rule.enabledSystemFields = f.enabledSystemFields;
  return rule;
}

export function buildSchemaFromAcquisitions(
  acquisitions: Acquisition[],
  metadata: SchemaBuildMetadata
): Record<string, unknown> {
  const schemaAcquisitions = new Map<string, unknown>();

  for (const acquisition of acquisitions) {
    const acqName = acquisition.protocolName ?? acquisition.id ?? 'Unknown';

    const fields = (acquisition.acquisitionFields || []).map(f => fieldToSchemaField(unwrapValue(f)));

    const series: Record<string, unknown>[] = [];
    for (const s of acquisition.series || []) {
      const seriesFields = seriesFieldList(s.fields)
        .map(f => seriesFieldToSchemaField(unwrapValue(f)))
        .filter(hasConstraint);
      if (!seriesFields.length) continue;

      const entry: Record<string, unknown> = {
        name: s.name ?? `Series ${series.length + 1}`,
        fields: seriesFields,
      };
      const notes = trimmed(s.notes);
      if (notes) entry.notes = notes;
      if (s.images?.length) entry.images = s.images;
      series.push(entry);
    }

    const acqEntry: Record<string, unknown> = {
      description: acquisition.seriesDescription ?? '',
      detailed_description: acquisition.detailedDescription ?? '',
      fields,
      series,
    };
    if (acquisition.tags?.length) acqEntry.tags = acquisition.tags;
    if (acquisition.images?.length) acqEntry.images = acquisition.images;
    if (acquisition.validationFunctions?.length) {
      acqEntry.rules = acquisition.validationFunctions.map((func, idx) => ruleToSchema(func, acqName, idx));
    }

    schemaAcquisitions.set(acqName, acqEntry);
  }

  return {
    name: metadata.name ?? 'Generated Schema',
    description: metadata.description ?? '',
    version: metadata.version ?? '1.0',
    authors: metadata.authors ?? [],
    acquisitions: Object.fromEntries(schemaAcquisitions),
  };
}
