import { useMemo } from 'react';
import { Acquisition, DicomField } from '../types';
import { normalizeTag } from '../utils/stringHelpers';

interface UseUncheckedFieldsOptions {
  isComplianceMode: boolean;
  realAcquisition?: Acquisition;
  schemaAcquisition?: Acquisition;
}

/**
 * Hook to calculate fields in realAcquisition that aren't checked by the schema.
 * These are fields present in the DICOM data but not defined in the schema.
 */
export function useUncheckedFields({
  isComplianceMode,
  realAcquisition,
  schemaAcquisition,
}: UseUncheckedFieldsOptions): DicomField[] {
  return useMemo((): DicomField[] => {
    if (!isComplianceMode) return [];
    if (!realAcquisition) return [];

    const realFields = realAcquisition.acquisitionFields || [];
    const schemaFields = schemaAcquisition?.acquisitionFields || [];

    // If no real fields, nothing to show
    if (realFields.length === 0) return [];

    // Get all field identifiers from the schema (normalized)
    const schemaFieldIds = new Set<string>();
    const schemaKeywords = new Set<string>();
    const schemaNames = new Set<string>();

    schemaFields.forEach(f => {
      const normalizedTag = normalizeTag(f.tag);
      if (normalizedTag) schemaFieldIds.add(normalizedTag);
      if (f.keyword) schemaKeywords.add(f.keyword.toLowerCase());
      if (f.name) schemaNames.add(f.name.toLowerCase());
    });

    // Also include series fields from schema
    (schemaAcquisition?.series || []).forEach(s => {
      const fields = Array.isArray(s.fields) ? s.fields : Object.values(s.fields || {});
      fields.forEach((f: any) => {
        const normalizedTag = normalizeTag(f.tag);
        if (normalizedTag) schemaFieldIds.add(normalizedTag);
        if (f.keyword) schemaKeywords.add(f.keyword.toLowerCase());
        if (f.name) schemaNames.add(f.name.toLowerCase());
      });
    });

    // If schema has no fields defined, all real fields are "unchecked"
    // but this is likely a loading state, so return empty
    if (schemaFieldIds.size === 0 && schemaKeywords.size === 0 && schemaNames.size === 0) {
      return [];
    }

    // Find fields in realAcquisition that aren't in the schema
    return realFields.filter(f => {
      const normalizedTag = normalizeTag(f.tag);
      const hasTag = normalizedTag && schemaFieldIds.has(normalizedTag);
      const hasKeyword = f.keyword && schemaKeywords.has(f.keyword.toLowerCase());
      const hasName = f.name && schemaNames.has(f.name.toLowerCase());
      return !hasTag && !hasKeyword && !hasName;
    });
  }, [isComplianceMode, realAcquisition, schemaAcquisition?.acquisitionFields, schemaAcquisition?.series]);
}
