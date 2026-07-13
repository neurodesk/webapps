import React, { useState } from 'react';
import { FieldDataType } from '../../types';

interface TypeSpecificInputsProps {
  dataType: FieldDataType;
  value: any;
  onChange: (value: any) => void;
  placeholder?: string;
  className?: string;
  disabled?: boolean;
  forceListInput?: boolean; // Force comma-separated list input even for string type (for contains_any/contains_all)
}

const TypeSpecificInputs: React.FC<TypeSpecificInputsProps> = ({
  dataType,
  value,
  onChange,
  placeholder,
  className = '',
  disabled = false,
  forceListInput = false
}) => {
  const [stringListInput, setStringListInput] = useState('');
  const [numberListInput, setNumberListInput] = useState('');
  const [jsonError, setJsonError] = useState('');
  const [initialized, setInitialized] = useState(false);

  const handleStringListChange = (input: string) => {
    setStringListInput(input);
    // Don't parse immediately - wait for blur (similar to number list)
  };

  const handleStringListBlur = () => {
    // Parse comma-separated values on blur
    const values = stringListInput.split(',').map(v => v.trim()).filter(v => v.length > 0);
    onChange(values);
  };

  const handleNumberListChange = (input: string) => {
    setNumberListInput(input);
    // Don't parse immediately - wait for blur
  };

  const handleNumberListBlur = () => {
    try {
      // Parse comma-separated numbers
      const values = numberListInput.split(',')
        .map(v => v.trim())
        .filter(v => v.length > 0)
        .map(v => {
          const num = parseFloat(v);
          if (isNaN(num)) throw new Error(`Invalid number: ${v}`);
          return num;
        });
      onChange(values);
    } catch (error) {
      // Keep the input but don't update the value
      console.warn('Invalid number list:', error);
    }
  };

  const handleJsonChange = (input: string) => {
    try {
      if (input.trim() === '') {
        onChange(null);
        setJsonError('');
        return;
      }
      const parsed = JSON.parse(input);
      onChange(parsed);
      setJsonError('');
    } catch (error) {
      setJsonError(`Invalid JSON: ${(error as Error).message}`);
    }
  };

  // Reset initialization flag when dataType, value, or forceListInput changes
  React.useEffect(() => {
    setInitialized(false);
  }, [dataType, value, forceListInput]);

  // Initialize string list display (also handles forceListInput with string type)
  React.useEffect(() => {
    if ((dataType === 'list_string' || (dataType === 'string' && forceListInput)) && !initialized) {
      if (Array.isArray(value)) {
        setStringListInput(value.join(', '));
      } else if (value) {
        // If value is a string that looks like a comma-separated list, convert it
        const stringValue = String(value);
        if (stringValue.includes(',')) {
          // Parse as comma-separated and rejoin with spaces
          const parsedValues = stringValue.split(',').map(v => v.trim()).filter(v => v.length > 0);
          setStringListInput(parsedValues.join(', '));
          // Also update the actual value to be an array
          onChange(parsedValues);
        } else {
          setStringListInput(stringValue);
        }
      } else {
        setStringListInput('');
      }
      setInitialized(true);
    }
  }, [dataType, value, initialized]);

  // Initialize number list display
  React.useEffect(() => {
    if (dataType === 'list_number' && !initialized) {
      if (Array.isArray(value)) {
        setNumberListInput(value.join(', '));
      } else if (value) {
        // If value is a string that looks like a comma-separated list, convert it
        const stringValue = String(value);
        if (stringValue.includes(',')) {
          // Parse as comma-separated and rejoin with spaces
          const parsedValues = stringValue.split(',').map(v => v.trim()).filter(v => v.length > 0);
          setNumberListInput(parsedValues.join(', '));
          // Convert to numbers and update the actual value
          try {
            const numberValues = parsedValues.map(v => {
              const num = parseFloat(v);
              if (isNaN(num)) throw new Error(`Invalid number: ${v}`);
              return num;
            });
            onChange(numberValues);
          } catch (error) {
            // Keep as string if parsing fails
            setNumberListInput(stringValue);
          }
        } else {
          setNumberListInput(stringValue);
        }
      } else {
        setNumberListInput('');
      }
      setInitialized(true);
    }
  }, [dataType, value, initialized]);

  // When forceListInput is true with string type, use list-style input
  if (dataType === 'string' && forceListInput) {
    return (
      <div className={className}>
        <label className="block text-sm font-medium text-content-primary mb-2">
          Values (comma-separated)
        </label>
        <input
          type="text"
          value={stringListInput}
          onChange={(e) => handleStringListChange(e.target.value)}
          onBlur={handleStringListBlur}
          disabled={disabled}
          placeholder={placeholder || 'value1, value2, value3'}
          className={`w-full px-3 py-2 border border-border-secondary rounded-md focus:ring-2 focus:ring-brand-500 focus:border-brand-500 text-content-primary ${
            disabled ? 'bg-surface-secondary cursor-not-allowed' : 'bg-surface-primary'
          }`}
        />
        <p className="mt-1 text-xs text-content-tertiary">
          Enter multiple values separated by commas
        </p>
        {Array.isArray(value) && value.length > 0 && (
          <div className="mt-2">
            <p className="text-xs text-content-secondary">Preview:</p>
            <div className="flex flex-wrap gap-1 mt-1">
              {value.map((item: string, index: number) => (
                <span key={index} className="inline-block px-2 py-1 bg-blue-500/10 text-blue-700 dark:text-blue-300 text-xs rounded">
                  "{item}"
                </span>
              ))}
            </div>
          </div>
        )}
      </div>
    );
  }

  switch (dataType) {
    case 'string':
      return (
        <div className={className}>
          <label className="block text-sm font-medium text-content-primary mb-2">
            String Value
          </label>
          <input
            type="text"
            value={value ?? ''}
            onChange={(e) => onChange(e.target.value)}
            disabled={disabled}
            placeholder={placeholder || 'Enter string value'}
            className={`w-full px-3 py-2 border border-border-secondary rounded-md focus:ring-2 focus:ring-brand-500 focus:border-brand-500 text-content-primary ${
              disabled ? 'bg-surface-secondary cursor-not-allowed' : 'bg-surface-primary'
            }`}
          />
          <p className="mt-1 text-xs text-content-tertiary">
            Example: "SIEMENS", "T1_MPRAGE", "BOLD_task"
          </p>
        </div>
      );

    case 'number':
      return (
        <div className={className}>
          <label className="block text-sm font-medium text-content-primary mb-2">
            Numeric Value
          </label>
          <input
            type="number"
            value={value ?? ''}
            onChange={(e) => onChange(e.target.value === '' ? '' : parseFloat(e.target.value))}
            disabled={disabled}
            placeholder={placeholder || 'Enter number'}
            step="any"
            className={`w-full px-3 py-2 border border-border-secondary rounded-md focus:ring-2 focus:ring-brand-500 focus:border-brand-500 text-content-primary ${
              disabled ? 'bg-surface-secondary cursor-not-allowed' : 'bg-surface-primary'
            }`}
          />
          <p className="mt-1 text-xs text-content-tertiary">
            Example: 3.0, 2000, 0.5, 12
          </p>
        </div>
      );

    case 'list_string':
      return (
        <div className={className}>
          <label className="block text-sm font-medium text-content-primary mb-2">
            String List (comma-separated)
          </label>
          <input
            type="text"
            value={stringListInput}
            onChange={(e) => handleStringListChange(e.target.value)}
            onBlur={handleStringListBlur}
            disabled={disabled}
            placeholder={placeholder || 'value1, value2, value3'}
            className={`w-full px-3 py-2 border border-border-secondary rounded-md focus:ring-2 focus:ring-brand-500 focus:border-brand-500 text-content-primary ${
              disabled ? 'bg-surface-secondary cursor-not-allowed' : 'bg-surface-primary'
            }`}
          />
          <p className="mt-1 text-xs text-content-tertiary">
            Example: "ORIGINAL, PRIMARY, M" or "T1, T2, FLAIR"
          </p>
          {Array.isArray(value) && value.length > 0 && (
            <div className="mt-2">
              <p className="text-xs text-content-secondary">Preview:</p>
              <div className="flex flex-wrap gap-1 mt-1">
                {value.map((item: string, index: number) => (
                  <span key={index} className="inline-block px-2 py-1 bg-blue-500/10 text-blue-700 dark:text-blue-300 text-xs rounded">
                    "{item}"
                  </span>
                ))}
              </div>
            </div>
          )}
        </div>
      );

    case 'list_number':
      return (
        <div className={className}>
          <label className="block text-sm font-medium text-content-primary mb-2">
            Number List (comma-separated)
          </label>
          <input
            type="text"
            value={numberListInput}
            onChange={(e) => handleNumberListChange(e.target.value)}
            onBlur={handleNumberListBlur}
            disabled={disabled}
            placeholder={placeholder || '1.25, 1.25, 2.5'}
            className={`w-full px-3 py-2 border border-border-secondary rounded-md focus:ring-2 focus:ring-brand-500 focus:border-brand-500 text-content-primary ${
              disabled ? 'bg-surface-secondary cursor-not-allowed' : 'bg-surface-primary'
            }`}
          />
          <p className="mt-1 text-xs text-content-tertiary">
            Example: "1.25, 1.25" or "10, 20, 30"
          </p>
          {Array.isArray(value) && value.length > 0 && (
            <div className="mt-2">
              <p className="text-xs text-content-secondary">Preview:</p>
              <div className="flex flex-wrap gap-1 mt-1">
                {value.map((item: number, index: number) => (
                  <span key={index} className="inline-block px-2 py-1 bg-green-500/10 text-green-700 dark:text-green-300 text-xs rounded">
                    {item}
                  </span>
                ))}
              </div>
            </div>
          )}
        </div>
      );

    case 'json':
      return (
        <div className={className}>
          <label className="block text-sm font-medium text-content-primary mb-2">
            JSON Value
          </label>
          <textarea
            value={typeof value === 'string' ? value : JSON.stringify(value, null, 2)}
            onChange={(e) => handleJsonChange(e.target.value)}
            disabled={disabled}
            placeholder={placeholder || '{"key": "value"}'}
            rows={4}
            className={`w-full px-3 py-2 border border-border-secondary rounded-md focus:ring-2 focus:ring-brand-500 focus:border-brand-500 font-mono text-sm text-content-primary ${
              disabled ? 'bg-surface-secondary cursor-not-allowed' : 'bg-surface-primary'
            } ${jsonError ? 'border-red-500 focus:border-red-500' : ''}`}
          />
          {jsonError && (
            <p className="mt-1 text-xs text-red-600 dark:text-red-400">
              {jsonError}
            </p>
          )}
          <p className="mt-1 text-xs text-content-tertiary">
            Enter valid JSON for complex nested data structures
          </p>
        </div>
      );

    default:
      return (
        <div className={className}>
          <p className="text-sm text-content-tertiary">
            Unsupported data type: {dataType}
          </p>
        </div>
      );
  }
};

export default TypeSpecificInputs;