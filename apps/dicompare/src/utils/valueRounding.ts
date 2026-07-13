/**
 * Utility functions for rounding DICOM field values to reasonable precision
 */

/**
 * Round a numeric value to at most 5 decimal places
 */
export function roundToPrecision(value: number, maxDecimals: number = 5): number {
  if (!isFinite(value)) return value;

  // Use parseFloat to remove trailing zeros after rounding
  const factor = Math.pow(10, maxDecimals);
  return parseFloat((Math.round(value * factor) / factor).toFixed(maxDecimals));
}

/**
 * Round DICOM field values to appropriate precision
 * Handles single numbers, arrays of numbers, and mixed arrays
 */
export function roundDicomValue(value: any): any {
  if (value === null || value === undefined) {
    return value;
  }

  if (typeof value === 'number') {
    return roundToPrecision(value);
  }

  if (Array.isArray(value)) {
    return value.map(item => {
      if (typeof item === 'number') {
        return roundToPrecision(item);
      }
      return item;
    });
  }

  // For strings that might contain numbers, try to parse and round
  if (typeof value === 'string') {
    const num = parseFloat(value);
    // Only convert to number if the ENTIRE string is a valid number
    // This prevents "1H" from becoming 1, "3D" from becoming 3, etc.
    if (!isNaN(num) && isFinite(num) && value.trim() === num.toString()) {
      console.log('🔍 Converting string number:', { original: value, converted: roundToPrecision(num).toString() });
      return roundToPrecision(num).toString();
    }

    // Debug logging for strings that look like numbers but shouldn't be converted
    if (!isNaN(num) && isFinite(num) && value.trim() !== num.toString()) {
      console.log('🔍 NOT converting partial number string:', { original: value, parsedNumber: num });
    }
  }

  return value;
}

/**
 * Round all numeric values in a DICOM field object
 */
export function roundFieldValues(field: any): any {
  if (!field || typeof field !== 'object') {
    return field;
  }

  const rounded = { ...field };

  // Round the main value
  if ('value' in rounded) {
    rounded.value = roundDicomValue(rounded.value);
  }

  // Round values array if present
  if ('values' in rounded && Array.isArray(rounded.values)) {
    rounded.values = rounded.values.map(roundDicomValue);
  }

  return rounded;
}