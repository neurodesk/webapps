// Service for managing DICOM field data and external field list fetching
// This maintains the clean separation between mock data and UI components

import { FieldDataType } from '../types';
import { getDataTypeFromVR, getSuggestedConstraintForVR, getSuggestedToleranceValue } from '../utils/vrMapping';
import { roundDicomValue } from '../utils/valueRounding';
import fieldRegistry from '../data/fieldRegistry.json';

export interface DicomFieldDefinition {
  tag: string;
  name: string;
  keyword?: string;
  valueRepresentation?: string;
  valueMultiplicity?: string;
  retired?: string;
  id?: string;
  // Legacy compatibility
  vr: string;
  description?: string;
  // Metadata sourced from the dicompare field registry (src/data/fieldRegistry.json,
  // generated from dicompare-pip/dicompare/fields.py — the single source of truth).
  // Present on standard fields the registry enriches and on derived fields it defines.
  valueType?: FieldDataType;           // registry canonical type (number/string/list_*)
  vocabulary?: (string | number)[];    // fixed set of allowed values (enum), if any
  unit?: string;                       // canonical unit, e.g. "ms", "mm"
  continuous?: boolean;                // exact matches are brittle for this field
  suggestedTolerance?: number;         // default tolerance for continuous fields
  // 'derived' marks a computed field with no official DICOM tag (e.g. CoilCombinationMethod).
  fieldType?: 'standard' | 'derived';
}

// The dicompare field registry, keyed by DICOM keyword. Generated from the Python
// package via `npm run sync:registry`; do not hand-edit fieldRegistry.json.
interface RegistryEntry {
  valueType: FieldDataType;
  tag?: string;                        // "GGGG,EEEE"; absent for derived fields
  vr?: string;
  unit?: string;
  vocabulary?: (string | number)[];
  continuous?: boolean;
  suggestedTolerance?: number;
}
const REGISTRY = fieldRegistry as Record<string, RegistryEntry>;

// Build a suggestion entry for a registry-only (derived) field that has no
// official DICOM tag, so it can appear in the "Add DICOM fields…" autocomplete.
const buildDerivedFieldDefinition = (keyword: string, entry: RegistryEntry): DicomFieldDefinition => {
  const bits: string[] = ['Derived field'];
  if (entry.unit) bits.push(entry.unit);
  if (entry.vocabulary) bits.push(`one of: ${entry.vocabulary.join(', ')}`);
  return {
    tag: '',                           // derived fields are identified by keyword
    name: keyword,
    keyword,
    valueRepresentation: entry.vr,
    vr: entry.vr || 'UN',
    valueType: entry.valueType,
    vocabulary: entry.vocabulary,
    unit: entry.unit,
    continuous: entry.continuous,
    suggestedTolerance: entry.suggestedTolerance,
    fieldType: 'derived',
    description: bits.join(' • '),
  };
};

// Fold the dicompare registry into a fetched field list: enrich matching standard
// fields with registry metadata (type, unit, vocabulary) and append derived fields
// so both official and derived fields are suggested from one source of truth.
const mergeRegistryFields = (base: DicomFieldDefinition[]): DicomFieldDefinition[] => {
  const byKeyword = new Map<string, DicomFieldDefinition>();
  for (const f of base) {
    if (f.keyword) byKeyword.set(f.keyword, f);
  }

  const derived: DicomFieldDefinition[] = [];
  for (const [keyword, entry] of Object.entries(REGISTRY)) {
    const existing = byKeyword.get(keyword);
    if (existing) {
      existing.valueType = entry.valueType;
      if (entry.vocabulary) existing.vocabulary = entry.vocabulary;
      if (entry.unit) existing.unit = entry.unit;
      if (entry.continuous) existing.continuous = entry.continuous;
      if (entry.suggestedTolerance !== undefined) existing.suggestedTolerance = entry.suggestedTolerance;
      existing.fieldType = entry.tag ? 'standard' : 'derived';
    } else if (!entry.tag) {
      // Derived field with no official tag and no equivalent in the standard list.
      derived.push(buildDerivedFieldDefinition(keyword, entry));
    }
  }

  return [...base, ...derived];
};

// Cache for field list to avoid repeated fetches
let cachedFieldList: DicomFieldDefinition[] | null = null;
let fetchPromise: Promise<DicomFieldDefinition[]> | null = null;

// Load the DICOM attribute dictionary. It is bundled (src/data/dicomAttributes.json,
// regenerated with `npm run sync:dicom-attributes`) and imported lazily so the
// ~0.75 MB list loads only when field search is first used, with no network.
export const fetchDicomFieldList = async (): Promise<DicomFieldDefinition[]> => {
  if (cachedFieldList) {
    return cachedFieldList;
  }
  if (!fetchPromise) {
    fetchPromise = import('../data/dicomAttributes.json').then(({ default: attributes }) => {
      const fieldList: DicomFieldDefinition[] = attributes.map(field => ({
        ...field,
        retired: 'N',
        // Legacy compatibility
        vr: field.valueRepresentation,
        description: `${field.name} (${field.valueRepresentation}, ${field.valueMultiplicity})`
      }));
      // Enriched with the dicompare registry (adds derived fields)
      cachedFieldList = mergeRegistryFields(fieldList);
      return cachedFieldList;
    }).finally(() => {
      fetchPromise = null;
    });
  }
  return fetchPromise;
};

// Search/filter functions for field selection UI with efficient searching
export const searchDicomFields = async (query: string, limit: number = 50): Promise<DicomFieldDefinition[]> => {
  const fieldList = await fetchDicomFieldList();

  if (!query.trim()) {
    return fieldList.slice(0, limit);
  }

  const lowercaseQuery = query.toLowerCase();
  const results: DicomFieldDefinition[] = [];
  const exactMatches: DicomFieldDefinition[] = [];
  const startsWithMatches: DicomFieldDefinition[] = [];
  const containsMatches: DicomFieldDefinition[] = [];

  // Prioritize search results: exact matches, starts with, then contains
  for (const field of fieldList) {
    const name = field.name.toLowerCase();
    const tag = field.tag.toLowerCase();
    const keyword = (field.keyword || '').toLowerCase();

    // Exact matches (highest priority)
    if (name === lowercaseQuery || tag === lowercaseQuery || keyword === lowercaseQuery) {
      exactMatches.push(field);
    }
    // Starts with matches (medium priority)
    else if (name.startsWith(lowercaseQuery) || keyword.startsWith(lowercaseQuery) || tag.startsWith(lowercaseQuery)) {
      startsWithMatches.push(field);
    }
    // Contains matches (lowest priority)
    else if (
      name.includes(lowercaseQuery) ||
      tag.includes(lowercaseQuery) ||
      keyword.includes(lowercaseQuery) ||
      field.description?.toLowerCase().includes(lowercaseQuery)
    ) {
      containsMatches.push(field);
    }

    // Early exit if we have enough results
    if (exactMatches.length + startsWithMatches.length + containsMatches.length >= limit * 2) {
      break;
    }
  }

  // Combine results in priority order
  const combinedResults = [...exactMatches, ...startsWithMatches, ...containsMatches];
  return combinedResults.slice(0, limit);
};

// Get field definition by keyword
export const getFieldByKeyword = async (keyword: string): Promise<DicomFieldDefinition | undefined> => {
  const fieldList = await fetchDicomFieldList();
  return fieldList.find(field => field.keyword === keyword);
};

// Validate field tag format
export const isValidDicomTag = (tag: string): boolean => {
  const tagPattern = /^[0-9A-Fa-f]{4},[0-9A-Fa-f]{4}$/;
  return tagPattern.test(tag);
};

// Suggest data type based on DICOM VR (Value Representation) using enhanced mapping
export const suggestDataType = (vr: string, valueMultiplicity?: string, value?: any): FieldDataType => {
  return getDataTypeFromVR(vr, valueMultiplicity, value);
};

// Suggest validation constraint based on field characteristics using enhanced VR mapping
export const suggestValidationConstraint = (field: DicomFieldDefinition, value?: any, source?: 'dicom' | 'pro'): 'exact' | 'tolerance' | 'contains' | 'range' | 'contains_any' | 'contains_all' => {
  return getSuggestedConstraintForVR(field.vr, field.name, field.tag, source);
};
