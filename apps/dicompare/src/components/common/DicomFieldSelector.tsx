import React, { useState, useEffect, useRef, KeyboardEvent } from 'react';
import { searchDicomFields, type DicomFieldDefinition } from '../../services/dicomFieldService';

interface DicomFieldSelectorProps {
  selectedFields: string[];
  onFieldsChange: (fields: string[]) => void;
  placeholder?: string;
  maxSelections?: number;
  showCategories?: boolean;
  showSuggestions?: boolean;
  className?: string;
}

const DicomFieldSelector = ({
  selectedFields,
  onFieldsChange,
  placeholder = "Search DICOM fields by name or tag...",
  maxSelections,
  showCategories = true,
  showSuggestions = true,
  className = ""
}: DicomFieldSelectorProps) => {
  const [searchTerm, setSearchTerm] = useState('');
  const [suggestions, setSuggestions] = useState<DicomFieldDefinition[]>([]);
  const [isDropdownOpen, setIsDropdownOpen] = useState(false);
  const [selectedSuggestionIndex, setSelectedSuggestionIndex] = useState(-1);
  const [isLoading, setIsLoading] = useState(false);

  const inputRef = useRef<HTMLInputElement>(null);
  const dropdownRef = useRef<HTMLDivElement>(null);

  // Debounced search effect
  useEffect(() => {
    const delayedSearch = setTimeout(async () => {
      if (searchTerm.trim().length > 0) {
        setIsLoading(true);
        try {
          // Use local DICOM field service for instant search
          const results = await searchDicomFields(searchTerm, 10);
          setSuggestions(results);
          setIsDropdownOpen(true);
        } catch (error) {
          console.error('Error searching DICOM fields:', error);
          setSuggestions([]);
        } finally {
          setIsLoading(false);
        }
      } else {
        setSuggestions([]);
        setIsDropdownOpen(false);
      }
    }, 300);

    return () => clearTimeout(delayedSearch);
  }, [searchTerm]);

  // Handle outside clicks to close dropdown
  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (dropdownRef.current && !dropdownRef.current.contains(event.target as Node)) {
        setIsDropdownOpen(false);
        setSelectedSuggestionIndex(-1);
      }
    };

    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  const handleFieldSelect = (field: DicomFieldDefinition) => {
    // Convert field.tag format from "(0018,0081)" or "0018,0081" to "0018,0081"
    const normalizedTag = field.tag.replace(/[()]/g, '');
    if (!selectedFields.includes(normalizedTag) && (!maxSelections || selectedFields.length < maxSelections)) {
      onFieldsChange([...selectedFields, normalizedTag]);
    }
    setSearchTerm('');
    setSuggestions([]);
    setIsDropdownOpen(false);
    setSelectedSuggestionIndex(-1);
    inputRef.current?.focus();
  };

  const handleFieldRemove = (fieldTag: string) => {
    onFieldsChange(selectedFields.filter(tag => tag !== fieldTag));
  };

  // Helper to add custom field directly
  const addCustomField = () => {
    const trimmedValue = searchTerm.trim();
    if (trimmedValue && !selectedFields.includes(trimmedValue)) {
      onFieldsChange([...selectedFields, trimmedValue]);
    }
    setSearchTerm('');
    setIsDropdownOpen(false);
    setSelectedSuggestionIndex(-1);
    inputRef.current?.focus();
  };

  const handleKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (!isDropdownOpen || suggestions.length === 0) {
      if (e.key === 'Enter' && searchTerm.trim()) {
        e.preventDefault();
        addCustomField();
      }
      return;
    }

    switch (e.key) {
      case 'ArrowDown':
        e.preventDefault();
        setSelectedSuggestionIndex(prev =>
          prev < suggestions.length - 1 ? prev + 1 : 0
        );
        break;

      case 'ArrowUp':
        e.preventDefault();
        setSelectedSuggestionIndex(prev =>
          prev > 0 ? prev - 1 : suggestions.length - 1
        );
        break;

      case 'Enter':
        e.preventDefault();
        if (selectedSuggestionIndex >= 0) {
          // Select highlighted suggestion
          handleFieldSelect(suggestions[selectedSuggestionIndex]);
        } else if (searchTerm.trim()) {
          // No suggestion selected - add custom field directly
          addCustomField();
        }
        break;

      case 'Escape':
        setIsDropdownOpen(false);
        setSelectedSuggestionIndex(-1);
        break;
    }
  };

  return (
    <div className={`relative ${className}`}>
      {/* Selected Fields Display */}
      {selectedFields.length > 0 && (
        <div className="mb-4">
          <div className="flex flex-wrap gap-2">
            {selectedFields.map((fieldTag) => (
              <SelectedFieldTag
                key={fieldTag}
                fieldTag={fieldTag}
                onRemove={() => handleFieldRemove(fieldTag)}
              />
            ))}
          </div>
        </div>
      )}

      {/* Search Input */}
      <div className="relative" ref={dropdownRef}>
        <div className="relative">
          <input
            ref={inputRef}
            type="text"
            value={searchTerm}
            onChange={(e) => setSearchTerm(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder={placeholder}
            className="w-full px-4 py-2 border border-border-secondary rounded-md bg-surface-primary text-content-primary focus:ring-2 focus:ring-brand-500 focus:border-brand-500 pr-10 placeholder:text-content-tertiary"
          />
          {isLoading && (
            <div className="absolute right-3 top-2.5">
              <div className="animate-spin rounded-full h-5 w-5 border-b-2 border-brand-600"></div>
            </div>
          )}
        </div>

        {/* Suggestions Dropdown */}
        {isDropdownOpen && suggestions.length > 0 && (
          <div className="absolute z-20 w-full mt-1 bg-surface-primary border border-border rounded-md shadow-lg max-h-64 overflow-y-auto">
            {suggestions.map((field, index) => {
              const normalizedTag = field.tag.replace(/[()]/g, '');

              return (
                <div
                  key={field.tag}
                  onClick={() => handleFieldSelect(field)}
                  className={`px-4 py-3 cursor-pointer border-b border-border last:border-b-0 ${
                    index === selectedSuggestionIndex
                      ? 'bg-blue-500/10 border-blue-500/20'
                      : 'hover:bg-surface-hover'
                  } ${selectedFields.includes(normalizedTag) ? 'opacity-50 cursor-not-allowed' : ''}`}
                >
                  <div className="flex justify-between items-start">
                    <div className="flex-1">
                      <div className="font-medium text-content-primary">{field.name}</div>
                      <div className="flex items-center space-x-2 mt-1">
                        <div className="text-sm text-blue-600 dark:text-blue-400 font-mono">{normalizedTag}</div>
                        {field.keyword && (
                          <div className="text-xs text-content-secondary bg-surface-secondary px-1.5 py-0.5 rounded">
                            {field.keyword}
                          </div>
                        )}
                      </div>
                      <div className="flex items-center space-x-2 text-xs text-content-tertiary mt-1">
                        <span>VR: {field.valueRepresentation || field.vr}</span>
                        {field.valueMultiplicity && (
                          <span>VM: {field.valueMultiplicity}</span>
                        )}
                      </div>
                      {field.description && (
                        <div className="text-xs text-content-tertiary mt-1 line-clamp-2">
                          {field.description}
                        </div>
                      )}
                    </div>
                  </div>
                </div>
              );
            })}

            {/* Add Custom Field Option */}
            <div className="px-4 py-2 border-t border-border bg-surface-secondary">
              <button
                onClick={addCustomField}
                className="text-sm text-blue-600 hover:text-blue-700 dark:text-blue-400 dark:hover:text-blue-300"
              >
                + Add "{searchTerm}" as custom field
              </button>
            </div>
          </div>
        )}

        {/* No Results */}
        {isDropdownOpen && !isLoading && searchTerm.length > 0 && suggestions.length === 0 && (
          <div className="absolute z-20 w-full mt-1 bg-surface-primary border border-border rounded-md shadow-lg">
            <div className="px-4 py-3 text-content-secondary text-center">
              No fields found for "{searchTerm}"
              <button
                onClick={addCustomField}
                className="block w-full text-blue-600 hover:text-blue-700 dark:text-blue-400 dark:hover:text-blue-300 mt-2"
              >
                Add "{searchTerm}" as custom field
              </button>
            </div>
          </div>
        )}
      </div>

      {/* Field Count Display */}
      {maxSelections && (
        <div className="mt-2 text-sm text-gray-500">
          {selectedFields.length} of {maxSelections} fields selected
        </div>
      )}
    </div>
  );
};

// Component for displaying selected field tags
const SelectedFieldTag = ({ fieldTag, onRemove }: { fieldTag: string; onRemove: () => void }) => {
  const [displayName, setDisplayName] = useState(fieldTag);

  useEffect(() => {
    const loadFieldName = async () => {
      try {
        const results = await searchDicomFields(fieldTag, 1);
        const field = results.find(f => f.tag.replace(/[()]/g, '') === fieldTag);
        if (field) {
          setDisplayName(field.name);
        }
      } catch (error) {
        // Keep the tag as display name if lookup fails
      }
    };
    loadFieldName();
  }, [fieldTag]);

  return (
    <span className="inline-flex items-center gap-1 px-3 py-1 bg-blue-500/10 text-blue-700 dark:text-blue-300 rounded-full text-sm">
      <span className="font-medium">{displayName}</span>
      <span className="text-blue-600 dark:text-blue-400 font-mono text-xs">({fieldTag})</span>
      <button
        onClick={onRemove}
        className="ml-1 text-blue-600 hover:text-blue-700 dark:text-blue-400 dark:hover:text-blue-300 focus:outline-none p-0.5 rounded-full hover:bg-blue-500/20"
        aria-label={`Remove ${displayName}`}
      >
        <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
        </svg>
      </button>
    </span>
  );
};

export default DicomFieldSelector;