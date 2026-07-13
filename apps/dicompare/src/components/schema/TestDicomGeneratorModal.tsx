import React, { useState, useEffect } from 'react';
import { X, Download, Loader2, Play, FileDown, Table, Code, AlertTriangle, CheckCircle } from 'lucide-react';
import CodeMirror from '@uiw/react-codemirror';
import { python } from '@codemirror/lang-python';
import { Acquisition, DicomField } from '../../types';
import { inferDataTypeFromValue } from '../../utils/datatypeInference';
import { dicompareWorkerAPI as dicompareAPI } from '../../services/DicompareWorkerAPI';
import { getFieldByKeyword } from '../../services/dicomFieldService';
import { extractValidationFieldValues, generateTestDataFromSchema, generateValueFromField } from '../../utils/testDataGeneration';
import { useTheme } from '../../contexts/ThemeContext';

interface TestDicomGeneratorModalProps {
  isOpen: boolean;
  onClose: () => void;
  acquisition: Acquisition;
  schemaId?: string;
  getSchemaContent?: (id: string) => Promise<string | null>;
}

interface TestDataRow {
  [fieldName: string]: any;
}

const TestDicomGeneratorModal: React.FC<TestDicomGeneratorModalProps> = ({
  isOpen,
  onClose,
  acquisition,
  schemaId,
  getSchemaContent
}) => {
  const { theme } = useTheme();
  const [step, setStep] = useState<'analyzing' | 'editing' | 'generating'>('analyzing');
  const [analysisResult, setAnalysisResult] = useState<{
    fields: DicomField[];
    seriesCount: number;
    generatableFields: DicomField[];
    validationFunctionsWithTests: number;
    validationFunctionsWithoutTests: number;
    validationFunctionWarnings: string[];
    validationFieldConflictWarnings: string[];
    fieldConflicts: Array<{ fieldName: string; existingValue: any; testValue: any; validationName: string }>;
    fieldCategorization?: {
      standardFields: number;
      handledFields: number;
      unhandledFields: number;
      unhandledFieldWarnings: string[];
    };
  } | null>(null);
  const [testData, setTestData] = useState<TestDataRow[]>([]);
  const [activeTab, setActiveTab] = useState<'table' | 'code'>('table');
  const [codeTemplate, setCodeTemplate] = useState<string>('');
  const [error, setError] = useState<string | null>(null);
  const [isGenerating, setIsGenerating] = useState(false);
  const [codeExecutionResult, setCodeExecutionResult] = useState<{ loading?: boolean; error?: string; success?: boolean } | null>(null);
  const [pyodideReady, setPyodideReady] = useState(false);
  const [dismissedWarnings, setDismissedWarnings] = useState<Set<string>>(new Set());
  // Track which value source the user has chosen for each conflicting field
  // Key: fieldName, Value: 'schema' | 'test:<validationName>' to identify the specific test case
  const [conflictResolutions, setConflictResolutions] = useState<Record<string, string>>({});

  // Update code template when test data changes
  useEffect(() => {
    if (analysisResult && testData.length > 0) {
      const code = generateCodeTemplate(analysisResult.generatableFields, testData);
      setCodeTemplate(code);
    }
  }, [testData, analysisResult]);

  // Initialize when modal opens
  useEffect(() => {
    if (isOpen && acquisition) {
      analyzeSchemaForGeneration();
    }
  }, [isOpen, acquisition]);

  // Handle choosing which value to use for a conflicting field
  // choiceKey is 'schema' or 'test:<validationName>' to identify the specific option
  const handleConflictResolution = (fieldName: string, choiceKey: string, valueToUse: any) => {
    setConflictResolutions(prev => ({ ...prev, [fieldName]: choiceKey }));

    // Update the test data to use the chosen value
    setTestData(prevData => {
      return prevData.map((row, rowIndex) => {
        if (fieldName in row) {
          // If valueToUse is an array, cycle through values for each row
          const newValue = Array.isArray(valueToUse)
            ? valueToUse[rowIndex % valueToUse.length]
            : valueToUse;
          return { ...row, [fieldName]: newValue };
        }
        return row;
      });
    });
  };

  const analyzeSchemaForGeneration = async () => {
    setStep('analyzing');
    setError(null);
    setDismissedWarnings(new Set()); // Reset dismissed warnings on new analysis
    setConflictResolutions({}); // Reset conflict resolutions on new analysis

    try {
      // Analyze the acquisition fields and series to determine what we can generate
      const allFields = [
        ...(acquisition.acquisitionFields || [])
      ];

      // Add all unique series fields from the new structure
      const seriesFieldMap = new Map<string, any>();
      (acquisition.series || []).forEach(series => {
        // Handle both array format (from loaded schemas) and object format (from processed data)
        if (Array.isArray(series.fields)) {
          series.fields.forEach(field => {
            if (!seriesFieldMap.has(field.tag)) {
              seriesFieldMap.set(field.tag, {
                ...field,
                level: 'series'
              });
            }
          });
        } else if (series.fields && typeof series.fields === 'object') {
          // Handle object format where fields is an object keyed by tag
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

      // Filter to only fields with values or validation rules (constraints we can generate from)
      const generatableFields = allFields.filter(field => {
        // Include field if it has a direct value
        if (field.value !== undefined && field.value !== null && field.value !== '') {
          // Check if value is an object with validationRule (nested structure)
          if (typeof field.value === 'object' && !Array.isArray(field.value) &&
              field.value.validationRule) {
            return true; // Has validation rule
          }
          return true; // Has direct value
        }
        // Also include if it has a validationRule at the field level
        if (field.validationRule) {
          return true;
        }
        return false;
      });

      // Analyze validation functions for passing test cases using shared utility
      const validationFunctions = acquisition.validationFunctions || [];
      const {
        validationFieldValues,
        maxValidationRows,
        conflicts,
        noPassingTestWarnings,
        fieldConflictWarnings
      } = extractValidationFieldValues(
        validationFunctions,
        allFields,
        acquisition.series || []
      );

      const functionsWithTests = validationFunctions.filter(vf =>
        (vf.customTestCases || vf.testCases || []).some((tc: any) => tc.expectedResult === 'pass')
      ).length;
      const functionsWithoutTests = validationFunctions.length - functionsWithTests;

      // Ensure ProtocolName field exists if not in schema
      // Use acquisition name (from UI) as fallback for ProtocolName DICOM field
      const hasProtocolName = generatableFields.some(f => f.name === 'ProtocolName');
      let fieldsForGeneration = generatableFields;
      if (!hasProtocolName) {
        const protocolNameFieldDef = await getFieldByKeyword('ProtocolName');
        if (protocolNameFieldDef && acquisition.protocolName) {
          // Clean acquisition name for use as ProtocolName (lowercase, underscores, no special chars)
          const cleanedName = acquisition.protocolName
            .toLowerCase()
            .replace(/[^a-z0-9]+/g, '_')
            .replace(/^_+|_+$/g, '');

          fieldsForGeneration = [...generatableFields, {
            name: protocolNameFieldDef.keyword || 'ProtocolName',
            tag: protocolNameFieldDef.tag,
            vr: protocolNameFieldDef.vr,
            level: 'acquisition' as const,
            value: cleanedName,
          }];
        }
      }

      // Generate initial test data based on schema constraints and validation test cases using shared utility
      const initialTestData = generateTestDataFromSchema(
        fieldsForGeneration,
        acquisition.series || [],
        validationFieldValues,
        maxValidationRows
      );

      // Categorize fields to identify unhandled fields
      const fieldCategorization = await dicompareAPI.categorizeFields(fieldsForGeneration, initialTestData);

      setAnalysisResult({
        fields: allFields,
        seriesCount: (acquisition.series || []).length,
        generatableFields: fieldsForGeneration,
        validationFunctionsWithTests: functionsWithTests,
        validationFunctionsWithoutTests: functionsWithoutTests,
        validationFunctionWarnings: noPassingTestWarnings,
        validationFieldConflictWarnings: fieldConflictWarnings,
        fieldConflicts: conflicts,
        fieldCategorization
      });
      console.log('📊 Generated initial test data:', {
        seriesCount: acquisition.series?.length || 0,
        testDataRows: initialTestData.length,
        sampleRow: initialTestData[0],
        allData: initialTestData,
        validationFieldValues,
        maxValidationRows
      });

      // Apply schema values by default for all conflicts
      // The generateTestDataFromSchema function uses validation test values by default,
      // but we want schema values to be the default choice
      let finalTestData = initialTestData;
      if (conflicts.length > 0) {
        finalTestData = initialTestData.map(row => {
          const newRow = { ...row };
          conflicts.forEach(conflict => {
            if (conflict.fieldName in newRow) {
              // Use the schema (existing) value instead of the test value
              newRow[conflict.fieldName] = conflict.existingValue;
            }
          });
          return newRow;
        });
        console.log('📊 Applied schema values as default for conflicts:', conflicts.map(c => c.fieldName));
      }

      setTestData(finalTestData);

      // Generate code template using the data with schema values applied
      const code = generateCodeTemplate(generatableFields, finalTestData);
      setCodeTemplate(code);

      setStep('editing');
    } catch (err) {
      console.error('Failed to analyze schema:', err);
      setError(`Failed to analyze schema: ${err instanceof Error ? err.message : 'Unknown error'}`);
    }
  };

  const generateCodeTemplate = (fields: DicomField[], testData: TestDataRow[]): string => {
    // Get unique field names from test data
    const fieldNames = [...new Set(testData.flatMap(row => Object.keys(row)))];

    // Separate fields into constants (same across all DICOMs) and varying (different values)
    const constants: Record<string, { value: any; comment: string }> = {};
    const varying: Record<string, { values: any[]; comment: string }> = {};

    fieldNames.forEach(fieldName => {
      const field = fields.find(f => f.name === fieldName);
      const values = testData.map(row => row[fieldName]).filter(v => v !== undefined);

      // Check if all values are the same
      const allSame = values.every((v, i) =>
        i === 0 || JSON.stringify(v) === JSON.stringify(values[0])
      );

      const tag = field?.tag || '';
      const comment = tag ? `  # ${tag}` : '';

      if (allSame && values.length > 0) {
        // Constant field - just store single value
        const value = values[0];
        constants[fieldName] = { value, comment };
      } else {
        // Varying field - store all values
        varying[fieldName] = { values, comment };
      }
    });

    // Generate constants section
    const constantEntries = Object.entries(constants).map(([fieldName, { value, comment }]) => {
      const valueStr = Array.isArray(value)
        ? `[${value.map(item => typeof item === 'string' ? `"${item}"` : item).join(', ')}]`
        : typeof value === 'string' ? `"${value}"` : String(value);

      return `    '${fieldName}': ${valueStr},${comment}`;
    });

    // Generate varying section
    const varyingEntries = Object.entries(varying).map(([fieldName, { values, comment }]) => {
      const valuesStr = `[${values.map(v =>
        Array.isArray(v)
          ? `[${v.map(item => typeof item === 'string' ? `"${item}"` : item).join(', ')}]`
          : typeof v === 'string' ? `"${v}"` : String(v)
      ).join(', ')}]`;

      return `    '${fieldName}': ${valuesStr},${comment}`;
    });

    return `import pandas as pd
import numpy as np

# Fields that are the same across all DICOMs
constants = {
${constantEntries.join('\n')}
}

# Fields that vary across DICOMs (number of DICOMs = length of lists)
varying = {
${varyingEntries.join('\n')}
}

# Generate test_data by merging constants and varying
num_dicoms = max([len(v) for v in varying.values()]) if varying else 1
test_data = {}

# Add constant fields (replicate across all DICOMs)
for field, value in constants.items():
    test_data[field] = [value] * num_dicoms

# Add varying fields
for field, values in varying.items():
    test_data[field] = values

return test_data`;
  };

  const updateTestDataValue = (rowIndex: number, fieldName: string, value: string) => {
    const newTestData = [...testData];

    // Ensure row exists
    while (newTestData.length <= rowIndex) {
      newTestData.push({});
    }

    // Smart value parsing (similar to ValidationFunctionEditorModal)
    let parsedValue;
    if (value.trim() === '') {
      parsedValue = '';
    } else if (value.includes(',')) {
      // Comma-separated values - parse as array
      const arrayValues = value.split(',').map(v => {
        const trimmed = v.trim();
        if (trimmed === '') return '';
        const num = parseFloat(trimmed);
        return isNaN(num) ? v : num;
      });
      parsedValue = arrayValues;
    } else {
      // Single value - try to parse as number
      const trimmed = value.trim();
      const num = parseFloat(trimmed);
      parsedValue = isNaN(num) ? value : num;
    }

    newTestData[rowIndex][fieldName] = parsedValue;
    setTestData(newTestData);
  };

  const addRow = () => {
    const newRow: TestDataRow = {};
    if (analysisResult) {
      analysisResult.generatableFields.forEach(field => {
        newRow[field.name] = generateValueFromField(field);
      });
    }
    setTestData([...testData, newRow]);
  };

  const removeRow = (rowIndex: number) => {
    const newTestData = testData.filter((_, index) => index !== rowIndex);
    setTestData(newTestData);
  };

  const executeCodeTemplate = async () => {
    setCodeExecutionResult({ loading: true });

    try {
      // Worker will be initialized automatically if needed
      if (!pyodideReady) {
        setPyodideReady(true);
      }

      const wrappedCode = `
import pandas as pd
import numpy as np
import json

def generate_test_data():
${codeTemplate.split('\n').map(line => '    ' + line).join('\n')}

output = None
try:
    result = generate_test_data()
    if not isinstance(result, dict):
        raise ValueError("Code must return a dictionary")

    # Convert numpy arrays and other non-serializable types to lists
    cleaned_result = {}
    for key, value in result.items():
        if hasattr(value, 'tolist'):  # numpy array
            cleaned_result[key] = value.tolist()
        elif isinstance(value, list):
            # Handle lists that might contain numpy types
            cleaned_list = []
            for item in value:
                if hasattr(item, 'tolist'):
                    cleaned_list.append(item.tolist())
                elif hasattr(item, 'item'):  # numpy scalar
                    cleaned_list.append(item.item())
                else:
                    cleaned_list.append(item)
            cleaned_result[key] = cleaned_list
        elif hasattr(value, 'item'):  # numpy scalar
            cleaned_result[key] = [value.item()]
        else:
            cleaned_result[key] = [value] if not isinstance(value, list) else value

    # Validate all arrays have same length
    if cleaned_result:
        lengths = [len(v) for v in cleaned_result.values()]
        if len(set(lengths)) > 1:
            field_lengths = {k: len(v) for k, v in cleaned_result.items()}
            raise ValueError(f"All fields must have the same number of values. Found: {field_lengths}")

    output = json.dumps({"success": True, "data": cleaned_result})
except Exception as e:
    output = json.dumps({"success": False, "error": str(e)})

# Return the JSON output
output
`;

      const result = await dicompareAPI.runPython(wrappedCode);

      if (result === undefined || result === null) {
        throw new Error('No output from Python code execution');
      }

      let parsed;
      try {
        parsed = JSON.parse(result as string);
      } catch (parseErr) {
        throw new Error(`Invalid JSON output from Python: ${result}`);
      }

      if (parsed.success) {
        // Convert the data to the format expected by testData
        const numRows = (Object.values(parsed.data as Record<string, any[]>)[0])?.length || 0;
        const newTestData: TestDataRow[] = [];

        for (let i = 0; i < numRows; i++) {
          const row: TestDataRow = {};
          for (const [field, values] of Object.entries(parsed.data)) {
            row[field] = (values as any[])[i];
          }
          newTestData.push(row);
        }

        setTestData(newTestData);
        setCodeExecutionResult({ success: true });
      } else {
        setCodeExecutionResult({ error: parsed.error });
      }
    } catch (error: any) {
      setCodeExecutionResult({ error: `Execution failed: ${error.message}` });
    }
  };

  const generateDicoms = async () => {
    if (!analysisResult || testData.length === 0) {
      setError('No test data to generate DICOMs from');
      return;
    }

    setIsGenerating(true);
    setStep('generating');
    setError(null);

    try {
      // Build field list from both generatableFields and testData
      // For validation-only schemas, we need to infer field info from testData
      const fieldsForGeneration = [...analysisResult.generatableFields];

      // Add fields from testData that aren't in generatableFields
      const existingFieldNames = new Set(fieldsForGeneration.map(f => f.name));
      const testDataFieldNames = [...new Set(testData.flatMap(row => Object.keys(row)))];

      // Look up DICOM tags for fields from validation tests
      console.log('🔍 Looking up DICOM tags for fields from validation tests:', testDataFieldNames);
      for (const fieldName of testDataFieldNames) {
        if (!existingFieldNames.has(fieldName)) {
          // This field came from validation tests - look up its tag by keyword
          console.log(`  Looking up field: ${fieldName}`);
          const fieldDef = await getFieldByKeyword(fieldName);
          console.log(`  Result:`, fieldDef);

          if (fieldDef) {
            // Remove parentheses from tag if present (e.g., "(0018,0081)" -> "0018,0081")
            const tag = fieldDef.tag.replace(/[()]/g, '');

            console.log(`  ✅ Added field: ${fieldName} -> ${tag} (VR: ${fieldDef.vr})`);
            fieldsForGeneration.push({
              name: fieldName,
              tag,
              vr: fieldDef.vr || '',
              level: 'acquisition' as const,
              dataType: inferDataTypeFromValue(testData[0][fieldName]),
              value: testData[0][fieldName]
            } as any);
          } else {
            console.warn(`⚠️ Unknown DICOM field: ${fieldName} - field will be skipped in DICOM generation`);
          }
        }
      }

      // Debug logging
      console.log('📊 TestDicomGeneratorModal: Sending to API:', {
        testDataRows: testData.length,
        sampleRow: testData[0],
        allTestData: testData,
        generatableFields: analysisResult.generatableFields.map(f => ({ name: f.name, tag: f.tag, level: f.level, vr: f.vr })),
        fieldsForGeneration: fieldsForGeneration.map(f => ({ name: f.name, tag: f.tag, level: f.level, vr: f.vr }))
      });

      // Call the DicompareAPI to generate DICOMs
      const zipBlob = await dicompareAPI.generateTestDicomsFromSchema(
        acquisition,
        testData,
        fieldsForGeneration
      );

      // Trigger download
      const url = URL.createObjectURL(zipBlob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `test_dicoms_${acquisition.protocolName.replace(/\s+/g, '_')}_${new Date().toISOString().split('T')[0]}.zip`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);

      // Close modal on success
      onClose();
    } catch (err) {
      console.error('Failed to generate DICOMs:', err);
      setError(`Failed to generate DICOMs: ${err instanceof Error ? err.message : 'Unknown error'}`);
      setStep('editing'); // Go back to editing step
    } finally {
      setIsGenerating(false);
    }
  };

  if (!isOpen) return null;

  // Get field names from actual test data (supports validation-only schemas)
  const fieldNames: string[] = Array.from(new Set(testData.flatMap((row: TestDataRow) => Object.keys(row))));
  const maxRows = Math.max(1, testData.length);

  return (
    <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50 p-4">
      <div className="bg-surface-primary rounded-lg shadow-xl max-w-4xl w-full max-h-[90vh] flex flex-col">
        {/* Header */}
        <div className="px-6 py-4 border-b border-border flex items-center justify-between">
          <div>
            <h2 className="text-lg font-semibold text-content-primary">Generate Test DICOMs</h2>
            <p className="text-sm text-content-secondary mt-1">
              Create compliant DICOM files from schema: {acquisition.protocolName}
            </p>
          </div>
          <button
            onClick={onClose}
            className="text-content-tertiary hover:text-content-secondary"
          >
            <X className="h-6 w-6" />
          </button>
        </div>

        {/* Content */}
        <div className="flex-1 overflow-y-auto min-h-0">
          {step === 'analyzing' && (
            <div className="flex items-center justify-center h-full">
              <div className="text-center">
                <Loader2 className="h-8 w-8 animate-spin mx-auto mb-4 text-brand-600" />
                <p className="text-content-secondary">Analyzing schema for DICOM generation...</p>
              </div>
            </div>
          )}

          {step === 'editing' && analysisResult && (
            <div className="p-6 space-y-6">
              {/* Validation Function Success Message */}
              {analysisResult.validationFunctionsWithTests > 0 && (
                <div className="bg-green-500/10 border border-green-500/20 rounded-lg p-3">
                  <div className="flex items-center">
                    <CheckCircle className="h-5 w-5 text-green-600 dark:text-green-400 mr-2 flex-shrink-0" />
                    <p className="text-sm text-green-700 dark:text-green-300">
                      <strong>{analysisResult.validationFunctionsWithTests}</strong> validation function{analysisResult.validationFunctionsWithTests !== 1 ? 's have' : ' has'} passing test cases. Field values extracted and applied.
                    </p>
                  </div>
                </div>
              )}

              {/* Field Conflict Warnings */}
              {analysisResult.fieldConflicts.length > 0 && !dismissedWarnings.has('schemaConflicts') && (() => {
                // Group conflicts by field name to show all options per field
                const conflictsByField = analysisResult.fieldConflicts.reduce((acc: Record<string, Array<{ existingValue: any; testValue: any; validationName: string }>>, conflict: { fieldName: string; existingValue: any; testValue: any; validationName: string }) => {
                  if (!acc[conflict.fieldName]) {
                    acc[conflict.fieldName] = [];
                  }
                  acc[conflict.fieldName].push({
                    existingValue: conflict.existingValue,
                    testValue: conflict.testValue,
                    validationName: conflict.validationName
                  });
                  return acc;
                }, {} as Record<string, Array<{ existingValue: any; testValue: any; validationName: string }>>);

                return (
                  <div className="bg-orange-500/10 border border-orange-500/20 rounded-lg p-4">
                    <div className="flex items-start">
                      <AlertTriangle className="h-5 w-5 text-orange-600 dark:text-orange-400 mr-2 flex-shrink-0 mt-0.5" />
                      <div className="flex-1">
                        <h3 className="font-medium text-orange-800 dark:text-orange-300 mb-2">
                          Field Value Conflicts Detected
                        </h3>
                        <p className="text-sm text-orange-700 dark:text-orange-400 mb-3">
                          The following fields have different values in the schema vs. validation test cases. Choose which value to use for each field:
                        </p>
                        <div className="space-y-3">
                          {(Object.entries(conflictsByField) as [string, Array<{ existingValue: any; testValue: any; validationName: string }>][]).map(([fieldName, conflicts]) => {
                            const resolution = conflictResolutions[fieldName] || 'schema'; // Default to schema value
                            // Get the schema value (same across all conflicts for this field)
                            const schemaValue = conflicts[0].existingValue;

                            return (
                              <div key={fieldName} className="bg-surface-primary border border-orange-500/30 rounded p-3 text-sm">
                                <div className="font-medium text-orange-800 dark:text-orange-300 mb-2">
                                  {fieldName}
                                </div>
                                <div className="space-y-2">
                                  {/* Schema value option */}
                                  <button
                                    onClick={() => handleConflictResolution(fieldName, 'schema', schemaValue)}
                                    className={`w-full text-left p-2 rounded border transition-colors ${
                                      resolution === 'schema'
                                        ? 'bg-blue-500/10 border-blue-500/30 ring-2 ring-blue-500/20'
                                        : 'bg-surface-secondary border-border hover:bg-surface-hover'
                                    }`}
                                  >
                                    <div className="flex items-center justify-between">
                                      <div>
                                        <span className="text-content-secondary">Schema value: </span>
                                        <code className="bg-orange-500/20 px-1 rounded text-orange-700 dark:text-orange-300">{JSON.stringify(schemaValue)}</code>
                                      </div>
                                      {resolution === 'schema' && <span className="text-blue-600 dark:text-blue-400 font-medium">✓ Using</span>}
                                    </div>
                                  </button>
                                  {/* Test value options - one per validation function */}
                                  {conflicts.map((conflict, idx) => {
                                    const testKey = `test:${conflict.validationName}`;
                                    return (
                                      <button
                                        key={idx}
                                        onClick={() => handleConflictResolution(fieldName, testKey, conflict.testValue)}
                                        className={`w-full text-left p-2 rounded border transition-colors ${
                                          resolution === testKey
                                            ? 'bg-green-500/10 border-green-500/30 ring-2 ring-green-500/20'
                                            : 'bg-surface-secondary border-border hover:bg-surface-hover'
                                        }`}
                                      >
                                        <div className="flex items-center justify-between">
                                          <div>
                                            <span className="text-content-secondary">Test value </span>
                                            <span className="text-content-tertiary text-xs">(from "{conflict.validationName}")</span>
                                            <span className="text-content-secondary">: </span>
                                            <code className="bg-green-500/20 px-1 rounded text-green-700 dark:text-green-300">{JSON.stringify(conflict.testValue)}</code>
                                          </div>
                                          {resolution === testKey && <span className="text-green-600 dark:text-green-400 font-medium">✓ Using</span>}
                                        </div>
                                      </button>
                                    );
                                  })}
                                </div>
                              </div>
                            );
                          })}
                        </div>
                      </div>
                      <button
                        onClick={() => setDismissedWarnings(new Set(dismissedWarnings).add('schemaConflicts'))}
                        className="ml-2 text-orange-600 hover:text-orange-800 dark:text-orange-400 dark:hover:text-orange-300"
                        title="Dismiss warning"
                      >
                        <X className="h-4 w-4" />
                      </button>
                    </div>
                  </div>
                );
              })()}

              {/* Validation Field Conflict Warnings - only show for fields NOT already in the orange choice UI */}
              {(() => {
                // Get field names that are already shown in the orange conflict choice UI
                const fieldsWithChoices = new Set(analysisResult.fieldConflicts.map(c => c.fieldName));
                // Filter out warnings for fields that already have a choice UI
                const remainingWarnings = analysisResult.validationFieldConflictWarnings.filter(warning => {
                  // Extract field name from warning message (format: 'Multiple validation functions use field "FieldName" with...')
                  const match = warning.match(/field "([^"]+)"/);
                  return match ? !fieldsWithChoices.has(match[1]) : true;
                });

                return remainingWarnings.length > 0 && !dismissedWarnings.has('fieldConflicts') && (
                  <div className="bg-yellow-500/10 border border-yellow-500/20 rounded-lg p-4">
                    <div className="flex items-start">
                      <AlertTriangle className="h-5 w-5 text-yellow-600 dark:text-yellow-400 mr-2 flex-shrink-0 mt-0.5" />
                      <div className="flex-1">
                        <h3 className="font-medium text-yellow-800 dark:text-yellow-300 mb-2">
                          Conflicting Validation Test Values
                        </h3>
                        <p className="text-sm text-yellow-700 dark:text-yellow-400 mb-2">
                          Multiple validation functions use the same fields with different test values. The generated test data may not pass all validations:
                        </p>
                        <ul className="text-sm text-yellow-700 dark:text-yellow-400 list-disc list-inside space-y-1">
                          {remainingWarnings.map((warning, idx) => (
                            <li key={idx}>{warning}</li>
                          ))}
                        </ul>
                        <p className="text-xs text-yellow-600 dark:text-yellow-500 mt-2">
                          <strong>Note:</strong> Automatically combining conflicting validation constraints is non-trivial. You may need to manually adjust the test data to satisfy all validations.
                        </p>
                      </div>
                      <button
                        onClick={() => setDismissedWarnings(new Set(dismissedWarnings).add('fieldConflicts'))}
                        className="ml-2 text-yellow-600 hover:text-yellow-800 dark:text-yellow-400 dark:hover:text-yellow-300"
                        title="Dismiss warning"
                      >
                        <X className="h-4 w-4" />
                      </button>
                    </div>
                  </div>
                );
              })()}

              {/* Validation Function Warnings */}
              {analysisResult.validationFunctionWarnings.length > 0 && !dismissedWarnings.has('noPassingTests') && (
                <div className="bg-yellow-500/10 border border-yellow-500/20 rounded-lg p-4">
                  <div className="flex items-start">
                    <AlertTriangle className="h-5 w-5 text-yellow-600 dark:text-yellow-400 mr-2 flex-shrink-0 mt-0.5" />
                    <div className="flex-1">
                      <h3 className="font-medium text-yellow-800 dark:text-yellow-300 mb-2">
                        Validation Functions Without Passing Tests
                      </h3>
                      <p className="text-sm text-yellow-700 dark:text-yellow-400 mb-2">
                        The following validation functions don't have passing test cases, so their field requirements cannot be auto-generated:
                      </p>
                      <ul className="text-sm text-yellow-700 dark:text-yellow-400 list-disc list-inside space-y-1">
                        {analysisResult.validationFunctionWarnings.map((warning, idx) => (
                          <li key={idx}>{warning}</li>
                        ))}
                      </ul>
                      <p className="text-xs text-yellow-600 dark:text-yellow-500 mt-2">
                        Add passing test cases to these validation functions to automatically populate their field values.
                      </p>
                    </div>
                    <button
                      onClick={() => setDismissedWarnings(new Set(dismissedWarnings).add('noPassingTests'))}
                      className="ml-2 text-yellow-600 hover:text-yellow-800 dark:text-yellow-400 dark:hover:text-yellow-300"
                      title="Dismiss warning"
                    >
                      <X className="h-4 w-4" />
                    </button>
                  </div>
                </div>
              )}

              {/* Unhandled Fields Warning */}
              {analysisResult.fieldCategorization && analysisResult.fieldCategorization.unhandledFieldWarnings.length > 0 && !dismissedWarnings.has('unhandledFields') && (
                <div className="bg-orange-500/10 border border-orange-500/20 rounded-lg p-4">
                  <div className="flex items-start">
                    <AlertTriangle className="h-5 w-5 text-orange-600 dark:text-orange-400 mr-2 flex-shrink-0 mt-0.5" />
                    <div className="flex-1">
                      <h3 className="font-medium text-orange-800 dark:text-orange-300 mb-2">
                        Fields Cannot Be Encoded in DICOMs
                      </h3>
                      <p className="text-sm text-orange-700 dark:text-orange-400 mb-2">
                        The following fields have no standard DICOM tag or special encoding method. Generated DICOMs will NOT include these fields and may fail validation:
                      </p>
                      <ul className="list-disc list-inside text-sm text-orange-600 dark:text-orange-400 space-y-1">
                        {analysisResult.fieldCategorization.unhandledFieldWarnings.map((warning, idx) => (
                          <li key={idx}>{warning}</li>
                        ))}
                      </ul>
                      <div className="mt-3 text-xs text-orange-600 dark:text-orange-400 bg-orange-500/10 p-2 rounded">
                        <strong>Summary:</strong> {analysisResult.fieldCategorization.standardFields} standard DICOM fields, {analysisResult.fieldCategorization.handledFields} handled special fields (e.g., MultibandFactor), {analysisResult.fieldCategorization.unhandledFields} unhandled fields
                      </div>
                    </div>
                    <button
                      onClick={() => setDismissedWarnings(new Set(dismissedWarnings).add('unhandledFields'))}
                      className="ml-2 text-orange-600 hover:text-orange-800 dark:text-orange-400 dark:hover:text-orange-300"
                    >
                      <X className="h-4 w-4" />
                    </button>
                  </div>
                </div>
              )}

              {/* Tab Navigation */}
              <div className="flex items-center justify-between">
                <div className="flex space-x-1">
                  <button
                    onClick={() => setActiveTab('table')}
                    className={`px-3 py-1 text-sm font-medium rounded-t-md border-b-2 flex items-center space-x-1 ${
                      activeTab === 'table'
                        ? 'text-blue-600 dark:text-blue-400 border-blue-600 dark:border-blue-400 bg-blue-500/10'
                        : 'text-content-tertiary border-transparent hover:text-content-secondary'
                    }`}
                  >
                    <Table className="h-4 w-4" />
                    <span>Table Editor</span>
                  </button>
                  <button
                    onClick={() => setActiveTab('code')}
                    className={`px-3 py-1 text-sm font-medium rounded-t-md border-b-2 flex items-center space-x-1 ${
                      activeTab === 'code'
                        ? 'text-green-600 dark:text-green-400 border-green-600 dark:border-green-400 bg-green-500/10'
                        : 'text-content-tertiary border-transparent hover:text-content-secondary'
                    }`}
                  >
                    <Code className="h-4 w-4" />
                    <span>Code View</span>
                  </button>
                </div>

                {activeTab === 'table' && (
                  <button
                    onClick={addRow}
                    className="px-3 py-1 text-sm bg-blue-500/10 text-blue-600 dark:text-blue-400 rounded hover:bg-blue-500/20"
                  >
                    + Add Row
                  </button>
                )}
              </div>

              {/* Table Editor */}
              {activeTab === 'table' && (
                <div className="border border-border-secondary rounded-lg overflow-hidden">
                  <div className="overflow-x-auto max-h-96 overflow-y-auto">
                    <div className="min-w-max">
                      {/* Header - Row numbers as columns */}
                      <div className="bg-surface-secondary border-b border-border-secondary flex sticky top-0 z-20">
                        <div className="w-48 px-2 py-2 text-sm font-medium text-content-secondary border-r border-border-secondary sticky left-0 bg-surface-secondary z-30">Field Name</div>
                        {Array.from({ length: maxRows }, (_, rowIndex) => (
                          <div key={rowIndex} className="w-40 flex-shrink-0 px-2 py-2 text-sm font-medium text-content-secondary border-r border-border-secondary last:border-r-0 flex items-center justify-between">
                            <span>DICOM {rowIndex + 1}</span>
                            {testData.length > 1 && (
                              <button
                                onClick={() => removeRow(rowIndex)}
                                className="p-1 text-red-500 hover:text-red-700 dark:text-red-400 dark:hover:text-red-300 text-xs"
                                title="Delete row"
                              >
                                ×
                              </button>
                            )}
                          </div>
                        ))}
                      </div>

                      {/* Rows - Each field becomes a row */}
                      {fieldNames.map((fieldName) => (
                        <div key={fieldName} className="flex border-b border-border last:border-b-0">
                          <div className="w-48 px-2 py-2 text-sm font-medium text-content-secondary border-r border-border-secondary bg-surface-secondary flex items-center sticky left-0 z-10">
                            {fieldName}
                          </div>
                          {Array.from({ length: maxRows }, (_, rowIndex) => (
                            <div key={rowIndex} className="w-40 flex-shrink-0 border-r border-border-secondary last:border-r-0 bg-surface-primary">
                              <input
                                type="text"
                                value={(() => {
                                  const value = testData[rowIndex]?.[fieldName];
                                  if (value === undefined || value === null) return '';
                                  if (Array.isArray(value)) return value.join(', ');
                                  return String(value);
                                })()}
                                onChange={(e) => updateTestDataValue(rowIndex, fieldName, e.target.value)}
                                className="w-full px-2 py-2 text-sm border-none bg-transparent text-content-primary focus:outline-none focus:bg-blue-500/10"
                                placeholder={`${fieldName} value`}
                              />
                            </div>
                          ))}
                        </div>
                      ))}
                    </div>
                  </div>

                  <div className="px-2 py-1 text-xs text-content-tertiary bg-surface-secondary border-t border-border flex items-center justify-between">
                    <span>Rows: {maxRows} | Each row will generate one DICOM file</span>
                    <span className="text-xs text-content-muted">(Table transposed: fields as rows, data as columns)</span>
                  </div>
                </div>
              )}

              {/* Code View */}
              {activeTab === 'code' && (
                <div className="space-y-3">
                  <div className="border border-border-secondary rounded-lg overflow-hidden">
                    <CodeMirror
                      value={codeTemplate}
                      onChange={(value) => {
                        setCodeTemplate(value);
                        setCodeExecutionResult(null); // Clear results when code changes
                      }}
                      extensions={[python()]}
                      theme={theme === 'dark' ? 'dark' : 'light'}
                      height="300px"
                      basicSetup={{
                        lineNumbers: true,
                        foldGutter: true,
                        dropCursor: false,
                        allowMultipleSelections: false,
                        indentOnInput: true,
                        bracketMatching: true,
                        closeBrackets: true,
                        autocompletion: true,
                        highlightSelectionMatches: false,
                      }}
                      className="text-sm"
                    />
                  </div>

                  <div className="flex items-center justify-between">
                    <button
                      onClick={executeCodeTemplate}
                      disabled={codeExecutionResult?.loading}
                      className="px-4 py-2 bg-green-600 text-white rounded-lg hover:bg-green-700 disabled:opacity-50 disabled:cursor-not-allowed flex items-center space-x-2"
                    >
                      {codeExecutionResult?.loading ? (
                        <>
                          <Loader2 className="h-4 w-4 animate-spin" />
                          <span>Running...</span>
                        </>
                      ) : (
                        <>
                          <Play className="h-4 w-4" />
                          <span>Run Code</span>
                        </>
                      )}
                    </button>
                    <div className="text-xs text-content-tertiary">
                      Returns a dictionary with test data. Click run to update the table.
                    </div>
                  </div>

                  {/* Code Execution Results */}
                  {codeExecutionResult?.error && (
                    <div className="p-3 bg-red-500/10 border border-red-500/20 rounded-lg text-sm text-red-600 dark:text-red-400">
                      <strong>Error:</strong> {codeExecutionResult.error}
                    </div>
                  )}

                  {codeExecutionResult?.success && (
                    <div className="p-3 bg-green-500/10 border border-green-500/20 rounded-lg text-sm text-green-600 dark:text-green-400">
                      <strong>Success!</strong> Generated {testData.length} DICOM{testData.length !== 1 ? 's' : ''} with {Object.keys(testData[0] || {}).length} fields. Switch to Table Editor to view.
                    </div>
                  )}
                </div>
              )}
            </div>
          )}

          {step === 'generating' && (
            <div className="flex items-center justify-center h-full">
              <div className="text-center">
                <Loader2 className="h-8 w-8 animate-spin mx-auto mb-4 text-brand-600" />
                <p className="text-content-secondary">Generating DICOM files...</p>
                <p className="text-sm text-content-tertiary mt-2">This may take a moment...</p>
              </div>
            </div>
          )}
        </div>

        {/* Footer */}
        {step === 'editing' && (
          <div className="px-6 py-4 border-t border-border flex items-center justify-between">
            <div>
              {error && (
                <div className="text-sm text-red-600 dark:text-red-400">
                  {error}
                </div>
              )}
            </div>
            <div className="flex space-x-3">
              <button
                onClick={onClose}
                className="px-4 py-2 border border-border-secondary text-content-secondary rounded-lg hover:bg-surface-secondary"
              >
                Cancel
              </button>
              <button
                onClick={generateDicoms}
                disabled={isGenerating || testData.length === 0}
                className="px-4 py-2 bg-brand-600 text-white rounded-lg hover:bg-brand-700 disabled:bg-gray-400 dark:disabled:bg-gray-600 disabled:cursor-not-allowed flex items-center space-x-2"
              >
                <Download className="h-4 w-4" />
                <span>Generate & Download DICOMs</span>
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
};

export default TestDicomGeneratorModal;