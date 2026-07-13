import React, { useState, useEffect } from 'react';
import { X, Check } from 'lucide-react';
import { DicomField, FieldDataType, ValidationConstraint, ValidationRule } from '../../types';
import { inferDataTypeFromValue, convertValueToDataType } from '../../utils/datatypeInference';

interface FieldEditModalProps {
  field: DicomField;
  value?: any; // For series-specific value editing
  onSave: (updates: Partial<DicomField> & { value?: any }) => void;
  onClose: () => void;
  isSeriesValue?: boolean; // True when editing a series-specific value
}

// Compact data type options
const DATA_TYPES: { value: FieldDataType; label: string }[] = [
  { value: 'string', label: 'String' },
  { value: 'number', label: 'Number' },
  { value: 'list_string', label: 'String[]' },
  { value: 'list_number', label: 'Number[]' },
  { value: 'json', label: 'JSON' },
];

// Compact constraint options with data type compatibility
const CONSTRAINTS: { value: ValidationConstraint; label: string; types: string[] }[] = [
  { value: 'exact', label: 'Exact', types: ['string', 'number', 'list_string', 'list_number', 'json'] },
  { value: 'tolerance', label: '± Tolerance', types: ['number', 'list_number'] },
  { value: 'range', label: 'Range', types: ['number', 'list_number'] },
  { value: 'contains', label: 'Contains', types: ['string'] },
  { value: 'contains_any', label: 'Any of', types: ['string', 'list_string', 'list_number'] },
  { value: 'contains_all', label: 'All of', types: ['list_string', 'list_number'] },
];

const FieldEditModal: React.FC<FieldEditModalProps> = ({
  field,
  value,
  onSave,
  onClose,
  isSeriesValue = false,
}) => {
  const [formData, setFormData] = useState(() => {
    let initialValue: any;
    if (field.validationRule.type === 'contains_any' && field.validationRule.contains_any) {
      initialValue = field.validationRule.contains_any;
    } else if (field.validationRule.type === 'contains_all' && field.validationRule.contains_all) {
      initialValue = field.validationRule.contains_all;
    } else if (isSeriesValue) {
      initialValue = typeof value === 'object' && value?.value !== undefined ? value.value : (value ?? '');
    } else {
      initialValue = field.value;
    }

    return {
      name: field.name,
      dataType: isSeriesValue ?
        inferDataTypeFromValue(typeof value === 'object' && value?.value !== undefined ? value.value : value) :
        ((field as any).dataType || inferDataTypeFromValue(field.value)) as FieldDataType,
      value: initialValue,
      validationRule: field.validationRule,
    };
  });

  const [errors, setErrors] = useState<{ [key: string]: string }>({});
  const [listInput, setListInput] = useState(() => {
    const val = formData.value;
    return Array.isArray(val) ? val.join(', ') : (val?.toString() || '');
  });
  const [toleranceValueInput, setToleranceValueInput] = useState(() => {
    const val = formData.validationRule.value;
    return Array.isArray(val) ? val.join(', ') : (val?.toString() || '');
  });

  useEffect(() => {
    const handleEscKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        onClose();
      }
    };

    document.addEventListener('keydown', handleEscKey);
    return () => document.removeEventListener('keydown', handleEscKey);
  }, [onClose]);

  const validateForm = () => {
    const newErrors: { [key: string]: string } = {};

    // Field name is read-only, so no need to validate it

    // Only validate the main value field when constraint is exact
    const shouldValidateMainValue = formData.validationRule.type === 'exact';

    if (shouldValidateMainValue) {
      if (formData.value === '' || formData.value === null || formData.value === undefined) {
        newErrors.value = 'Field value is required';
      }

      // Validate based on data type
      if (formData.dataType === 'number' && formData.value !== '' && isNaN(Number(formData.value))) {
        newErrors.value = 'Value must be a number';
      }

      // Validate list types
      if ((formData.dataType === 'list_string' || formData.dataType === 'list_number') && !Array.isArray(formData.value)) {
        if (formData.dataType === 'list_number' && Array.isArray(formData.value)) {
          const hasInvalidNumbers = formData.value.some(v => isNaN(Number(v)));
          if (hasInvalidNumbers) {
            newErrors.value = 'All list values must be numbers';
          }
        }
      }
    }

    // Validate constraint-specific values (for both field editing and series value editing when not exact)
    if (formData.validationRule.type !== 'exact') {
      switch (formData.validationRule.type) {
        case 'tolerance':
          if (!formData.validationRule.value && formData.validationRule.value !== 0) {
            newErrors.constraint = 'Expected value is required for tolerance constraint';
          }
          if (!formData.validationRule.tolerance && formData.validationRule.tolerance !== 0) {
            newErrors.constraint = 'Tolerance value is required';
          }
          break;
        case 'range':
          if (formData.validationRule.min === undefined && formData.validationRule.max === undefined) {
            newErrors.constraint = 'At least one of min or max value is required for range constraint';
          }
          break;
        case 'contains':
          if (!formData.validationRule.contains?.trim()) {
            newErrors.constraint = 'Substring is required for contains constraint';
          }
          break;
        case 'contains_any':
          // Values are stored in formData.value (single source of truth)
          if (!formData.value || (Array.isArray(formData.value) && formData.value.length === 0)) {
            newErrors.constraint = 'At least one value is required for contains any constraint';
          }
          break;
        case 'contains_all':
          // Values are stored in formData.value (single source of truth)
          if (!formData.value || (Array.isArray(formData.value) && formData.value.length === 0)) {
            newErrors.constraint = 'At least one value is required for contains all constraint';
          }
          break;
      }
    }

    setErrors(newErrors);
    return Object.keys(newErrors).length === 0;
  };

  const handleSave = () => {
    if (!validateForm()) {
      return;
    }

    const updates: Partial<DicomField> & { value?: any } = {};

    // formData.value is the single source of truth for list values
    // We need to copy it to the appropriate validation rule property for the schema

    let fieldValue = formData.value;
    let validationRule = { ...formData.validationRule };

    switch (formData.validationRule.type) {
      case 'tolerance':
        fieldValue = formData.validationRule.value;
        break;
      case 'range':
        fieldValue = formData.validationRule.min;
        break;
      case 'contains_any':
        // Copy formData.value to validationRule.contains_any
        validationRule.contains_any = Array.isArray(formData.value)
          ? formData.value
          : (formData.value ? [formData.value] : []);
        break;
      case 'contains_all':
        // Copy formData.value to validationRule.contains_all
        validationRule.contains_all = Array.isArray(formData.value)
          ? formData.value
          : (formData.value ? [formData.value] : []);
        break;
      // 'exact' and 'contains' use fieldValue directly
    }

    updates.value = fieldValue;
    updates.validationRule = validationRule;

    onSave(updates);
  };

  const handleDataTypeChange = (newDataType: FieldDataType) => {
    setFormData(prev => ({
      ...prev,
      dataType: newDataType,
      // Convert current value to the new data type
      value: convertValueToDataType(prev.value, newDataType),
    }));
  };

  const handleConstraintChange = (newConstraint: ValidationConstraint) => {
    setFormData(prev => {
      // SIMPLE APPROACH: formData.value is the single source of truth for list values
      // Just change the constraint type - don't copy/move values around

      let newValidationRule: ValidationRule = { type: newConstraint };

      // For numeric constraints, initialize with current value if numeric
      const numericValue = prev.value !== null && !isNaN(Number(prev.value)) ? Number(prev.value) : undefined;

      switch (newConstraint) {
        case 'tolerance':
          newValidationRule = {
            type: 'tolerance',
            value: numericValue,
            tolerance: prev.validationRule.tolerance // preserve if switching from tolerance
          };
          break;
        case 'range':
          newValidationRule = {
            type: 'range',
            min: prev.validationRule.min ?? numericValue,
            max: prev.validationRule.max
          };
          break;
        case 'contains':
          // For substring contains, use first element if array, or the string value
          const containsValue = Array.isArray(prev.value) ? prev.value[0] : prev.value;
          newValidationRule = {
            type: 'contains',
            contains: typeof containsValue === 'string' ? containsValue : String(containsValue || '')
          };
          break;
        case 'contains_any':
        case 'contains_all':
        case 'exact':
          // These all use formData.value as the source of truth
          // Just set the type, value stays in formData.value
          newValidationRule = { type: newConstraint };
          break;
      }

      return {
        ...prev,
        validationRule: newValidationRule,
      };
    });
  };

  const handleConstraintValueChange = (updates: Partial<ValidationRule>) => {
    setFormData(prev => ({
      ...prev,
      validationRule: {
        ...prev.validationRule,
        ...updates,
      },
    }));
  };

  // Update list input when value changes
  useEffect(() => {
    const val = formData.value;
    setListInput(Array.isArray(val) ? val.join(', ') : (val?.toString() || ''));
  }, [formData.value]);

  // Update tolerance value input when validation rule value changes
  useEffect(() => {
    const val = formData.validationRule.value;
    setToleranceValueInput(Array.isArray(val) ? val.join(', ') : (val?.toString() || ''));
  }, [formData.validationRule.value]);

  // Parse list input on blur
  const handleListBlur = () => {
    const isNumeric = formData.dataType === 'number' || formData.dataType === 'list_number';
    const values = listInput.split(',').map(v => v.trim()).filter(v => v.length > 0);

    if (isNumeric) {
      const nums = values.map(v => parseFloat(v)).filter(n => !isNaN(n));
      setFormData(prev => ({ ...prev, value: nums.length === 1 && prev.dataType === 'number' ? nums[0] : nums }));
    } else {
      setFormData(prev => ({
        ...prev,
        value: values.length === 1 && prev.dataType === 'string' ? values[0] : values
      }));
    }
  };

  // Parse tolerance value input on blur
  const handleToleranceValueBlur = () => {
    const values = toleranceValueInput.split(',').map(v => v.trim()).filter(v => v.length > 0);
    const nums = values.map(v => parseFloat(v)).filter(n => !isNaN(n));

    if (formData.dataType === 'list_number') {
      handleConstraintValueChange({ value: nums });
    } else {
      handleConstraintValueChange({ value: nums.length > 0 ? nums[0] : undefined });
    }
  };

  // Get available constraints for current data type
  const availableConstraints = CONSTRAINTS.filter(c => c.types.includes(formData.dataType));

  // Ensure current constraint is valid for data type
  useEffect(() => {
    if (!availableConstraints.some(c => c.value === formData.validationRule.type)) {
      handleConstraintChange('exact');
    }
  }, [formData.dataType]);

  const needsListInput = ['contains_any', 'contains_all'].includes(formData.validationRule.type) ||
    formData.dataType === 'list_string' || formData.dataType === 'list_number';

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
      <div
        className="bg-surface-primary rounded-xl shadow-2xl w-full max-w-md overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Compact Header */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-border bg-surface-secondary">
          <div className="flex items-center gap-2 min-w-0">
            <span className="font-semibold text-content-primary truncate">{field.name}</span>
            <span className="text-xs text-content-tertiary font-mono shrink-0">{field.tag}</span>
          </div>
          <button
            onClick={onClose}
            className="p-1.5 -mr-1.5 text-content-tertiary hover:text-content-primary hover:bg-surface-hover rounded-lg transition-colors"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        {/* Body */}
        <div className="p-4 space-y-4">
          {/* Type & Validation as pill selectors */}
          <div className="space-y-3">
            <div>
              <label className="block text-xs font-medium text-content-secondary mb-1.5">Type</label>
              <div className="flex flex-wrap gap-1.5">
                {DATA_TYPES.map(dt => (
                  <button
                    key={dt.value}
                    onClick={() => handleDataTypeChange(dt.value)}
                    className={`px-2.5 py-1 text-xs rounded-md transition-all ${
                      formData.dataType === dt.value
                        ? 'bg-brand-600 text-white shadow-sm'
                        : 'bg-surface-secondary text-content-secondary hover:bg-surface-hover hover:text-content-primary'
                    }`}
                  >
                    {dt.label}
                  </button>
                ))}
              </div>
            </div>

            <div>
              <label className="block text-xs font-medium text-content-secondary mb-1.5">Validation</label>
              <div className="flex flex-wrap gap-1.5">
                {availableConstraints.map(c => (
                  <button
                    key={c.value}
                    onClick={() => handleConstraintChange(c.value)}
                    className={`px-2.5 py-1 text-xs rounded-md transition-all ${
                      formData.validationRule.type === c.value
                        ? 'bg-brand-600 text-white shadow-sm'
                        : 'bg-surface-secondary text-content-secondary hover:bg-surface-hover hover:text-content-primary'
                    }`}
                  >
                    {c.label}
                  </button>
                ))}
              </div>
            </div>
          </div>

          {/* Value Input - contextual based on constraint */}
          {formData.validationRule.type === 'exact' && (
            <div>
              <label className="block text-xs font-medium text-content-secondary mb-1.5">Value</label>
              {formData.dataType === 'json' ? (
                <textarea
                  value={typeof formData.value === 'string' ? formData.value : JSON.stringify(formData.value, null, 2)}
                  onChange={(e) => {
                    try {
                      const parsed = JSON.parse(e.target.value);
                      setFormData(prev => ({ ...prev, value: parsed }));
                    } catch {
                      setFormData(prev => ({ ...prev, value: e.target.value }));
                    }
                  }}
                  rows={3}
                  className="w-full px-3 py-2 text-sm border border-border-secondary rounded-lg bg-surface-primary text-content-primary font-mono focus:ring-2 focus:ring-brand-500 focus:border-brand-500"
                  placeholder='{"key": "value"}'
                />
              ) : needsListInput ? (
                <>
                  <input
                    type="text"
                    value={listInput}
                    onChange={(e) => setListInput(e.target.value)}
                    onBlur={handleListBlur}
                    className="w-full px-3 py-2 text-sm border border-border-secondary rounded-lg bg-surface-primary text-content-primary focus:ring-2 focus:ring-brand-500 focus:border-brand-500"
                    placeholder="value1, value2, value3"
                  />
                  {Array.isArray(formData.value) && formData.value.length > 0 && (
                    <div className="flex flex-wrap gap-1 mt-2">
                      {formData.value.map((v: any, i: number) => (
                        <span key={i} className={`px-2 py-0.5 text-xs rounded-full ${
                          formData.dataType === 'list_number'
                            ? 'bg-emerald-500/10 text-emerald-700 dark:text-emerald-300'
                            : 'bg-brand-500/10 text-brand-700 dark:text-brand-300'
                        }`}>
                          {String(v)}
                        </span>
                      ))}
                    </div>
                  )}
                </>
              ) : formData.dataType === 'number' ? (
                <input
                  type="number"
                  value={formData.value ?? ''}
                  onChange={(e) => setFormData(prev => ({ ...prev, value: e.target.value === '' ? '' : parseFloat(e.target.value) }))}
                  step="any"
                  className="w-full px-3 py-2 text-sm border border-border-secondary rounded-lg bg-surface-primary text-content-primary focus:ring-2 focus:ring-brand-500 focus:border-brand-500"
                  placeholder="Enter number"
                />
              ) : (
                <input
                  type="text"
                  value={formData.value ?? ''}
                  onChange={(e) => setFormData(prev => ({ ...prev, value: e.target.value }))}
                  className="w-full px-3 py-2 text-sm border border-border-secondary rounded-lg bg-surface-primary text-content-primary focus:ring-2 focus:ring-brand-500 focus:border-brand-500"
                  placeholder="Enter value"
                />
              )}
              {errors.value && <p className="text-red-500 text-xs mt-1">{errors.value}</p>}
            </div>
          )}

          {formData.validationRule.type === 'tolerance' && (
            <div className="space-y-3">
              <div className="grid grid-cols-2 gap-3">
                <div className={formData.dataType === 'list_number' ? 'col-span-2' : ''}>
                  <label className="block text-xs font-medium text-content-secondary mb-1.5">
                    {formData.dataType === 'list_number' ? 'Values' : 'Value'}
                  </label>
                  {formData.dataType === 'list_number' ? (
                    <input
                      type="text"
                      value={toleranceValueInput}
                      onChange={(e) => setToleranceValueInput(e.target.value)}
                      onBlur={handleToleranceValueBlur}
                      className="w-full px-3 py-2 text-sm border border-border-secondary rounded-lg bg-surface-primary text-content-primary focus:ring-2 focus:ring-brand-500 focus:border-brand-500"
                      placeholder="1.25, 1.25, 2.5"
                    />
                  ) : (
                    <input
                      type="number"
                      value={formData.validationRule.value ?? ''}
                      onChange={(e) => handleConstraintValueChange({ value: e.target.value === '' ? undefined : parseFloat(e.target.value) })}
                      step="any"
                      className="w-full px-3 py-2 text-sm border border-border-secondary rounded-lg bg-surface-primary text-content-primary focus:ring-2 focus:ring-brand-500 focus:border-brand-500"
                      placeholder="2000"
                    />
                  )}
                </div>
                <div className={formData.dataType === 'list_number' ? 'col-span-2' : ''}>
                  <label className="block text-xs font-medium text-content-secondary mb-1.5">± Tolerance</label>
                  <input
                    type="number"
                    value={formData.validationRule.tolerance ?? ''}
                    onChange={(e) => handleConstraintValueChange({ tolerance: e.target.value === '' ? undefined : parseFloat(e.target.value) })}
                    min="0"
                    step="any"
                    className="w-full px-3 py-2 text-sm border border-border-secondary rounded-lg bg-surface-primary text-content-primary focus:ring-2 focus:ring-brand-500 focus:border-brand-500"
                    placeholder="50"
                  />
                </div>
              </div>
              {formData.dataType === 'list_number' && Array.isArray(formData.validationRule.value) && formData.validationRule.value.length > 0 && (
                <div className="flex flex-wrap gap-1">
                  {formData.validationRule.value.map((v: number, i: number) => (
                    <span key={i} className="px-2 py-0.5 text-xs rounded-full bg-emerald-500/10 text-emerald-700 dark:text-emerald-300">
                      {v} ± {formData.validationRule.tolerance ?? 0}
                    </span>
                  ))}
                </div>
              )}
              {errors.constraint && <p className="text-red-500 text-xs mt-1">{errors.constraint}</p>}
            </div>
          )}

          {formData.validationRule.type === 'range' && (
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="block text-xs font-medium text-content-secondary mb-1.5">Min</label>
                <input
                  type="number"
                  value={formData.validationRule.min ?? ''}
                  onChange={(e) => handleConstraintValueChange({ min: e.target.value === '' ? undefined : parseFloat(e.target.value) })}
                  step="any"
                  className="w-full px-3 py-2 text-sm border border-border-secondary rounded-lg bg-surface-primary text-content-primary focus:ring-2 focus:ring-brand-500 focus:border-brand-500"
                  placeholder="Min"
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-content-secondary mb-1.5">Max</label>
                <input
                  type="number"
                  value={formData.validationRule.max ?? ''}
                  onChange={(e) => handleConstraintValueChange({ max: e.target.value === '' ? undefined : parseFloat(e.target.value) })}
                  step="any"
                  className="w-full px-3 py-2 text-sm border border-border-secondary rounded-lg bg-surface-primary text-content-primary focus:ring-2 focus:ring-brand-500 focus:border-brand-500"
                  placeholder="Max"
                />
              </div>
              {errors.constraint && <p className="text-red-500 text-xs mt-1 col-span-2">{errors.constraint}</p>}
            </div>
          )}

          {formData.validationRule.type === 'contains' && (
            <div>
              <label className="block text-xs font-medium text-content-secondary mb-1.5">Contains substring</label>
              <input
                type="text"
                value={formData.validationRule.contains || ''}
                onChange={(e) => handleConstraintValueChange({ contains: e.target.value })}
                className="w-full px-3 py-2 text-sm border border-border-secondary rounded-lg bg-surface-primary text-content-primary focus:ring-2 focus:ring-brand-500 focus:border-brand-500"
                placeholder="BOLD"
              />
              {errors.constraint && <p className="text-red-500 text-xs mt-1">{errors.constraint}</p>}
            </div>
          )}

          {['contains_any', 'contains_all'].includes(formData.validationRule.type) && (
            <div>
              <label className="block text-xs font-medium text-content-secondary mb-1.5">
                {formData.validationRule.type === 'contains_any' ? 'Match any of' : 'Must contain all'}
              </label>
              <input
                type="text"
                value={listInput}
                onChange={(e) => setListInput(e.target.value)}
                onBlur={handleListBlur}
                className="w-full px-3 py-2 text-sm border border-border-secondary rounded-lg bg-surface-primary text-content-primary focus:ring-2 focus:ring-brand-500 focus:border-brand-500"
                placeholder="value1, value2, value3"
              />
              {Array.isArray(formData.value) && formData.value.length > 0 && (
                <div className="flex flex-wrap gap-1 mt-2">
                  {formData.value.map((v: any, i: number) => (
                    <span key={i} className="px-2 py-0.5 bg-brand-500/10 text-brand-700 dark:text-brand-300 text-xs rounded-full">
                      {String(v)}
                    </span>
                  ))}
                </div>
              )}
              {errors.constraint && <p className="text-red-500 text-xs mt-1">{errors.constraint}</p>}
            </div>
          )}
        </div>

        {/* Compact Footer */}
        <div className="flex items-center justify-end gap-2 px-4 py-3 border-t border-border bg-surface-secondary">
          <button
            onClick={onClose}
            className="px-3 py-1.5 text-sm text-content-secondary hover:text-content-primary transition-colors"
          >
            Cancel
          </button>
          <button
            onClick={handleSave}
            className="inline-flex items-center gap-1.5 px-4 py-1.5 text-sm bg-brand-600 text-white rounded-lg hover:bg-brand-700 transition-colors shadow-sm"
          >
            <Check className="h-3.5 w-3.5" />
            Save
          </button>
        </div>
      </div>
    </div>
  );
};

export default FieldEditModal;