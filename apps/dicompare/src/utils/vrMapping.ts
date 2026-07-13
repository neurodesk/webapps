import { FieldDataType } from '../types';

// Comprehensive VR (Value Representation) to JSON-serializable data type mapping
// Based on DICOM standard and dicom-parser documentation
export const VR_TO_DATATYPE_MAP: Record<string, FieldDataType> = {
  // String types
  'AE': 'string',        // Application Entity
  'AS': 'string',        // Age String
  'CS': 'string',        // Code String (often single values, sometimes multiple)
  'DA': 'string',        // Date
  'DT': 'string',        // Date Time
  'LO': 'string',        // Long String
  'LT': 'string',        // Long Text
  'PN': 'string',        // Person Name (could be object but string for simplicity)
  'SH': 'string',        // Short String
  'ST': 'string',        // Short Text
  'TM': 'string',        // Time
  'UC': 'string',        // Unlimited Characters
  'UI': 'string',        // Unique Identifier (UID)
  'UR': 'string',        // URI/URL
  'UT': 'string',        // Unlimited Text

  // Numeric types
  'DS': 'number',        // Decimal String (numeric data stored as string)
  'IS': 'number',        // Integer String (integer data stored as string)
  'FL': 'number',        // Floating Point Single
  'FD': 'number',        // Floating Point Double
  'SL': 'number',        // Signed Long
  'SS': 'number',        // Signed Short
  'SV': 'number',        // Signed 64-bit Very Long
  'UL': 'number',        // Unsigned Long
  'US': 'number',        // Unsigned Short
  'UV': 'number',        // Unsigned 64-bit Very Long

  // Binary/Complex types (JSON for complex structures)
  'AT': 'string',        // Attribute Tag (could be string representation)
  'OB': 'string',        // Other Byte (binary data as string/base64)
  'OD': 'string',        // Other Double (binary data as string)
  'OF': 'string',        // Other Float (binary data as string)
  'OL': 'string',        // Other Long (binary data as string)
  'OV': 'string',        // Other 64-bit Very Long (binary data as string)
  'OW': 'string',        // Other Word (binary data as string)
  'SQ': 'json',          // Sequence of Items (complex nested structure)
  'UN': 'string',        // Unknown (default to string)
};

// Special cases where the data type can vary based on value multiplicity
export const VR_MULTIPLICITY_CONSIDERATIONS: Record<string, {
  single: FieldDataType;
  multiple: FieldDataType;
}> = {
  'DS': { single: 'number', multiple: 'list_number' },        // Decimal String
  'IS': { single: 'number', multiple: 'list_number' },        // Integer String
  'CS': { single: 'string', multiple: 'list_string' },        // Code String
  'UI': { single: 'string', multiple: 'list_string' },        // UID (rare but possible)
  'FL': { single: 'number', multiple: 'list_number' },        // Float
  'FD': { single: 'number', multiple: 'list_number' },        // Double
  'UL': { single: 'number', multiple: 'list_number' },        // Unsigned Long
  'US': { single: 'number', multiple: 'list_number' },        // Unsigned Short
  'SL': { single: 'number', multiple: 'list_number' },        // Signed Long
  'SS': { single: 'number', multiple: 'list_number' },        // Signed Short
};

/**
 * Determine the most appropriate data type for a DICOM field based on its VR and value multiplicity
 */
export function getDataTypeFromVR(
  vr: string,
  valueMultiplicity?: string,
  actualValue?: any
): FieldDataType {
  console.log('🧮 getDataTypeFromVR called with:', { vr, valueMultiplicity, actualValue });

  // If we have an actual value, prioritize that for type detection
  if (actualValue !== undefined && actualValue !== null) {
    console.log('📄 Using actual value for type detection');
    if (Array.isArray(actualValue)) {
      // Determine array element type
      if (actualValue.length > 0) {
        const firstElement = actualValue[0];
        if (typeof firstElement === 'number' || !isNaN(Number(firstElement))) {
          console.log('➡️ Returning list_number from actual array value');
          return 'list_number';
        }
        console.log('➡️ Returning list_string from actual array value');
        return 'list_string';
      }
      // Empty array - fall back to VR-based decision
      console.log('📭 Empty array, falling back to VR-based decision');
    } else if (typeof actualValue === 'object') {
      console.log('➡️ Returning json from actual object value');
      return 'json';
    } else if (typeof actualValue === 'number' || !isNaN(Number(actualValue))) {
      console.log('➡️ Returning number from actual numeric value');
      return 'number';
    } else if (typeof actualValue === 'string') {
      console.log('➡️ Returning string from actual string value');
      return 'string';
    }
  }

  // Check for multiplicity-based type variations
  if (valueMultiplicity && VR_MULTIPLICITY_CONSIDERATIONS[vr]) {
    console.log('🔢 Checking multiplicity-based variations for VR:', vr);
    const consideration = VR_MULTIPLICITY_CONSIDERATIONS[vr];
    console.log('⚖️ Consideration found:', consideration);

    // Parse multiplicity (e.g., "1", "1-n", "2-n", "1-3")
    if (valueMultiplicity.includes('-n') || valueMultiplicity.includes('-')) {
      const parts = valueMultiplicity.split('-');
      const minValue = parseInt(parts[0]);
      const maxValue = parts[1] === 'n' ? Infinity : parseInt(parts[1]);
      console.log('📊 Parsed multiplicity:', { minValue, maxValue, from: valueMultiplicity });

      // If maximum is greater than 1, could be multiple values
      if (maxValue > 1) {
        console.log('➡️ Returning multiple type:', consideration.multiple);
        return consideration.multiple;
      }
    } else {
      // Single value specified (e.g., "1")
      const count = parseInt(valueMultiplicity);
      console.log('📊 Single value count:', count);
      if (count > 1) {
        console.log('➡️ Returning multiple type:', consideration.multiple);
        return consideration.multiple;
      }
    }

    console.log('➡️ Returning single type:', consideration.single);
    return consideration.single;
  }

  // Default VR-based mapping
  const defaultType = VR_TO_DATATYPE_MAP[vr] || 'string';
  console.log('🎯 Using default VR mapping:', vr, '→', defaultType);
  return defaultType;
}

/**
 * Get a human-readable description of what type of data this VR typically contains
 */
export function getVRDescription(vr: string): string {
  const descriptions: Record<string, string> = {
    'AE': 'Application Entity title',
    'AS': 'Age in years (e.g., "025Y")',
    'AT': 'Attribute tag reference',
    'CS': 'Code string (short identifier)',
    'DA': 'Date (YYYYMMDD)',
    'DS': 'Decimal number as string',
    'DT': 'Date and time',
    'FL': 'Single-precision floating point',
    'FD': 'Double-precision floating point',
    'IS': 'Integer as string',
    'LO': 'Long string (up to 64 chars)',
    'LT': 'Long text (up to 10240 chars)',
    'OB': 'Binary data (bytes)',
    'OD': 'Double-precision binary data',
    'OF': 'Single-precision binary data',
    'OL': 'Long binary data',
    'OV': '64-bit binary data',
    'OW': 'Word binary data',
    'PN': 'Person name',
    'SH': 'Short string (up to 16 chars)',
    'SL': 'Signed long integer',
    'SQ': 'Sequence of items (nested data)',
    'SS': 'Signed short integer',
    'ST': 'Short text (up to 1024 chars)',
    'SV': 'Signed 64-bit integer',
    'TM': 'Time (HHMMSS)',
    'UC': 'Unlimited characters',
    'UI': 'Unique identifier',
    'UL': 'Unsigned long integer',
    'UN': 'Unknown format',
    'UR': 'URI or URL',
    'US': 'Unsigned short integer',
    'UT': 'Unlimited text',
    'UV': 'Unsigned 64-bit integer',
  };

  return descriptions[vr] || `Unknown VR type: ${vr}`;
}

/**
 * Determine if a VR typically contains numeric data
 */
export function isNumericVR(vr: string): boolean {
  const numericVRs = ['DS', 'IS', 'FL', 'FD', 'SL', 'SS', 'SV', 'UL', 'US', 'UV'];
  return numericVRs.includes(vr);
}

/**
 * Determine if a VR can contain multiple values
 */
export function canHaveMultipleValues(vr: string, valueMultiplicity?: string): boolean {
  if (valueMultiplicity) {
    // Check if multiplicity allows multiple values
    if (valueMultiplicity.includes('-n') || valueMultiplicity.includes('-')) {
      const parts = valueMultiplicity.split('-');
      const maxValue = parts[1] === 'n' ? Infinity : parseInt(parts[1]);
      return maxValue > 1;
    } else {
      const count = parseInt(valueMultiplicity);
      return count > 1;
    }
  }

  // Some VRs commonly have multiple values
  const multiValueVRs = ['CS', 'DS', 'IS', 'UI'];
  return multiValueVRs.includes(vr);
}

/**
 * Get suggested validation constraint based on VR characteristics and field name
 */
export function getSuggestedConstraintForVR(vr: string, fieldName?: string, tag?: string, source?: 'dicom' | 'pro'): 'exact' | 'tolerance' | 'contains' | 'range' | 'contains_any' | 'contains_all' {
  // Special case for MagneticFieldStrength - use tolerance instead of exact
  if (fieldName === 'Magnetic Field Strength' || tag === '0018,0087') {
    return 'tolerance';
  }

  // Special case for ImagingFrequency - use tolerance instead of exact
  if (fieldName === 'Imaging Frequency' || tag === '0018,0084') {
    return 'tolerance';
  }

  // Special case for PixelBandwidth - use tolerance instead of exact
  if (fieldName === 'Pixel Bandwidth' || tag === '0018,0095') {
    return 'tolerance';
  }

  // Special case for ScanOptions when source is .pro file - use contains_any instead of exact
  // .pro files show available options, but actual acquisition may only use some of them
  if ((fieldName === 'Scan Options' || tag === '0018,0022') && source === 'pro') {
    return 'contains_any';
  }

  // Default to exact match for all other fields
  return 'exact';
}

/**
 * Get suggested tolerance value for fields that use tolerance validation
 */
export function getSuggestedToleranceValue(fieldName?: string, tag?: string): number | undefined {
  // Special case for MagneticFieldStrength - tolerance of 0.3
  if (fieldName === 'Magnetic Field Strength' || tag === '0018,0087') {
    return 0.3;
  }

  // Special case for ImagingFrequency - tolerance of 1
  if (fieldName === 'Imaging Frequency' || tag === '0018,0084') {
    return 1;
  }

  // Special case for PixelBandwidth - tolerance of 1
  if (fieldName === 'Pixel Bandwidth' || tag === '0018,0095') {
    return 1;
  }

  return undefined;
}