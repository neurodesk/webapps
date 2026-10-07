import React, { useState, useEffect, useMemo } from 'react';
import { X, Plus, Search, ChevronDown, SlidersHorizontal } from 'lucide-react';
import Modal from '../common/Modal';
import { ValidationParameterDefinition } from '../../types';
import { formatParamValue } from '../../utils/validationParams';

// Types for validation functions (extracted from PythonSchemaBuilder)
export type TestCaseExpectation = 'pass' | 'fail' | 'warning';

export interface TestCase {
  id: string;
  name: string;
  data: Record<string, any[]>; // field name -> array of values (each index is a row)
  expectedResult: TestCaseExpectation;
  description?: string;
  params?: Record<string, any>; // per-test-case parameter overrides
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
  optional_fields?: string[]; // available to the rule when present; absence is not an error
  fieldTypes?: Record<string, FieldDataType>; // Maps field name to data type
  parameterDefinitions?: ValidationParameterDefinition[]; // typed declarations; values live in configuredParams
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

// Dynamic validation function loading. The file list lives in
// public/validation-functions/index.json, which includes every reusable
// function plus the rules harvested from the schema library.
const loadValidationFunctions = async (): Promise<ValidationFunction[]> => {
  let functionFiles: string[] = [];
  try {
    const indexResponse = await fetch('/validation-functions/index.json');
    if (indexResponse.ok) {
      functionFiles = await indexResponse.json();
    } else {
      console.warn('Failed to load validation function index');
    }
  } catch (error) {
    console.error('Error loading validation function index:', error);
  }

  const results = await Promise.all(functionFiles.map(async fileName => {
    try {
      const response = await fetch(`/validation-functions/${fileName}`);
      if (response.ok) {
        return await response.json() as ValidationFunction;
      }
      console.warn(`Failed to load validation function: ${fileName}`);
    } catch (error) {
      console.error(`Error loading validation function ${fileName}:`, error);
    }
    return null;
  }));

  return results.filter((f): f is ValidationFunction => f !== null);
};

const ValidationFunctionLibraryModal: React.FC<ValidationFunctionLibraryModalProps> = ({
  isOpen,
  onClose,
  onSelectFunction,
  onCreateNewFunction
}) => {
  const [validationFunctions, setValidationFunctions] = useState<ValidationFunction[]>([]);
  const [functionsLoading, setFunctionsLoading] = useState(true);
  const [searchQuery, setSearchQuery] = useState('');
  const [selectedFields, setSelectedFields] = useState<Set<string>>(new Set());
  const [collapsedCategories, setCollapsedCategories] = useState<Set<string>>(new Set());

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

  // Functions matching the text search (field filter applied separately so the
  // sidebar counts stay meaningful while searching)
  const searchedFunctions = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    if (!q) return validationFunctions;
    return validationFunctions.filter(f => {
      const paramNames = (f.parameterDefinitions || []).map(p => p.name);
      return [f.name, f.description, f.id, f.category, ...f.fields, ...paramNames]
        .join(' ')
        .toLowerCase()
        .includes(q);
    });
  }, [validationFunctions, searchQuery]);

  // DICOM fields examined by the searched functions, with usage counts
  const fieldCounts = useMemo(() => {
    const counts = new Map<string, number>();
    searchedFunctions.forEach(f => f.fields.forEach(field => {
      counts.set(field, (counts.get(field) || 0) + 1);
    }));
    return [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  }, [searchedFunctions]);

  const filteredFunctions = useMemo(() => {
    if (selectedFields.size === 0) return searchedFunctions;
    return searchedFunctions.filter(f => f.fields.some(field => selectedFields.has(field)));
  }, [searchedFunctions, selectedFields]);

  const categories = [...new Set(filteredFunctions.map(f => f.category))].sort((a, b) => a.localeCompare(b));
  const filterActive = searchQuery.trim() !== '' || selectedFields.size > 0;

  const toggleField = (field: string) => {
    setSelectedFields(prev => {
      const next = new Set(prev);
      if (next.has(field)) next.delete(field);
      else next.add(field);
      return next;
    });
  };

  const toggleCategory = (category: string) => {
    setCollapsedCategories(prev => {
      const next = new Set(prev);
      if (next.has(category)) next.delete(category);
      else next.add(category);
      return next;
    });
  };

  return (
    <Modal isOpen={isOpen} onClose={onClose} size="3xl" ariaLabel="Validation Function Library" closeOnBackdrop={false}>
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

        {/* Search bar */}
        <div className="px-6 py-3 border-b border-border">
          <div className="relative">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-content-tertiary pointer-events-none" />
            <input
              type="text"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="Search by name, description, field, or parameter..."
              className="w-full pl-9 pr-9 py-2 text-sm border border-border-secondary rounded-md bg-surface-primary text-content-primary focus:outline-none focus:ring-2 focus:ring-brand-500"
            />
            {searchQuery && (
              <button
                onClick={() => setSearchQuery('')}
                className="absolute right-3 top-1/2 -translate-y-1/2 text-content-tertiary hover:text-content-secondary"
                title="Clear search"
              >
                <X className="h-4 w-4" />
              </button>
            )}
          </div>
        </div>

        <div className="flex max-h-[60vh] min-h-[400px]">
          {/* Field filter sidebar */}
          <div className="w-56 flex-shrink-0 border-r border-border overflow-y-auto px-3 py-3">
            <div className="flex items-center justify-between mb-2 px-1">
              <span className="text-xs font-semibold uppercase tracking-wider text-content-tertiary">DICOM Fields</span>
              {selectedFields.size > 0 && (
                <button
                  onClick={() => setSelectedFields(new Set())}
                  className="text-xs text-brand-600 dark:text-brand-400 hover:underline"
                >
                  Clear
                </button>
              )}
            </div>
            {fieldCounts.length === 0 ? (
              <p className="px-1 text-xs text-content-tertiary">No fields to filter</p>
            ) : (
              <div className="space-y-0.5">
                {fieldCounts.map(([field, count]) => {
                  const isSelected = selectedFields.has(field);
                  return (
                    <button
                      key={field}
                      onClick={() => toggleField(field)}
                      className={`w-full flex items-center justify-between px-2 py-1 text-xs rounded transition-colors text-left ${
                        isSelected
                          ? 'bg-brand-600 text-white'
                          : 'text-content-secondary hover:bg-surface-secondary'
                      }`}
                      title={`${count} function${count === 1 ? '' : 's'} examine${count === 1 ? 's' : ''} ${field}`}
                    >
                      <span className="truncate">{field}</span>
                      <span className={`ml-2 flex-shrink-0 px-1.5 rounded-full text-[10px] ${
                        isSelected ? 'bg-white/20' : 'bg-surface-secondary text-content-tertiary'
                      }`}>
                        {count}
                      </span>
                    </button>
                  );
                })}
              </div>
            )}
          </div>

          {/* Function list */}
          <div className="flex-1 overflow-y-auto p-6">
            {functionsLoading ? (
              <div className="flex items-center justify-center py-8">
                <div className="text-content-secondary">Loading validation functions...</div>
              </div>
            ) : filteredFunctions.length === 0 ? (
              <div className="flex flex-col items-center justify-center py-8 space-y-2">
                <div className="text-content-secondary">
                  {filterActive ? 'No validation functions match your filters' : 'No validation functions found'}
                </div>
                {filterActive && (
                  <button
                    onClick={() => { setSearchQuery(''); setSelectedFields(new Set()); }}
                    className="text-sm text-brand-600 dark:text-brand-400 hover:underline"
                  >
                    Clear filters
                  </button>
                )}
              </div>
            ) : (
              categories.map(category => {
                const categoryFunctions = filteredFunctions.filter(f => f.category === category);
                // While filtering, always show matches — a collapsed section
                // hiding search results would look like missing results
                const isCollapsed = collapsedCategories.has(category) && !filterActive;
                return (
                  <div key={category} className="mb-4">
                    <button
                      onClick={() => toggleCategory(category)}
                      className="w-full flex items-center justify-between mb-2 group"
                    >
                      <span className="flex items-center font-medium text-content-primary">
                        <ChevronDown
                          className={`h-4 w-4 mr-1.5 text-content-tertiary transition-transform ${isCollapsed ? '-rotate-90' : ''}`}
                        />
                        {category}
                        <span className="ml-2 px-1.5 rounded-full bg-surface-secondary text-content-tertiary text-xs">
                          {categoryFunctions.length}
                        </span>
                      </span>
                    </button>
                    {!isCollapsed && (
                      <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                        {categoryFunctions.map(func => (
                          <div key={func.id} className="border border-border rounded-lg p-4 hover:border-brand-500/50 transition-colors bg-surface-primary">
                            <div className="flex items-start justify-between">
                              <div className="flex-1">
                                <h5 className="font-medium text-content-primary mb-1">{func.name}</h5>
                                <p className="text-sm text-content-secondary mb-2">{func.description}</p>
                                <div className="flex flex-wrap gap-1">
                                  {func.fields.map(field => (
                                    <button
                                      key={field}
                                      onClick={() => toggleField(field)}
                                      className={`px-1.5 py-0.5 text-xs rounded transition-colors ${
                                        selectedFields.has(field)
                                          ? 'bg-brand-600 text-white'
                                          : 'bg-blue-500/10 text-blue-600 dark:text-blue-400 hover:bg-blue-500/20'
                                      }`}
                                      title={`Filter by ${field}`}
                                    >
                                      {field}
                                    </button>
                                  ))}
                                </div>
                                {(func.parameterDefinitions?.length ?? 0) > 0 && (
                                  <div className="flex flex-wrap items-center gap-1 mt-1.5">
                                    <SlidersHorizontal className="h-3 w-3 text-amber-600 dark:text-amber-400" />
                                    {func.parameterDefinitions!.map(param => (
                                      <span
                                        key={param.name}
                                        title={param.description || param.label || param.name}
                                        className="px-1.5 py-0.5 bg-amber-500/10 text-amber-600 dark:text-amber-400 text-xs rounded font-mono"
                                      >
                                        {param.name}{param.default !== undefined && param.default !== null ? ` = ${formatParamValue(param.default)}` : ''}
                                      </span>
                                    ))}
                                  </div>
                                )}
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
                    )}
                  </div>
                );
              })
            )}
          </div>
        </div>
    </Modal>
  );
};

export default ValidationFunctionLibraryModal;
