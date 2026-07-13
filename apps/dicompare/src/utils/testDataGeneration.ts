import { Acquisition, DicomField, Series, SelectedValidationFunction } from '../types';
import { inferDataTypeFromValue } from './datatypeInference';
import { getFieldByKeyword } from '../services/dicomFieldService';
import { dicompareWorkerAPI as dicompareAPI } from '../services/DicompareWorkerAPI';
import JSZip from 'jszip';

export interface TestDataRow {
  [fieldName: string]: any;
}

export interface ValidationFieldValues {
  [fieldName: string]: any[];
}

export interface TestDataGenerationResult {
  testData: TestDataRow[];
  validationFieldValues: ValidationFieldValues;
  maxValidationRows: number;
  warnings: {
    conflicts: Array<{
      fieldName: string;
      existingValue: any;
      testValue: any;
      validationName: string;
    }>;
    noPassingTestWarnings: string[];
    fieldConflictWarnings: string[];
  };
}

/**
 * Extracts field values from validation function test cases
 * Returns validation field values, max rows needed, and any warnings
 */
export function extractValidationFieldValues(
  validationFunctions: SelectedValidationFunction[],
  allFields: DicomField[],
  series: Series[]
): {
  validationFieldValues: ValidationFieldValues;
  maxValidationRows: number;
  conflicts: Array<any>;
  noPassingTestWarnings: string[];
  fieldConflictWarnings: string[];
} {
  const validationFieldValues: ValidationFieldValues = {};
  let maxValidationRows = 0;
  const conflicts: Array<any> = [];
  const noPassingTestWarnings: string[] = [];
  const fieldConflictWarnings: string[] = [];
  const fieldToValidationFuncs: Record<string, Array<{ name: string; values: any[] }>> = {};

  let functionsWithTests = 0;
  let functionsWithoutTests = 0;

  validationFunctions.forEach(validationFunc => {
    const testCases = validationFunc.customTestCases || validationFunc.testCases || [];

    // Find passing test cases
    const passingTests = testCases.filter((testCase: any) => {
      return testCase.expectedResult === 'pass';
    });

    if (passingTests.length > 0) {
      functionsWithTests++;
      // Use the first passing test case
      const passingTest = passingTests[0];
      const fields = validationFunc.customFields || validationFunc.fields || [];
      const funcName = validationFunc.customName || validationFunc.name;

      // Extract field values from the passing test
      fields.forEach((fieldName: string) => {
        if (passingTest.data && passingTest.data[fieldName]) {
          const values = passingTest.data[fieldName];
          // Store the full array of values
          let testValues = Array.isArray(values) ? values : [values];

          // Check if this is grouped data with a Count column
          // If Count exists, expand values by repeating each value according to its count
          const countValues = passingTest.data['Count'];
          if (countValues && Array.isArray(countValues) && countValues.length === testValues.length) {
            // Expand values based on Count
            const expandedValues: any[] = [];
            for (let i = 0; i < testValues.length; i++) {
              const count = parseInt(countValues[i]) || 1;
              for (let j = 0; j < count; j++) {
                expandedValues.push(testValues[i]);
              }
            }
            testValues = expandedValues;
            console.log(`📊 Expanded ${fieldName} from ${values.length} grouped values to ${testValues.length} total values using Count column`);
          }

          // Track the maximum number of rows we need
          maxValidationRows = Math.max(maxValidationRows, testValues.length);

          // Check if this field already exists in acquisition/series fields
          const existingField = allFields.find(f => f.name === fieldName);
          if (existingField) {
            // Get the existing value(s)
            let existingValues: any[] = [];

            // If it's a series field, collect values from all series
            if (existingField.level === 'series') {
              series.forEach(s => {
                let seriesField = null;
                if (Array.isArray(s.fields)) {
                  seriesField = s.fields.find((f: any) => f.name === fieldName || f.tag === existingField.tag);
                } else if (s.fields && typeof s.fields === 'object') {
                  seriesField = (s.fields as any)[existingField.tag];
                }

                if (seriesField && seriesField.value !== undefined) {
                  let value = seriesField.value;
                  // Handle nested value structures
                  if (value && typeof value === 'object' && !Array.isArray(value)) {
                    if ((value as any).validationRule) {
                      const rule = (value as any).validationRule;
                      if (rule.type === 'exact' && rule.value !== undefined) {
                        value = rule.value;
                      } else if (rule.type === 'tolerance' && rule.value !== undefined) {
                        value = rule.value;
                      }
                    }
                  }
                  if (value !== undefined && value !== null && value !== '') {
                    existingValues.push(value);
                  }
                }
              });
            } else {
              // Acquisition field - single value
              let existingValue = existingField.value;
              // Handle nested value structures
              if (existingValue && typeof existingValue === 'object' && !Array.isArray(existingValue)) {
                if ((existingValue as any).validationRule) {
                  const rule = (existingValue as any).validationRule;
                  if (rule.type === 'exact' && rule.value !== undefined) {
                    existingValue = rule.value;
                  } else if (rule.type === 'tolerance' && rule.value !== undefined) {
                    existingValue = rule.value;
                  }
                }
              }
              if (existingValue !== undefined && existingValue !== null && existingValue !== '') {
                existingValues.push(existingValue);
              }
            }

            // Compare values for conflict detection
            if (existingValues.length > 0) {
              const firstTestValue = testValues[0];
              const firstExistingValue = existingValues[0];

              // Check if there's a conflict
              if (JSON.stringify(firstExistingValue) !== JSON.stringify(firstTestValue)) {
                conflicts.push({
                  fieldName,
                  existingValue: existingValues.length > 1 ? existingValues : firstExistingValue,
                  testValue: testValues.length > 1 ? testValues : firstTestValue,
                  validationName: funcName
                });
              }
            }
          }

          validationFieldValues[fieldName] = testValues;

          // Track which validation function is setting this field
          if (!fieldToValidationFuncs[fieldName]) {
            fieldToValidationFuncs[fieldName] = [];
          }
          fieldToValidationFuncs[fieldName].push({ name: funcName, values: testValues });
        }
      });
    } else {
      functionsWithoutTests++;
      const funcName = validationFunc.customName || validationFunc.name;
      noPassingTestWarnings.push(`"${funcName}" has no passing test cases`);
    }
  });

  // Check for fields set by multiple validation functions with conflicting values
  Object.entries(fieldToValidationFuncs).forEach(([fieldName, validationFuncs]) => {
    if (validationFuncs.length > 1) {
      // Multiple validation functions use this field - check if values differ
      const firstValues = JSON.stringify(validationFuncs[0].values);
      const hasConflict = validationFuncs.some(vf => JSON.stringify(vf.values) !== firstValues);

      if (hasConflict) {
        const funcNames = validationFuncs.map(vf => `"${vf.name}"`).join(', ');
        fieldConflictWarnings.push(
          `Multiple validation functions use field "${fieldName}" with different test values: ${funcNames}. ` +
          `The generated test data uses values from the last function and may not pass all validations.`
        );
      }
    }
  });

  return {
    validationFieldValues,
    maxValidationRows,
    conflicts,
    noPassingTestWarnings,
    fieldConflictWarnings
  };
}

/**
 * Generates a value for a field based on its constraints and validation rules
 */
export function generateValueFromField(field: DicomField): any {
  // Check if value is an object with validationRule (nested structure from loaded schemas)
  if (field.value && typeof field.value === 'object' && !Array.isArray(field.value)) {
    if ((field.value as any).validationRule) {
      const rule = (field.value as any).validationRule;
      const dataType = (field.value as any).dataType || 'string';

      // Generate value based on validation rule
      if (rule.type === 'exact' && rule.value !== undefined) {
        return rule.value;
      } else if (rule.type === 'tolerance' && rule.value !== undefined) {
        return rule.value; // Use the expected value
      } else if (rule.type === 'range') {
        if (rule.min !== undefined) return rule.min;
        if (rule.max !== undefined) return rule.max;
      } else if (rule.type === 'contains') {
        return rule.contains || 'test_value';
      } else if (rule.type === 'contains_any' && rule.contains_any) {
        // For contains_any: include at least one element from the list
        if (dataType === 'list_string' || dataType === 'list_number') {
          // Return the first element as a single-item list (satisfies "contains any")
          return [rule.contains_any[0]];
        }
        // For strings: use the first value as the string content
        return rule.contains_any[0] || 'test_value';
      } else if (rule.type === 'contains_all' && rule.contains_all) {
        // For contains_all: include all required elements
        if (dataType === 'list_string' || dataType === 'list_number') {
          // Return all required elements (satisfies "contains all")
          return [...rule.contains_all];
        }
        // For strings: join all values (less common use case)
        return rule.contains_all.join('_');
      }
    }
  }

  // Check if field has validationRule at field level
  if (field.validationRule) {
    const rule = field.validationRule;
    if (rule.type === 'exact' && field.value !== undefined) {
      return field.value;
    } else if (rule.type === 'tolerance' && rule.value !== undefined) {
      return rule.value;
    } else if (rule.type === 'range') {
      if (rule.min !== undefined) return rule.min;
      if (rule.max !== undefined) return rule.max;
    } else if (rule.type === 'contains') {
      return rule.contains || 'test_value';
    } else if (rule.type === 'contains_any' && rule.contains_any) {
      // For contains_any: include at least one element from the list
      const dataType = inferDataTypeFromValue(field.value);
      if (dataType === 'list_string' || dataType === 'list_number') {
        return [rule.contains_any[0]];
      }
      return rule.contains_any[0] || 'test_value';
    } else if (rule.type === 'contains_all' && rule.contains_all) {
      // For contains_all: include all required elements
      const dataType = inferDataTypeFromValue(field.value);
      if (dataType === 'list_string' || dataType === 'list_number') {
        return [...rule.contains_all];
      }
      return rule.contains_all.join('_');
    }
  }

  // Use the field's existing value if available
  if (field.value !== undefined && field.value !== null && field.value !== '') {
    return field.value;
  }

  // Generate reasonable defaults based on field type and name
  const dataType = inferDataTypeFromValue(field.value);
  switch (dataType) {
    case 'number':
      if (field.name.toLowerCase().includes('time')) return 2000;
      if (field.name.toLowerCase().includes('angle')) return 90;
      if (field.name.toLowerCase().includes('field')) return 3.0;
      return 1.0;

    case 'list_number':
      return [1.0, 1.0];

    case 'list_string':
      return ['value1', 'value2'];

    default:
      if (field.name === 'Modality') return 'MR';
      if (field.name === 'Manufacturer') return 'TEST_MANUFACTURER';
      if (field.name.toLowerCase().includes('name')) return 'TEST_VALUE';
      return 'test_value';
  }
}

/**
 * Generates test data rows from schema fields, series, and validation values
 */
export function generateTestDataFromSchema(
  fields: DicomField[],
  series: Series[],
  validationFieldValues: ValidationFieldValues = {},
  maxValidationRows: number = 0
): TestDataRow[] {
  // Determine how many rows we need to generate
  const numRows = Math.max(series.length, maxValidationRows, 1);

  // Generate rows
  const rows: TestDataRow[] = [];
  for (let rowIndex = 0; rowIndex < numRows; rowIndex++) {
    const row: TestDataRow = {};

    // First, add all validation field values (these take priority)
    Object.keys(validationFieldValues).forEach(fieldName => {
      const valuesArray = validationFieldValues[fieldName];
      // Cycle through validation values if we have more rows than values
      row[fieldName] = valuesArray[rowIndex % valuesArray.length];
    });

    // Then add fields from acquisition/series (won't override validation values)
    fields.forEach(field => {
      // Skip if already set by validation values
      if (row[field.name] !== undefined) {
        return;
      }

      // For series-based schemas, try to get value from the series
      if (series.length > 0 && rowIndex < series.length) {
        const s = series[rowIndex];

        if (field.level === 'series') {
          // Find this field in the current series
          let seriesField = null;

          // Handle both array format (from loaded schemas) and object format (from processed data)
          if (Array.isArray(s.fields)) {
            seriesField = s.fields.find((f: any) => f.tag === field.tag);
          } else if (s.fields && typeof s.fields === 'object') {
            seriesField = (s.fields as any)[field.tag];
          }

          if (seriesField) {
            // Debug: log what we found
            console.log('🔍 Series field found:', {
              fieldName: field.name,
              fieldTag: field.tag,
              seriesField: seriesField,
              value: seriesField.value,
              validationRule: seriesField.validationRule,
              hasContainsAny: !!seriesField.contains_any,
              hasContainsAll: !!seriesField.contains_all,
              ruleContainsAny: seriesField.validationRule?.contains_any,
              ruleContainsAll: seriesField.validationRule?.contains_all
            });

            // Extract the actual value from the series field
            // Check if value is meaningful (not undefined, null, or empty string)
            const hasValue = seriesField.value !== undefined &&
                            seriesField.value !== null &&
                            seriesField.value !== '' &&
                            !(Array.isArray(seriesField.value) && seriesField.value.length === 0);

            if (hasValue) {
              // Check if value has nested validation rule structure
              if (typeof seriesField.value === 'object' && !Array.isArray(seriesField.value) &&
                  (seriesField.value as any).validationRule) {
                row[field.name] = generateValueFromField({
                  ...field,
                  value: seriesField.value,
                  validationRule: seriesField.validationRule
                });
              } else {
                row[field.name] = seriesField.value;
              }
            } else if (seriesField.validationRule) {
              row[field.name] = generateValueFromField({
                ...field,
                validationRule: seriesField.validationRule
              });
            } else if (seriesField.contains_any) {
              // Handle top-level contains_any constraint (from JSON schema format)
              const dataType = inferDataTypeFromValue(field.value);
              if (dataType === 'list_string' || dataType === 'list_number') {
                row[field.name] = [seriesField.contains_any[0]];
              } else {
                row[field.name] = seriesField.contains_any[0] || 'test_value';
              }
            } else if (seriesField.contains_all) {
              // Handle top-level contains_all constraint (from JSON schema format)
              const dataType = inferDataTypeFromValue(field.value);
              if (dataType === 'list_string' || dataType === 'list_number') {
                row[field.name] = [...seriesField.contains_all];
              } else {
                row[field.name] = seriesField.contains_all.join('_');
              }
            } else if (seriesField.contains) {
              // Handle top-level contains constraint
              row[field.name] = seriesField.contains;
            } else if (seriesField.tolerance !== undefined) {
              // Handle top-level tolerance constraint (value with tolerance)
              row[field.name] = seriesField.value ?? 0;
            } else if (seriesField.min !== undefined || seriesField.max !== undefined) {
              // Handle top-level range constraint
              row[field.name] = seriesField.min ?? seriesField.max ?? 0;
            } else {
              row[field.name] = generateValueFromField(field);
            }
          } else {
            row[field.name] = generateValueFromField(field);
          }
        } else if (field.level === 'acquisition') {
          // Acquisition fields are the same for all rows
          // Use the field value if it's explicitly set, otherwise generate
          if (field.value !== undefined) {
            row[field.name] = field.value;
          } else {
            row[field.name] = generateValueFromField(field);
          }
        } else if (!row[field.name]) {
          row[field.name] = generateValueFromField(field);
        }
      } else {
        // No series or we're beyond the series count
        if (field.level === 'acquisition') {
          // Acquisition field
          if (field.value !== undefined) {
            row[field.name] = field.value;
          } else {
            row[field.name] = generateValueFromField(field);
          }
        } else {
          // Series field but no corresponding series - generate value
          row[field.name] = generateValueFromField(field);
        }
      }
    });

    rows.push(row);
  }

  return rows;
}

/**
 * Generates DICOM files from an acquisition by:
 * 1. Collecting all fields (acquisition + series)
 * 2. Extracting validation field values
 * 3. Ensuring ProtocolName exists
 * 4. Generating test data
 * 5. Creating DICOMs via API
 * 6. Extracting from ZIP
 *
 * @param acquisition The acquisition to generate DICOMs for
 * @param onProgress Optional callback for progress updates
 * @returns Array of generated DICOM File objects
 */
export async function generateDicomsFromAcquisition(
  acquisition: Acquisition,
  onProgress?: (message: string, percentage: number) => void
): Promise<File[]> {
  onProgress?.('Collecting fields...', 10);

  // Build all fields list (acquisition + series)
  const allFields: DicomField[] = [...(acquisition.acquisitionFields || [])];

  // Add series fields - handle both array and object formats
  const seriesFieldMap = new Map<string, DicomField>();
  (acquisition.series || []).forEach(series => {
    if (Array.isArray(series.fields)) {
      series.fields.forEach((field: any) => {
        if (!seriesFieldMap.has(field.tag)) {
          seriesFieldMap.set(field.tag, {
            ...field,
            level: 'series'
          });
        }
      });
    } else if (typeof series.fields === 'object' && series.fields) {
      Object.entries(series.fields).forEach(([tag, fieldData]: [string, any]) => {
        if (!seriesFieldMap.has(tag)) {
          seriesFieldMap.set(tag, {
            tag: tag,
            name: fieldData.name || fieldData.field || tag,
            value: fieldData.value,
            level: 'series',
            ...fieldData
          });
        }
      });
    }
  });
  allFields.push(...Array.from(seriesFieldMap.values()));

  onProgress?.('Extracting validation values...', 20);

  // Extract validation field values from validation functions
  const { validationFieldValues, maxValidationRows } = extractValidationFieldValues(
    acquisition.validationFunctions || [],
    allFields,
    acquisition.series || []
  );

  onProgress?.('Checking ProtocolName...', 30);

  // Ensure ProtocolName field exists if not in schema
  const hasProtocolName = allFields.some(f => f.name === 'ProtocolName');
  if (!hasProtocolName && acquisition.protocolName) {
    const protocolNameFieldDef = await getFieldByKeyword('ProtocolName');
    if (protocolNameFieldDef) {
      const cleanedName = acquisition.protocolName
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '_')
        .replace(/^_+|_+$/g, '');

      allFields.push({
        name: protocolNameFieldDef.keyword,
        tag: protocolNameFieldDef.tag,
        vr: protocolNameFieldDef.vr,
        level: 'acquisition',
        value: cleanedName,
        dataType: 'String'
      } as DicomField);
    }
  }

  onProgress?.('Generating test data...', 40);

  // Generate test data using existing utility
  const testData = generateTestDataFromSchema(
    allFields,
    acquisition.series || [],
    validationFieldValues,
    maxValidationRows
  );

  // Add fields from testData that aren't in allFields (from validation tests)
  const existingFieldNames = new Set(allFields.map(f => f.name));
  const testDataFieldNames = [...new Set(testData.flatMap(row => Object.keys(row)))];

  for (const fieldName of testDataFieldNames) {
    if (!existingFieldNames.has(fieldName)) {
      const fieldDef = await getFieldByKeyword(fieldName);
      if (fieldDef) {
        allFields.push({
          name: fieldName,
          tag: fieldDef.tag.replace(/[()]/g, ''),
          vr: fieldDef.vr || '',
          level: 'acquisition',
          dataType: inferDataTypeFromValue(testData[0][fieldName]),
          value: testData[0][fieldName]
        } as DicomField);
      }
    }
  }

  onProgress?.('Generating DICOM files...', 50);

  // Generate DICOMs from the test data
  const zipBlob = await dicompareAPI.generateTestDicomsFromSchema(
    acquisition,
    testData,
    allFields
  );

  onProgress?.('Extracting DICOM files...', 70);

  // Extract DICOMs from ZIP
  const zip = await JSZip.loadAsync(zipBlob);
  const dicomFiles: File[] = [];

  for (const [filename, zipEntry] of Object.entries(zip.files)) {
    if (!zipEntry.dir && filename.endsWith('.dcm')) {
      const blob = await zipEntry.async('blob');
      dicomFiles.push(new File([blob], filename, { type: 'application/dicom' }));
    }
  }

  onProgress?.('Complete', 100);

  return dicomFiles;
}
