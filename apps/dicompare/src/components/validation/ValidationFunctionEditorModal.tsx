import React, { useState, useEffect } from 'react';
import { X, Plus, Trash2, Play, Loader2 } from 'lucide-react';
import CodeMirror from '@uiw/react-codemirror';
import { python } from '@codemirror/lang-python';
import { linter, lintGutter } from '@codemirror/lint';
import { SelectedFunction, TestCase, TestCaseExpectation } from './ValidationFunctionLibraryModal';
import { dicompareWorkerAPI as dicompareAPI } from '../../services/DicompareWorkerAPI';
import { useTheme } from '../../contexts/ThemeContext';
import DicomFieldAutocompleteInput from '../common/DicomFieldAutocompleteInput';

interface ValidationFunctionEditorModalProps {
  isOpen: boolean;
  func: SelectedFunction | null;
  onClose: () => void;
  onSave: (func: SelectedFunction) => void;
}

// Available system fields
const SYSTEM_FIELDS = {
  'Count': {
    name: 'Count',
    description: 'Number of unique slice locations per value combination (handles mosaic/enhanced DICOM)'
  }
};

const ValidationFunctionEditorModal: React.FC<ValidationFunctionEditorModalProps> = ({
  isOpen,
  func,
  onClose,
  onSave
}) => {
  const { theme } = useTheme();
  const [editedFunc, setEditedFunc] = useState<SelectedFunction | null>(null);
  const [pyodideReady, setPyodideReady] = useState(false);
  const [pandasInstalled, setPandasInstalled] = useState(false);
  const [dicompareInstalled, setDicompareInstalled] = useState(false);
  const [testResults, setTestResults] = useState<Record<string, { passed: boolean; error?: string; warning?: string; stdout?: string; loading?: boolean }>>({});
  const [activeTestDataTabs, setActiveTestDataTabs] = useState<Record<string, 'table' | 'code'>>({});
  const [testDataCode, setTestDataCode] = useState<Record<string, string>>({});
  const [codeExecutionResults, setCodeExecutionResults] = useState<Record<string, { loading?: boolean; error?: string; data?: any }>>({});

  const getDefaultCodeTemplate = (fields: string[]) => {
    return `import pandas as pd
import numpy as np

# Example: Generate test data for your fields
# Modify this code to create your test data

test_data = {
${fields.map(field => `    '${field}': [${field === 'DiffusionBValue' ? '1000, 2000' : field === 'SeriesDescription' ? '"series1", "series2"' : '"value1", "value2"'}],`).join('\n')}
}

return test_data`;
  };

  // Initialize edited function when modal opens or func changes
  useEffect(() => {
    if (func) {
      // Auto-detect system fields that exist in test data
      // If a test case has data for a system field (e.g., 'Count'), automatically enable it
      const testCases = func.customTestCases || func.testCases || [];
      const detectedSystemFields = new Set(func.enabledSystemFields || []);

      // Check all test cases for system field data
      testCases.forEach(testCase => {
        if (testCase.data) {
          Object.keys(SYSTEM_FIELDS).forEach(systemFieldName => {
            if (testCase.data[systemFieldName]) {
              // This test case has data for this system field - enable it
              detectedSystemFields.add(systemFieldName);
            }
          });
        }
      });

      const editedFunction = {
        ...func,
        customName: func.customName || func.name,
        customDescription: func.customDescription || func.description,
        customFields: func.customFields || [...func.fields],
        customImplementation: func.customImplementation || func.implementation,
        customTestCases: testCases,
        enabledSystemFields: Array.from(detectedSystemFields)
      };

      setEditedFunc(editedFunction);

      // Initialize tab states and code for existing test cases
      const allFields = [...(editedFunction.customFields || editedFunction.fields), ...(editedFunction.enabledSystemFields || [])];
      const initialTabs: Record<string, 'table' | 'code'> = {};
      const initialCode: Record<string, string> = {};

      (editedFunction.customTestCases || []).forEach(testCase => {
        initialTabs[testCase.id] = 'table';
        initialCode[testCase.id] = getDefaultCodeTemplate(allFields);
      });

      setActiveTestDataTabs(initialTabs);
      setTestDataCode(initialCode);
      setCodeExecutionResults({});
    }
  }, [func]);

  // Lazy initialize Pyodide only when needed
  const initializePyodideIfNeeded = async () => {
    if (!pyodideReady) {
      try {
        await dicompareAPI.ensureInitialized();
        setPyodideReady(true);
      } catch (error) {
        console.error('Failed to initialize Pyodide:', error);
        throw error;
      }
    }
  };

  // Simple Python linter for basic syntax checking
  const pythonLinter = linter((view) => {
    const diagnostics = [];
    const code = view.state.doc.toString();

    // Basic Python syntax checks
    const lines = code.split('\n');

    lines.forEach((line, lineIndex) => {
      const trimmedLine = line.trim();

      // Check for unmatched parentheses in the line
      const openParens = (line.match(/\(/g) || []).length;
      const closeParens = (line.match(/\)/g) || []).length;
      if (openParens !== closeParens && trimmedLine.length > 0) {
        diagnostics.push({
          from: view.state.doc.line(lineIndex + 1).from,
          to: view.state.doc.line(lineIndex + 1).to,
          severity: 'warning',
          message: 'Unmatched parentheses'
        });
      }

      // Check for missing colons after if/for/while/def
      if (/^\s*(if|for|while|def|class|try|except|finally|with)\s+.+[^:]$/.test(line) && trimmedLine.length > 0) {
        diagnostics.push({
          from: view.state.doc.line(lineIndex + 1).from,
          to: view.state.doc.line(lineIndex + 1).to,
          severity: 'error',
          message: 'Missing colon after statement'
        });
      }
    });

    // Check if function has return statement (should NOT return anything)
    if (code.trim().length > 0 && code.includes('return')) {
      const lines = code.split('\n');
      lines.forEach((line, lineIndex) => {
        if (line.trim().startsWith('return')) {
          diagnostics.push({
            from: view.state.doc.line(lineIndex + 1).from,
            to: view.state.doc.line(lineIndex + 1).to,
            severity: 'warning',
            message: 'Validation functions should not return anything - raise ValidationError for failures or ValidationWarning for warnings'
          });
        }
      });
    }

    return diagnostics;
  });

  const addTestCase = () => {
    if (!editedFunc) return;

    const allFields = [...(editedFunc.customFields || editedFunc.fields), ...(editedFunc.enabledSystemFields || [])];
    const newTestCase: TestCase = {
      id: `test_${Date.now()}`,
      name: 'New Test Case',
      data: Object.fromEntries(allFields.map(field => [field, ['']]) // Start with one empty row
      ),
      expectedResult: 'pass', // Default to pass
      description: ''
    };

    setEditedFunc(prev => prev ? ({
      ...prev,
      customTestCases: [...(prev.customTestCases || []), newTestCase]
    }) : null);

    // Initialize tab state and code for new test case
    setActiveTestDataTabs(prev => ({ ...prev, [newTestCase.id]: 'table' }));
    setTestDataCode(prev => ({ ...prev, [newTestCase.id]: getDefaultCodeTemplate(allFields) }));
  };

  const executeTestDataCode = async (testCaseId: string, code: string) => {
    if (!editedFunc) return;

    setCodeExecutionResults(prev => ({
      ...prev,
      [testCaseId]: { loading: true }
    }));

    try {
      await initializePyodideIfNeeded();

      // pandas is already loaded by the worker
      if (!pandasInstalled) {
        setPandasInstalled(true);
      }

      const wrappedCode = `
import pandas as pd
import numpy as np
import json

def generate_test_data():
${code.split('\n').map(line => '    ' + line).join('\n')}

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

      // Check if result is undefined or null
      if (result === undefined || result === null) {
        throw new Error('No output from Python code execution');
      }

      let parsed;
      try {
        parsed = JSON.parse(result as string);
      } catch (parseErr) {
        console.error('Failed to parse Python output:', result);
        throw new Error(`Invalid JSON output from Python: ${result}`);
      }

      if (parsed.success) {
        // Convert the data to the format expected by the test case
        const convertedData: Record<string, any[]> = {};
        for (const [field, values] of Object.entries(parsed.data)) {
          if (Array.isArray(values)) {
            convertedData[field] = values;
          } else {
            convertedData[field] = [values];
          }
        }

        // Update the test case data
        const testIndex = (editedFunc.customTestCases || []).findIndex(tc => tc.id === testCaseId);
        if (testIndex >= 0) {
          updateTestCase(testIndex, { data: convertedData });
        }

        setCodeExecutionResults(prev => ({
          ...prev,
          [testCaseId]: { data: convertedData }
        }));
      } else {
        setCodeExecutionResults(prev => ({
          ...prev,
          [testCaseId]: { error: parsed.error }
        }));
      }
    } catch (error) {
      setCodeExecutionResults(prev => ({
        ...prev,
        [testCaseId]: { error: `Execution failed: ${error.message}` }
      }));
    }
  };

  const updateTestCase = (testIndex: number, updates: Partial<TestCase>) => {
    setEditedFunc(prev => prev ? ({
      ...prev,
      customTestCases: prev.customTestCases?.map((tc, i) =>
        i === testIndex ? { ...tc, ...updates } : tc
      ) || []
    }) : null);

    // Clear test results when test case is updated
    const testCase = editedFunc?.customTestCases?.[testIndex];
    if (testCase) {
      setTestResults(prev => {
        const newResults = { ...prev };
        delete newResults[testCase.id];
        return newResults;
      });
    }
  };

  const getActiveTab = (testCaseId: string): 'table' | 'code' => {
    return activeTestDataTabs[testCaseId] || 'table';
  };

  const setActiveTab = (testCaseId: string, tab: 'table' | 'code') => {
    setActiveTestDataTabs(prev => ({ ...prev, [testCaseId]: tab }));
  };

  const deleteTestCase = (testIndex: number) => {
    const testCase = editedFunc?.customTestCases?.[testIndex];
    if (testCase) {
      // Clean up related state
      setActiveTestDataTabs(prev => {
        const newState = { ...prev };
        delete newState[testCase.id];
        return newState;
      });
      setTestDataCode(prev => {
        const newState = { ...prev };
        delete newState[testCase.id];
        return newState;
      });
      setCodeExecutionResults(prev => {
        const newState = { ...prev };
        delete newState[testCase.id];
        return newState;
      });
    }
    setEditedFunc(prev => prev ? ({
      ...prev,
      customTestCases: prev.customTestCases?.filter((_, i) => i !== testIndex) || []
    }) : null);
  };

  const addFieldToFunction = () => {
    if (!editedFunc) return;

    const newField = `NewField${(editedFunc.customFields || editedFunc.fields).length + 1}`;
    setEditedFunc(prev => {
      if (!prev) return null;

      // Add the new field to customFields
      const updatedFields = [...(prev.customFields || prev.fields), newField];

      // Also add this field to all existing test cases with empty value
      const updatedTestCases = (prev.customTestCases || []).map(testCase => ({
        ...testCase,
        data: {
          ...testCase.data,
          [newField]: [''] // Initialize with one empty row
        }
      }));

      // Update code templates for all test cases
      const allFields = [...updatedFields, ...(prev.enabledSystemFields || [])];
      setTestDataCode(prevCode => {
        const newCode = { ...prevCode };
        (prev.customTestCases || []).forEach(testCase => {
          newCode[testCase.id] = getDefaultCodeTemplate(allFields);
        });
        return newCode;
      });

      return {
        ...prev,
        customFields: updatedFields,
        customTestCases: updatedTestCases
      };
    });
  };

  const removeFieldFromFunction = (fieldIndex: number) => {
    setEditedFunc(prev => {
      if (!prev) return null;

      const fields = prev.customFields || prev.fields;
      const fieldToRemove = fields[fieldIndex];

      // Remove field from customFields
      const updatedFields = fields.filter((_, i) => i !== fieldIndex);

      // Also remove this field from all test cases' data
      const updatedTestCases = (prev.customTestCases || []).map(testCase => ({
        ...testCase,
        data: Object.fromEntries(
          Object.entries(testCase.data).filter(([fieldName]) => fieldName !== fieldToRemove)
        )
      }));

      // Update code templates for all test cases
      const allFields = [...updatedFields, ...(prev.enabledSystemFields || [])];
      setTestDataCode(prevCode => {
        const newCode = { ...prevCode };
        (prev.customTestCases || []).forEach(testCase => {
          newCode[testCase.id] = getDefaultCodeTemplate(allFields);
        });
        return newCode;
      });

      return {
        ...prev,
        customFields: updatedFields,
        customTestCases: updatedTestCases
      };
    });
  };

  const updateFieldInFunction = (fieldIndex: number, newValue: string) => {
    setEditedFunc(prev => {
      if (!prev) return null;

      const fields = prev.customFields || prev.fields;
      const oldFieldName = fields[fieldIndex];

      // Update the field name
      const updatedFields = fields.map((field, i) =>
        i === fieldIndex ? newValue : field
      );

      // If the field name changed, update it in all test cases' data
      const updatedTestCases = oldFieldName !== newValue
        ? (prev.customTestCases || []).map(testCase => {
            const newData = { ...testCase.data };
            if (oldFieldName in newData) {
              newData[newValue] = newData[oldFieldName];
              delete newData[oldFieldName];
            }
            return { ...testCase, data: newData };
          })
        : prev.customTestCases;

      return {
        ...prev,
        customFields: updatedFields,
        customTestCases: updatedTestCases
      };
    });
  };

  const toggleSystemField = (fieldName: string) => {
    setEditedFunc(prev => {
      if (!prev) return null;

      const currentSystemFields = prev.enabledSystemFields || [];
      const isEnabled = currentSystemFields.includes(fieldName);

      if (isEnabled) {
        // Remove the system field and update test cases
        const updatedTestCases = (prev.customTestCases || []).map(testCase => ({
          ...testCase,
          data: Object.fromEntries(
            Object.entries(testCase.data).filter(([field]) => field !== fieldName)
          )
        }));

        return {
          ...prev,
          enabledSystemFields: currentSystemFields.filter(f => f !== fieldName),
          customTestCases: updatedTestCases
        };
      } else {
        // Add the system field and update test cases
        // Preserve existing data if the field already exists in test data
        const updatedTestCases = (prev.customTestCases || []).map(testCase => ({
          ...testCase,
          data: {
            ...testCase.data,
            // Only initialize with empty value if the field doesn't already exist
            [fieldName]: testCase.data[fieldName] || ['']
          }
        }));

        return {
          ...prev,
          enabledSystemFields: [...currentSystemFields, fieldName],
          customTestCases: updatedTestCases
        };
      }
    });
  };

  const runTestCase = async (testCase: TestCase, liveImplementation?: string, liveFields?: string[], liveSystemFields?: string[]) => {
    if (!editedFunc) return;

    const implementation = liveImplementation || editedFunc.customImplementation || editedFunc.implementation;
    const baseFields = liveFields || editedFunc.customFields || editedFunc.fields;
    const systemFields = liveSystemFields || editedFunc.enabledSystemFields || [];
    const fields = [...baseFields, ...systemFields];

    // Set initial loading state
    setTestResults(prev => ({
      ...prev,
      [testCase.id]: { passed: false, loading: true }
    }));

    try {
      // Initialize Pyodide on-demand
      await initializePyodideIfNeeded();
    } catch (error) {
      setTestResults(prev => ({
        ...prev,
        [testCase.id]: { passed: false, error: 'Failed to initialize Python runtime', loading: false }
      }));
      return;
    }

    try {
      // Install required packages if not already installed
      const packagesToInstall = [];
      let statusMessage = 'Installing ';

      if (!pandasInstalled) {
        packagesToInstall.push('pandas');
        statusMessage += 'pandas';
      }

      if (!dicompareInstalled) {
        if (packagesToInstall.length > 0) statusMessage += ' + ';
        statusMessage += 'dicompare';
        // The dicompare package should be available after PyodideManager initialization
      }

      if (packagesToInstall.length > 0) {
        setTestResults(prev => ({
          ...prev,
          [testCase.id]: { passed: false, loading: true, error: statusMessage + '...' }
        }));

        // pandas and dicompare are already loaded by the worker
        if (!pandasInstalled) {
          setPandasInstalled(true);
        }

        if (!dicompareInstalled) {
          setDicompareInstalled(true);
        }
      }

      // Properly indent the implementation - only add base indentation if not present
      let indentedImplementation = implementation.split('\n').map(line => {
        // If line is empty or already has indentation, keep it as is
        if (line.trim() === '' || line.startsWith(' ') || line.startsWith('\t')) {
          return '    ' + line;
        }
        // Otherwise add 4 spaces for function body indentation
        return '    ' + line;
      }).join('\n');

      // Check if the implementation is effectively empty (only comments/whitespace)
      const hasNonCommentCode = implementation.split('\n').some(line => {
        const trimmed = line.trim();
        return trimmed.length > 0 && !trimmed.startsWith('#');
      });

      // If there's no actual code, add a pass statement to avoid syntax errors
      if (!hasNonCommentCode) {
        indentedImplementation += '\n    pass';
      }

      // Create DataFrame-like structure for the test
      const testData = `
import pandas as pd
import math
import sys
from io import StringIO
from dicompare.validation import ValidationError, ValidationWarning, BaseValidationModel, validator

# Capture stdout
captured_output = StringIO()
sys.stdout = captured_output

# Create test data
test_data = {${Object.entries(testCase.data).map(([field, values]) =>
  `"${field}": [${values.filter(v => v !== '' && v != null).map(v => {
    if (Array.isArray(v)) {
      // Handle arrays - automatically detected from comma-separated input
      return `[${v.map(item => typeof item === 'string' ? `"${item}"` : item).join(', ')}]`;
    } else if (typeof v === 'string') {
      return `"${v}"`;
    } else {
      // Numbers are already parsed
      return v;
    }
  }).join(', ')}]`
).join(', ')}}

# Try to create DataFrame with better error handling
try:
    value = pd.DataFrame(test_data)
    # Compute smart Count if not already provided
    # Count = actual slice count (handles mosaic/enhanced DICOM)
    if "Count" not in value.columns:
        if "SliceLocation" in value.columns:
            value["Count"] = value["SliceLocation"].nunique()
        else:
            value["Count"] = len(value)
except ValueError as e:
    if "All arrays must be of the same length" in str(e):
        # Provide more helpful error message
        field_lengths = {${Object.entries(testCase.data).map(([field, values]) =>
          `"${field}": ${values.filter(v => v !== '' && v != null).length}`
        ).join(', ')}}
        error_msg = f"Test data error: All fields must have the same number of values. Found: {field_lengths}"
        raise ValueError(error_msg)
    else:
        raise

# Initialize test results
test_passed = False
error_message = None

# Try to compile the function first to catch syntax errors
function_code = '''def ${editedFunc.id}(cls, value):
${indentedImplementation}
'''

try:
    # First compile the function
    compiled_code = compile(function_code, '<string>', 'exec')

    # Create a namespace for execution
    exec_namespace = {
        'pd': pd,
        'math': math,
        'ValidationError': ValidationError,
        'ValidationWarning': ValidationWarning,
        'value': value
    }

    # Execute the function definition
    exec(compiled_code, exec_namespace)

    # Now try to call the function
    exec_namespace['${editedFunc.id}'](None, value)

    # If we reach here without exception, the function passed
    test_passed = True
    error_message = None
    warning_message = None

except SyntaxError as e:
    test_passed = False
    error_message = f"Syntax error in function: {str(e)}"
    warning_message = None
except ValidationError as e:
    test_passed = False
    error_message = str(e)
    warning_message = None
except ValidationWarning as e:
    test_passed = True  # Warning means it passed but with issues
    error_message = None
    warning_message = str(e)
except Exception as e:
    test_passed = False
    error_message = f"Unexpected error: {str(e)}"
    warning_message = None

# Get captured output
stdout_content = captured_output.getvalue()

# Restore stdout
sys.stdout = sys.__stdout__

# Return result
import json

# Return result as JSON
json.dumps({
    "passed": test_passed,
    "error": error_message,
    "warning": warning_message,
    "expected_result": "${testCase.expectedResult}",
    "stdout": stdout_content
})
`;

      let result;
      try {
        result = await dicompareAPI.runPython(testData);
      } catch (pythonError: any) {
        // Clean up error messages for common test setup issues
        let errorMessage = pythonError.message;

        // Check for test data setup errors and provide cleaner messages
        if (errorMessage.includes('Test data error:')) {
          // Extract just our custom error message after "Test data error: "
          const match = errorMessage.match(/Test data error: (.+?)(?:\n|$)/);
          errorMessage = match ? match[1] : 'Test data setup error';
        } else if (errorMessage.includes('All arrays must be of the same length')) {
          errorMessage = 'Test data error: All fields must have the same number of values';
        } else if (errorMessage.includes('SyntaxError') || errorMessage.includes('IndentationError')) {
          errorMessage = 'Python syntax error in test implementation';
        } else {
          // For other errors, just show the basic message without full traceback
          errorMessage = `Test execution error: ${errorMessage.split('\\n')[0]}`;
        }

        setTestResults(prev => ({
          ...prev,
          [testCase.id]: {
            passed: false,
            error: errorMessage,
            stdout: undefined,
            loading: false
          }
        }));
        return;
      }

      const testResult = JSON.parse(result);

      // Check if test result matches expectation
      let testSuccessful = false;
      const expectedResult = testCase.expectedResult;

      if (expectedResult === 'pass') {
        testSuccessful = testResult.passed && !testResult.warning;
      } else if (expectedResult === 'fail') {
        testSuccessful = !testResult.passed;
      } else if (expectedResult === 'warning') {
        testSuccessful = testResult.passed && testResult.warning;
      }

      setTestResults(prev => ({
        ...prev,
        [testCase.id]: {
          passed: testSuccessful,
          error: testResult.error || undefined,
          warning: testResult.warning || undefined,
          stdout: testResult.stdout || undefined,
          loading: false
        }
      }));

    } catch (error) {
      setTestResults(prev => ({
        ...prev,
        [testCase.id]: { passed: false, error: `Test execution failed: ${error.message}`, loading: false }
      }));
    }
  };

  const handleSave = () => {
    if (editedFunc) {
      onSave(editedFunc);
    }
  };

  if (!isOpen || !editedFunc) return null;

  return (
    <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50 p-4">
      <div className="bg-surface-primary rounded-lg max-w-6xl w-full max-h-[90vh] flex flex-col">
        <div className="px-6 py-4 border-b border-border">
          <div className="flex items-center justify-between">
            <h3 className="text-lg font-semibold text-content-primary">Edit Validation Function</h3>
            <button
              onClick={onClose}
              className="text-content-tertiary hover:text-content-secondary"
            >
              <X className="h-5 w-5" />
            </button>
          </div>
        </div>

        <div className="flex-1 p-6 min-h-0 overflow-auto">
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-6 min-h-full">
            {/* Left Panel - Function Details */}
            <div className="space-y-4 flex flex-col min-h-0">
              <div>
                <label className="block text-sm font-medium text-content-secondary mb-2">Function Name</label>
                <input
                  type="text"
                  value={editedFunc.customName || ''}
                  onChange={(e) => setEditedFunc(prev => prev ? ({ ...prev, customName: e.target.value }) : null)}
                  className="w-full px-3 py-2 border border-border-secondary rounded-md bg-surface-primary text-content-primary focus:outline-none focus:ring-2 focus:ring-brand-500"
                />
              </div>

              <div>
                <label className="block text-sm font-medium text-content-secondary mb-2">Description</label>
                <textarea
                  value={editedFunc.customDescription || ''}
                  onChange={(e) => setEditedFunc(prev => prev ? ({ ...prev, customDescription: e.target.value }) : null)}
                  rows={3}
                  className="w-full px-3 py-2 border border-border-secondary rounded-md bg-surface-primary text-content-primary focus:outline-none focus:ring-2 focus:ring-brand-500"
                />
              </div>

              <div>
                <label className="block text-sm font-medium text-content-secondary mb-2">Fields</label>
                <div className="space-y-2">
                  {(editedFunc.customFields || editedFunc.fields).map((field, fieldIndex) => (
                    <div key={fieldIndex} className="flex items-center space-x-2">
                      <DicomFieldAutocompleteInput
                        value={field}
                        onChange={(newValue) => updateFieldInFunction(fieldIndex, newValue)}
                        className="w-full px-3 py-2 border border-border-secondary rounded-md bg-surface-primary text-content-primary focus:outline-none focus:ring-2 focus:ring-brand-500"
                        placeholder="Field name"
                      />
                      <button
                        onClick={() => removeFieldFromFunction(fieldIndex)}
                        className="p-2 text-red-500 hover:text-red-700 dark:text-red-400 dark:hover:text-red-300"
                      >
                        <Trash2 className="h-4 w-4" />
                      </button>
                    </div>
                  ))}
                  <button
                    onClick={addFieldToFunction}
                    className="flex items-center px-3 py-2 text-sm text-brand-600 dark:text-brand-400 border border-brand-500/30 rounded-md hover:bg-brand-500/10"
                  >
                    <Plus className="h-4 w-4 mr-1" />
                    Add Field
                  </button>
                </div>
              </div>

              <div>
                <label className="block text-sm font-medium text-content-secondary mb-2">System Fields</label>
                <div className="space-y-2">
                  {Object.entries(SYSTEM_FIELDS).map(([fieldName, fieldInfo]) => {
                    const isEnabled = (editedFunc.enabledSystemFields || []).includes(fieldName);
                    return (
                      <div key={fieldName} className="flex items-center space-x-3">
                        <input
                          type="checkbox"
                          id={`system-field-${fieldName}`}
                          checked={isEnabled}
                          onChange={() => toggleSystemField(fieldName)}
                          className="rounded border-border-secondary text-brand-600 focus:ring-brand-500"
                        />
                        <label htmlFor={`system-field-${fieldName}`} className="flex-1 cursor-pointer">
                          <div className="text-sm font-medium text-content-primary">{fieldInfo.name}</div>
                          <div className="text-xs text-content-tertiary">{fieldInfo.description}</div>
                        </label>
                        <span className={`px-2 py-1 text-xs rounded ${
                          isEnabled
                            ? 'bg-purple-500/10 text-purple-600 dark:text-purple-400'
                            : 'bg-surface-secondary text-content-tertiary'
                        }`}>
                          {isEnabled ? 'Enabled' : 'Disabled'}
                        </span>
                      </div>
                    );
                  })}
                </div>
              </div>

              <div>
                <label className="block text-sm font-medium text-content-secondary mb-2">Validation Code</label>
                <div className="border border-border-secondary rounded-md overflow-hidden">
                  <CodeMirror
                    value={editedFunc.customImplementation || ''}
                    onChange={(value) => {
                      setEditedFunc(prev => prev ? ({ ...prev, customImplementation: value }) : null);
                      // Clear all test results when implementation changes
                      setTestResults({});
                    }}
                    extensions={[python(), pythonLinter, lintGutter()]}
                    theme={theme === 'dark' ? 'dark' : 'light'}
                    height="200px"
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
                    placeholder="Enter Python code..."
                  />
                </div>
                <div className="mt-1 text-xs text-content-tertiary">
                  Python syntax highlighting, auto-indentation, and basic linting enabled
                </div>
              </div>
            </div>

            {/* Right Panel - Test Cases */}
            <div className="flex flex-col min-h-0 h-full">
              <div className="flex items-center justify-between mb-4 flex-shrink-0">
                <h4 className="text-lg font-medium text-content-primary">Test Cases</h4>
                <button
                  onClick={addTestCase}
                  className="flex items-center px-3 py-2 bg-brand-600 text-white rounded-md hover:bg-brand-700"
                >
                  <Plus className="h-4 w-4 mr-1" />
                  Add Test
                </button>
              </div>

              <div className="space-y-4 flex-1 overflow-y-auto min-h-0">
                {(editedFunc.customTestCases || []).map((testCase, testIndex) => (
                  <div key={testCase.id} className="border border-border rounded-lg p-4 bg-surface-primary">
                    <div className="flex items-center justify-between mb-3">
                      <input
                        type="text"
                        value={testCase.name}
                        onChange={(e) => updateTestCase(testIndex, { name: e.target.value })}
                        className="font-medium text-content-primary bg-transparent border-none focus:outline-none"
                      />
                      <div className="flex items-center space-x-2">
                        <button
                          onClick={() => runTestCase(testCase, editedFunc.customImplementation || editedFunc.implementation, editedFunc.customFields || editedFunc.fields, editedFunc.enabledSystemFields || [])}
                          className="p-1 text-purple-500 hover:text-purple-700 dark:text-purple-400 dark:hover:text-purple-300"
                          title="Run this test (loads Python runtime on first use)"
                        >
                          <Play className="h-4 w-4" />
                        </button>
                        <button
                          onClick={() => deleteTestCase(testIndex)}
                          className="p-1 text-red-500 hover:text-red-700 dark:text-red-400 dark:hover:text-red-300"
                        >
                          <Trash2 className="h-4 w-4" />
                        </button>
                      </div>
                    </div>

                    <div className="mb-3">
                      <div className="flex items-center space-x-3">
                        <div className="flex items-center space-x-2">
                          <span className="text-sm text-content-secondary font-medium">Expected Result:</span>
                          <select
                            value={testCase.expectedResult}
                            onChange={(e) => {
                              const newExpectedResult = e.target.value as TestCaseExpectation;
                              updateTestCase(testIndex, {
                                expectedResult: newExpectedResult
                              });
                            }}
                            className="text-sm border border-border-secondary rounded-md px-2 py-1 bg-surface-primary text-content-primary focus:outline-none focus:ring-2 focus:ring-brand-500"
                          >
                            <option value="pass">Pass</option>
                            <option value="fail">Fail</option>
                            <option value="warning">Warning</option>
                          </select>
                        </div>
                      </div>
                    </div>

                    <div className="space-y-2">
                      {/* Tab Navigation */}
                      <div className="flex items-center justify-between">
                        <div className="flex space-x-1">
                          <button
                            onClick={() => setActiveTab(testCase.id, 'table')}
                            className={`px-3 py-1 text-xs font-medium rounded-t-md border-b-2 ${
                              getActiveTab(testCase.id) === 'table'
                                ? 'text-blue-600 dark:text-blue-400 border-blue-600 dark:border-blue-400 bg-blue-500/10'
                                : 'text-content-tertiary border-transparent hover:text-content-secondary'
                            }`}
                          >
                            Table Editor
                          </button>
                          <button
                            onClick={() => setActiveTab(testCase.id, 'code')}
                            className={`px-3 py-1 text-xs font-medium rounded-t-md border-b-2 ${
                              getActiveTab(testCase.id) === 'code'
                                ? 'text-green-600 dark:text-green-400 border-green-600 dark:border-green-400 bg-green-500/10'
                                : 'text-content-tertiary border-transparent hover:text-content-secondary'
                            }`}
                          >
                            Code Editor
                          </button>
                        </div>

                        {getActiveTab(testCase.id) === 'table' && (
                          <button
                            onClick={() => {
                              // Add a new row to all fields
                              const newData = { ...testCase.data };
                              const allFields = [...(editedFunc.customFields || editedFunc.fields), ...(editedFunc.enabledSystemFields || [])];
                              allFields.forEach(field => {
                                if (!newData[field]) newData[field] = [];
                                newData[field].push(''); // Add empty value for new row
                              });
                              updateTestCase(testIndex, { data: newData });
                            }}
                            className="px-2 py-1 text-xs bg-blue-500/10 text-blue-600 dark:text-blue-400 rounded hover:bg-blue-500/20"
                          >
                            + Add Row
                          </button>
                        )}
                      </div>

                      {/* Table Editor */}
                      {getActiveTab(testCase.id) === 'table' && (
                        <>
                        <div className="border border-border-secondary rounded-md overflow-hidden">
                        {/* Header */}
                        <div className="bg-surface-secondary border-b border-border-secondary flex">
                          <div className="w-8 px-2 py-1 text-xs font-medium text-content-secondary border-r border-border-secondary">#</div>
                          {(editedFunc.customFields || editedFunc.fields).map(field => (
                            <div key={field} className="flex-1 px-2 py-1 text-xs font-medium text-content-secondary border-r border-border-secondary last:border-r-0">
                              {field}
                            </div>
                          ))}
                          {(editedFunc.enabledSystemFields || []).map(field => (
                            <div key={field} className="flex-1 px-2 py-1 text-xs font-medium text-purple-600 dark:text-purple-400 border-r border-border-secondary last:border-r-0 bg-purple-500/10">
                              {field}
                            </div>
                          ))}
                          {/* Show extra fields from test data (e.g., Count) */}
                          {(() => {
                            const regularFields = editedFunc.customFields || editedFunc.fields;
                            const systemFields = editedFunc.enabledSystemFields || [];
                            const testDataFields = Object.keys(testCase.data || {});
                            const extraFields = testDataFields.filter(f =>
                              !regularFields.includes(f) && !systemFields.includes(f)
                            );
                            return extraFields.map(field => (
                              <div key={field} className="flex-1 px-2 py-1 text-xs font-medium text-orange-600 dark:text-orange-400 border-r border-border-secondary last:border-r-0 bg-orange-500/10" title="Extra field from test data (not in validation function fields)">
                                {field}
                              </div>
                            ));
                          })()}
                          <div className="w-8"></div>
                        </div>

                        {/* Rows - Scrollable container */}
                        <div className="max-h-[320px] overflow-y-auto">
                        {(() => {
                          const regularFields = editedFunc.customFields || editedFunc.fields;
                          const systemFields = editedFunc.enabledSystemFields || [];

                          // Include fields from test data that aren't in the function's field list
                          // (e.g., "Count" field used for grouped validation data)
                          const testDataFields = Object.keys(testCase.data || {});
                          const extraFields = testDataFields.filter(f =>
                            !regularFields.includes(f) && !systemFields.includes(f)
                          );

                          const allFields = [...regularFields, ...systemFields, ...extraFields];
                          const maxRows = Math.max(1, ...allFields.map(field => (testCase.data[field] || []).length));

                          return Array.from({ length: maxRows }, (_, rowIndex) => (
                            <div key={rowIndex} className="flex border-b border-border last:border-b-0">
                              <div className="w-8 px-2 py-1 text-xs text-content-tertiary border-r border-border-secondary bg-surface-secondary">
                                {rowIndex}
                              </div>
                              {allFields.map(field => {
                                const isSystemField = systemFields.includes(field);
                                const isExtraField = extraFields.includes(field);
                                return (
                                <div key={field} className={`flex-1 border-r border-border-secondary last:border-r-0 ${isSystemField ? 'bg-purple-500/5' : ''} ${isExtraField ? 'bg-orange-500/5' : ''}`}>
                                  <input
                                    type="text"
                                    value={(() => {
                                      const value = testCase.data[field]?.[rowIndex];
                                      if (Array.isArray(value)) {
                                        // Convert array back to comma-separated string for editing
                                        return value.join(',');
                                      }
                                      // Convert all values to strings for editing
                                      return value != null ? String(value) : '';
                                    })()}
                                    onChange={(e) => {
                                      const newData = { ...testCase.data };
                                      if (!newData[field]) newData[field] = [];

                                      // Ensure array is long enough
                                      while (newData[field].length <= rowIndex) {
                                        newData[field].push('');
                                      }

                                      const inputValue = e.target.value;
                                      console.log(`Input for ${field}: "${inputValue}"`);

                                      // Smart value parsing - automatically detect type
                                      let parsedValue;
                                      if (inputValue.trim() === '') {
                                        parsedValue = '';
                                      } else if (inputValue.includes(',')) {
                                        // Comma-separated values - parse as array
                                        const arrayValues = inputValue.split(',').map(v => {
                                          // Only trim for number parsing, preserve original value
                                          const trimmed = v.trim();
                                          if (trimmed === '') return ''; // Keep empty strings for incomplete arrays
                                          const num = parseFloat(trimmed);
                                          // Return number if it's a valid number, otherwise return original (with spaces)
                                          return isNaN(num) ? v : num;
                                        });
                                        parsedValue = arrayValues;
                                      } else {
                                        // Single value - try to parse as number
                                        const trimmed = inputValue.trim();
                                        const num = parseFloat(trimmed);
                                        // Return number if it's a valid number, otherwise return original (with spaces)
                                        parsedValue = isNaN(num) ? inputValue : num;
                                      }

                                      console.log(`Parsed value for ${field}:`, parsedValue);
                                      newData[field][rowIndex] = parsedValue;
                                      updateTestCase(testIndex, { data: newData });
                                    }}
                                    className={`w-full px-2 py-1 text-xs border-none bg-transparent text-content-primary focus:outline-none ${isSystemField ? 'focus:bg-purple-500/10' : 'focus:bg-blue-500/10'}`}
                                    placeholder={`${field} value (e.g., "1,1" for lists)`}
                                  />
                                </div>
                                );
                              })}
                              <div className="w-8 flex items-center justify-center">
                                <button
                                  onClick={() => {
                                    // Remove this row from all fields
                                    const newData = { ...testCase.data };
                                    allFields.forEach(field => {
                                      if (newData[field] && newData[field].length > rowIndex) {
                                        newData[field].splice(rowIndex, 1);
                                      }
                                    });
                                    updateTestCase(testIndex, { data: newData });
                                  }}
                                  className="p-0.5 text-red-500 hover:text-red-700 dark:text-red-400 dark:hover:text-red-300 text-xs"
                                  title="Delete row"
                                >
                                  ×
                                </button>
                              </div>
                            </div>
                          ));
                        })()}
                        </div>
                      </div>

                      <div className="text-xs text-content-tertiary">
                        Rows: {(() => {
                          const regularFields = editedFunc.customFields || editedFunc.fields;
                          const systemFields = editedFunc.enabledSystemFields || [];
                          const testDataFields = Object.keys(testCase.data || {});
                          const extraFields = testDataFields.filter(f =>
                            !regularFields.includes(f) && !systemFields.includes(f)
                          );
                          const allFields = [...regularFields, ...systemFields, ...extraFields];
                          return Math.max(1, ...allFields.map(field => (testCase.data[field] || []).length));
                        })()} |
                        Each row represents one record in the DataFrame
                      </div>
                      </>
                      )}

                      {/* Code Editor */}
                      {getActiveTab(testCase.id) === 'code' && (
                        <div className="space-y-2">
                          <div className="border border-border-secondary rounded-md overflow-hidden">
                            <CodeMirror
                              value={testDataCode[testCase.id] || ''}
                              onChange={(value) => setTestDataCode(prev => ({ ...prev, [testCase.id]: value }))}
                              extensions={[python()]}
                              theme={theme === 'dark' ? 'dark' : 'light'}
                              height="200px"
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
                                searchKeymap: false,
                              }}
                              className="text-xs"
                            />
                          </div>

                          <div className="flex items-center justify-between">
                            <button
                              onClick={() => executeTestDataCode(testCase.id, testDataCode[testCase.id] || '')}
                              disabled={codeExecutionResults[testCase.id]?.loading}
                              className="px-3 py-1 text-xs bg-green-500/10 text-green-600 dark:text-green-400 rounded hover:bg-green-500/20 disabled:opacity-50 disabled:cursor-not-allowed flex items-center"
                            >
                              {codeExecutionResults[testCase.id]?.loading ? (
                                <>
                                  <Loader2 className="h-3 w-3 mr-1 animate-spin" />
                                  Running...
                                </>
                              ) : (
                                <>
                                  <Play className="h-3 w-3 mr-1" />
                                  Run Code
                                </>
                              )}
                            </button>

                            <div className="text-xs text-content-tertiary">
                              Returns a pandas DataFrame with test data
                            </div>
                          </div>

                          {/* Code Execution Results */}
                          {codeExecutionResults[testCase.id]?.error && (
                            <div className="p-2 bg-red-500/10 border border-red-500/20 rounded text-xs text-red-600 dark:text-red-400">
                              <strong>Error:</strong> {codeExecutionResults[testCase.id].error}
                            </div>
                          )}

                          {codeExecutionResults[testCase.id]?.data && (
                            <div className="p-2 bg-green-500/10 border border-green-500/20 rounded text-xs text-green-600 dark:text-green-400">
                              <strong>Success:</strong> Generated data with {Object.keys(codeExecutionResults[testCase.id].data).length} fields and {(Object.values(codeExecutionResults[testCase.id].data)[0] as any[])?.length || 0} rows
                            </div>
                          )}
                        </div>
                      )}
                    </div>

                    {/* Test Result */}
                    {testResults[testCase.id] && (() => {
                      const result = testResults[testCase.id];
                      const expectedResult = testCase.expectedResult;

                      // Determine the color based on whether test passed its expectation
                      let bgColor = 'bg-blue-500/10 text-blue-600 dark:text-blue-400'; // Loading
                      if (!result.loading) {
                        if (result.passed) {
                          // Test met expectations - always green (even for warnings)
                          bgColor = 'bg-green-500/10 text-green-600 dark:text-green-400';
                        } else {
                          // Test didn't meet expectations - always red
                          bgColor = 'bg-red-500/10 text-red-600 dark:text-red-400';
                        }
                      }

                      // Determine the message based on whether test met expectation
                      let message = 'Running...';
                      if (!result.loading) {
                        if (result.passed) {
                          // Test met its expectation
                          if (expectedResult === 'pass') {
                            message = '✓ Passed';
                          } else if (expectedResult === 'fail') {
                            message = '✓ Failed as expected';
                          } else if (expectedResult === 'warning') {
                            message = '✓ Warning as expected';
                          }
                        } else {
                          // Test did NOT meet its expectation
                          if (expectedResult === 'pass') {
                            message = result.warning ? '⚠ Passed with warning (expected clean pass)' : '✗ Failed (expected pass)';
                          } else if (expectedResult === 'fail') {
                            message = '✗ Did not fail as expected';
                          } else if (expectedResult === 'warning') {
                            message = '✗ Did not produce warning as expected';
                          }
                        }
                      }

                      return (
                        <div className={`mt-2 p-2 text-xs rounded ${bgColor}`}>
                          <div className="flex items-center justify-between">
                            <span className="flex items-center">
                              {result.loading ? (
                                <>
                                  <Loader2 className="h-3 w-3 animate-spin mr-1" />
                                  {message}
                                </>
                              ) : (
                                message
                              )}
                            </span>
                          </div>
                          {result.error && (
                            <div className="mt-1 opacity-75">
                              <strong>Error:</strong> {result.error}
                            </div>
                          )}
                          {result.warning && (
                            <div className="mt-1 opacity-75">
                              <strong>Warning:</strong> {result.warning}
                            </div>
                          )}
                          {result.stdout && result.stdout.trim() && (
                            <div className="mt-1 p-1 bg-gray-900 text-gray-100 rounded text-xs font-mono overflow-x-auto">
                              <div className="text-gray-400 mb-0.5">stdout:</div>
                              <pre className="whitespace-pre-wrap">{result.stdout.trim()}</pre>
                            </div>
                          )}
                        </div>
                      );
                    })()}
                  </div>
                ))}
              </div>
            </div>
          </div>
        </div>

        <div className="px-6 py-4 border-t border-border flex justify-end space-x-3">
          <button
            onClick={onClose}
            className="px-4 py-2 border border-border-secondary text-content-secondary rounded-md hover:bg-surface-secondary"
          >
            Cancel
          </button>
          <button
            onClick={handleSave}
            className="px-4 py-2 bg-brand-600 text-white rounded-md hover:bg-brand-700"
          >
            Save Changes
          </button>
        </div>
      </div>
    </div>
  );
};

export default ValidationFunctionEditorModal;