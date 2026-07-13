import React, { useState, useEffect } from 'react';
import { X, Plus } from 'lucide-react';

// Types for validation functions (extracted from PythonSchemaBuilder)
export type TestCaseExpectation = 'pass' | 'fail' | 'warning';

export interface TestCase {
  id: string;
  name: string;
  data: Record<string, any[]>; // field name -> array of values (each index is a row)
  expectedResult: TestCaseExpectation;
  description?: string;
}

export type FieldDataType = 'string' | 'number' | 'list_string' | 'list_number';

export interface FieldDefinition {
  name: string;
  dataType: FieldDataType;
}

export interface ValidationFunction {
  id: string;
  name: string;
  description: string;
  category: string;
  fields: string[];
  fieldTypes?: Record<string, FieldDataType>; // Maps field name to data type
  parameters?: Record<string, any>;
  implementation: string;
  testCases?: TestCase[];
  requiredSystemFields?: string[]; // System fields that should be auto-enabled
}

export interface SelectedFunction extends ValidationFunction {
  configuredParams?: Record<string, any>;
  customImplementation?: string;
  customName?: string;
  customDescription?: string;
  customFields?: string[];
  customFieldTypes?: Record<string, FieldDataType>; // Custom field data types
  customTestCases?: TestCase[];
  enabledSystemFields?: string[]; // System fields like 'Count' that are enabled
}

interface ValidationFunctionLibraryModalProps {
  isOpen: boolean;
  onClose: () => void;
  onSelectFunction: (func: ValidationFunction) => void;
  onCreateNewFunction: () => void;
}

// Dynamic validation function loading (extracted from PythonSchemaBuilder)
const loadValidationFunctions = async (): Promise<ValidationFunction[]> => {
  const functionFiles = [
    // Echo Timing
    'validate_echo_count.json',
    'validate_exact_echo_count.json',
    'uniform_echo_spacing.json',
    'validate_first_echo.json',
    'validate_echo_times.json',
    // Image Type
    'validate_image_type.json',
    'validate_image_slices.json',
    'validate_magnitude_phase_pairs.json',
    // RF
    'validate_repetition_time.json',
    'validate_flip_angle.json',
    // Geometry
    'validate_voxel_shape.json',
    'validate_pixel_spacing.json',
    'validate_pixel_bandwidth.json',
    'validate_slice_count.json',
    'validate_phase_encoding_polarity.json',
    // Diffusion
    'validate_diffusion_directions.json',
    'validate_bvalue_shells.json',
    // fMRI
    'validate_temporal_positions.json',
    // MRA
    'validate_mra_type.json'
  ];

  const functions: ValidationFunction[] = [];

  for (const fileName of functionFiles) {
    try {
      const response = await fetch(`/validation-functions/${fileName}`);
      if (response.ok) {
        const functionData = await response.json();
        functions.push(functionData);
      } else {
        console.warn(`Failed to load validation function: ${fileName}`);
      }
    } catch (error) {
      console.error(`Error loading validation function ${fileName}:`, error);
    }
  }

  return functions;
};

const ValidationFunctionLibraryModal: React.FC<ValidationFunctionLibraryModalProps> = ({
  isOpen,
  onClose,
  onSelectFunction,
  onCreateNewFunction
}) => {
  const [validationFunctions, setValidationFunctions] = useState<ValidationFunction[]>([]);
  const [functionsLoading, setFunctionsLoading] = useState(true);

  const categories = [...new Set(validationFunctions.map(f => f.category))];

  // Load validation functions when modal opens
  useEffect(() => {
    if (isOpen && validationFunctions.length === 0) {
      const loadFunctions = async () => {
        try {
          const functions = await loadValidationFunctions();
          setValidationFunctions(functions);
        } catch (error) {
          console.error('Failed to load validation functions:', error);
        } finally {
          setFunctionsLoading(false);
        }
      };
      loadFunctions();
    }
  }, [isOpen, validationFunctions.length]);

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50">
      <div className="bg-surface-primary rounded-lg max-w-4xl w-full mx-4 max-h-[80vh] overflow-hidden">
        <div className="px-6 py-4 border-b border-border">
          <div className="flex items-center justify-between">
            <h3 className="text-lg font-semibold text-content-primary">Validation Function Library</h3>
            <div className="flex items-center space-x-2">
              <button
                onClick={onCreateNewFunction}
                className="flex items-center px-3 py-1.5 bg-brand-600 text-white text-sm rounded-md hover:bg-brand-700"
              >
                <Plus className="h-4 w-4 mr-1" />
                Create New
              </button>
              <button
                onClick={onClose}
                className="text-content-tertiary hover:text-content-secondary"
              >
                <X className="h-5 w-5" />
              </button>
            </div>
          </div>
        </div>
        <div className="p-6 overflow-y-auto max-h-[60vh]">
          {functionsLoading ? (
            <div className="flex items-center justify-center py-8">
              <div className="text-content-secondary">Loading validation functions...</div>
            </div>
          ) : categories.length === 0 ? (
            <div className="flex items-center justify-center py-8">
              <div className="text-content-secondary">No validation functions found</div>
            </div>
          ) : (
            categories.map(category => (
              <div key={category} className="mb-6">
                <h4 className="font-medium text-content-primary mb-3">{category}</h4>
                <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                  {validationFunctions.filter(f => f.category === category).map(func => (
                    <div key={func.id} className="border border-border rounded-lg p-4 hover:border-brand-500/50 transition-colors bg-surface-primary">
                      <div className="flex items-start justify-between">
                        <div className="flex-1">
                          <h5 className="font-medium text-content-primary mb-1">{func.name}</h5>
                          <p className="text-sm text-content-secondary mb-2">{func.description}</p>
                          <div className="flex flex-wrap gap-1">
                            {func.fields.map(field => (
                              <span key={field} className="px-1.5 py-0.5 bg-blue-500/10 text-blue-600 dark:text-blue-400 text-xs rounded">
                                {field}
                              </span>
                            ))}
                          </div>
                        </div>
                        <button
                          onClick={() => onSelectFunction(func)}
                          className="ml-3 px-3 py-1 bg-brand-600 text-white text-sm rounded hover:bg-brand-700"
                        >
                          Add
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            ))
          )}
        </div>
      </div>
    </div>
  );
};

export default ValidationFunctionLibraryModal;