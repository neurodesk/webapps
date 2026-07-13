import React, { useState, useEffect } from 'react';
import { ValidationConstraint, ValidationRule } from '../../types';

interface ConstraintInputWidgetsProps {
  constraint: ValidationConstraint;
  value: ValidationRule;
  onChange: (rule: ValidationRule) => void;
  className?: string;
  disabled?: boolean;
}

const ConstraintInputWidgets: React.FC<ConstraintInputWidgetsProps> = ({
  constraint,
  value,
  onChange,
  className = '',
  disabled = false
}) => {
  // Local state for text inputs that need to preserve raw text (like comma-separated lists)
  const [containsAnyText, setContainsAnyText] = useState('');
  const [containsAllText, setContainsAllText] = useState('');

  // Sync local state with prop value when it changes externally
  useEffect(() => {
    if (value.contains_any) {
      setContainsAnyText(value.contains_any.join(', '));
    }
  }, [value.contains_any]);

  useEffect(() => {
    if (value.contains_all) {
      setContainsAllText(value.contains_all.join(', '));
    }
  }, [value.contains_all]);

  const updateRule = (updates: Partial<ValidationRule>) => {
    onChange({ ...value, ...updates });
  };

  // Parse comma-separated text into array (used on blur)
  const parseCommaSeparated = (text: string): string[] => {
    return text.split(',').map(v => v.trim()).filter(v => v !== '');
  };

  switch (constraint) {
    case 'exact':
      return (
        <div className={className}>
          <label className="block text-sm font-medium text-content-primary mb-2">
            Expected Value
          </label>
          <input
            type="text"
            value={value.value ?? ''}
            onChange={(e) => updateRule({ value: e.target.value })}
            disabled={disabled}
            placeholder="Enter exact value to match"
            className={`w-full px-3 py-2 border border-border-secondary rounded-md focus:ring-2 focus:ring-brand-500 focus:border-brand-500 text-content-primary ${
              disabled ? 'bg-surface-secondary cursor-not-allowed' : 'bg-surface-primary'
            }`}
          />
        </div>
      );

    case 'tolerance':
      return (
        <div className={className}>
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="block text-sm font-medium text-content-primary mb-2">
                Expected Value
              </label>
              <input
                type="number"
                value={value.value ?? ''}
                onChange={(e) => updateRule({ value: e.target.value === '' ? undefined : parseFloat(e.target.value) })}
                disabled={disabled}
                placeholder="2000"
                className={`w-full px-3 py-2 border border-border-secondary rounded-md focus:ring-2 focus:ring-brand-500 focus:border-brand-500 text-content-primary ${
                  disabled ? 'bg-surface-secondary cursor-not-allowed' : 'bg-surface-primary'
                }`}
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-content-primary mb-2">
                Tolerance (±)
              </label>
              <input
                type="number"
                value={value.tolerance ?? ''}
                onChange={(e) => updateRule({ tolerance: e.target.value === '' ? undefined : parseFloat(e.target.value) })}
                disabled={disabled}
                placeholder="50"
                min="0"
                step="0.1"
                className={`w-full px-3 py-2 border border-border-secondary rounded-md focus:ring-2 focus:ring-brand-500 focus:border-brand-500 text-content-primary ${
                  disabled ? 'bg-surface-secondary cursor-not-allowed' : 'bg-surface-primary'
                }`}
              />
            </div>
          </div>
          {value.value !== undefined && value.value !== null && (
            <p className="mt-2 text-sm text-content-secondary">
              Range: {(value.value as number) - (value.tolerance ?? 0)} to {(value.value as number) + (value.tolerance ?? 0)}
            </p>
          )}
        </div>
      );

    case 'contains':
      return (
        <div className={className}>
          <label className="block text-sm font-medium text-content-primary mb-2">
            Substring to Find
          </label>
          <input
            type="text"
            value={value.contains || ''}
            onChange={(e) => updateRule({ contains: e.target.value })}
            disabled={disabled}
            placeholder="BOLD"
            className={`w-full px-3 py-2 border border-border-secondary rounded-md focus:ring-2 focus:ring-brand-500 focus:border-brand-500 text-content-primary ${
              disabled ? 'bg-surface-secondary cursor-not-allowed' : 'bg-surface-primary'
            }`}
          />
          <p className="mt-1 text-xs text-content-tertiary">
            Field value must contain this substring (case-insensitive)
          </p>
        </div>
      );

    case 'range':
      return (
        <div className={className}>
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="block text-sm font-medium text-content-primary mb-2">
                Minimum Value
              </label>
              <input
                type="number"
                value={value.min ?? ''}
                onChange={(e) => updateRule({ min: e.target.value === '' ? undefined : parseFloat(e.target.value) })}
                disabled={disabled}
                placeholder="8"
                className={`w-full px-3 py-2 border border-border-secondary rounded-md focus:ring-2 focus:ring-brand-500 focus:border-brand-500 text-content-primary ${
                  disabled ? 'bg-surface-secondary cursor-not-allowed' : 'bg-surface-primary'
                }`}
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-content-primary mb-2">
                Maximum Value
              </label>
              <input
                type="number"
                value={value.max ?? ''}
                onChange={(e) => updateRule({ max: e.target.value === '' ? undefined : parseFloat(e.target.value) })}
                disabled={disabled}
                placeholder="12"
                className={`w-full px-3 py-2 border border-border-secondary rounded-md focus:ring-2 focus:ring-brand-500 focus:border-brand-500 text-content-primary ${
                  disabled ? 'bg-surface-secondary cursor-not-allowed' : 'bg-surface-primary'
                }`}
              />
            </div>
          </div>
          {(value.min !== undefined && value.min !== null) || (value.max !== undefined && value.max !== null) ? (
            <p className="mt-2 text-sm text-content-secondary">
              Constraint: {
                value.min !== undefined && value.min !== null && value.max !== undefined && value.max !== null
                  ? `[${value.min}, ${value.max}]`
                  : value.min !== undefined && value.min !== null
                    ? `≥ ${value.min}`
                    : `≤ ${value.max}`
              }
            </p>
          ) : null}
        </div>
      );

    case 'contains_any':
      return (
        <div className={className}>
          <label className="block text-sm font-medium text-content-primary mb-2">
            Values to Search For
          </label>
          <input
            type="text"
            value={containsAnyText}
            onChange={(e) => setContainsAnyText(e.target.value)}
            onBlur={() => {
              const values = parseCommaSeparated(containsAnyText);
              updateRule({ contains_any: values });
            }}
            disabled={disabled}
            placeholder="T1, t1, T1-weighted"
            className={`w-full px-3 py-2 border border-border-secondary rounded-md focus:ring-2 focus:ring-brand-500 focus:border-brand-500 text-content-primary ${
              disabled ? 'bg-surface-secondary cursor-not-allowed' : 'bg-surface-primary'
            }`}
          />
          <p className="mt-1 text-xs text-content-tertiary">
            Enter comma-separated values. For strings: field must contain any of these substrings. For lists: field must contain any of these elements.
          </p>
          {value.contains_any && value.contains_any.length > 0 && (
            <div className="mt-2 flex flex-wrap gap-1">
              {value.contains_any.map((val, index) => (
                <span key={index} className="px-2 py-1 bg-blue-500/10 text-blue-700 dark:text-blue-300 text-xs rounded">
                  {String(val)}
                </span>
              ))}
            </div>
          )}
        </div>
      );

    case 'contains_all':
      return (
        <div className={className}>
          <label className="block text-sm font-medium text-content-primary mb-2">
            Required Elements
          </label>
          <input
            type="text"
            value={containsAllText}
            onChange={(e) => setContainsAllText(e.target.value)}
            onBlur={() => {
              const values = parseCommaSeparated(containsAllText);
              updateRule({ contains_all: values });
            }}
            disabled={disabled}
            placeholder="NORMAL, PRIMARY"
            className={`w-full px-3 py-2 border border-border-secondary rounded-md focus:ring-2 focus:ring-brand-500 focus:border-brand-500 text-content-primary ${
              disabled ? 'bg-surface-secondary cursor-not-allowed' : 'bg-surface-primary'
            }`}
          />
          <p className="mt-1 text-xs text-content-tertiary">
            Enter comma-separated values. List field must contain all of these elements (order doesn't matter).
          </p>
          {value.contains_all && value.contains_all.length > 0 && (
            <div className="mt-2 flex flex-wrap gap-1">
              {value.contains_all.map((val, index) => (
                <span key={index} className="px-2 py-1 bg-green-500/10 text-green-700 dark:text-green-300 text-xs rounded">
                  {String(val)}
                </span>
              ))}
            </div>
          )}
        </div>
      );

    default:
      return null;
  }
};

export default ConstraintInputWidgets;