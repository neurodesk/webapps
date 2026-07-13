import React, { useState, useEffect, useRef, KeyboardEvent } from 'react';
import { searchDicomFields, type DicomFieldDefinition } from '../../services/dicomFieldService';

interface DicomFieldAutocompleteInputProps {
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  className?: string;
}

// Single-value text input with DICOM field lookup. Behaves like the "Add DICOM
// fields..." selector (searchable suggestions from the DICOM standard) but keeps
// whatever free text is typed, so non-standard/derived field names are accepted.
const DicomFieldAutocompleteInput = ({
  value,
  onChange,
  placeholder = 'Field name',
  className = ''
}: DicomFieldAutocompleteInputProps) => {
  const [suggestions, setSuggestions] = useState<DicomFieldDefinition[]>([]);
  const [isDropdownOpen, setIsDropdownOpen] = useState(false);
  const [isFocused, setIsFocused] = useState(false);
  const [selectedSuggestionIndex, setSelectedSuggestionIndex] = useState(-1);
  const [isLoading, setIsLoading] = useState(false);

  const inputRef = useRef<HTMLInputElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  // Debounced search on the current value, but only while the input is focused
  useEffect(() => {
    if (!isFocused) return;

    const delayedSearch = setTimeout(async () => {
      if (value.trim().length > 0) {
        setIsLoading(true);
        try {
          const results = await searchDicomFields(value, 10);
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
  }, [value, isFocused]);

  // Close dropdown on outside clicks
  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(event.target as Node)) {
        setIsDropdownOpen(false);
        setSelectedSuggestionIndex(-1);
      }
    };

    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  const selectField = (field: DicomFieldDefinition) => {
    // Validation functions reference DICOM keywords (e.g. "EchoTime") as
    // DataFrame column names, so insert the keyword rather than the tag.
    onChange(field.keyword || field.name);
    setSuggestions([]);
    setIsDropdownOpen(false);
    setSelectedSuggestionIndex(-1);
    inputRef.current?.focus();
  };

  const handleKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (!isDropdownOpen || suggestions.length === 0) return;

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
        // Only hijack Enter when the user is picking a highlighted suggestion.
        // Otherwise leave the typed value as-is (supports derived field names).
        if (selectedSuggestionIndex >= 0) {
          e.preventDefault();
          selectField(suggestions[selectedSuggestionIndex]);
        }
        break;

      case 'Escape':
        setIsDropdownOpen(false);
        setSelectedSuggestionIndex(-1);
        break;
    }
  };

  return (
    <div className="relative flex-1" ref={containerRef}>
      <div className="relative">
        <input
          ref={inputRef}
          type="text"
          value={value}
          onChange={(e) => {
            onChange(e.target.value);
            setSelectedSuggestionIndex(-1);
          }}
          onFocus={() => {
            setIsFocused(true);
            if (suggestions.length > 0) setIsDropdownOpen(true);
          }}
          onKeyDown={handleKeyDown}
          placeholder={placeholder}
          className={className}
        />
        {isLoading && (
          <div className="absolute right-2 top-1/2 -translate-y-1/2">
            <div className="animate-spin rounded-full h-4 w-4 border-b-2 border-brand-600"></div>
          </div>
        )}
      </div>

      {/* Suggestions Dropdown */}
      {isDropdownOpen && suggestions.length > 0 && (
        <div className="absolute z-20 w-full mt-1 bg-surface-primary border border-border rounded-md shadow-lg max-h-64 overflow-y-auto">
          {suggestions.map((field, index) => {
            const normalizedTag = field.tag.replace(/[()]/g, '');
            const keyword = field.keyword || field.name;

            return (
              <div
                key={field.tag}
                onMouseDown={(e) => {
                  // onMouseDown (not onClick) so selection wins the race with the
                  // input's blur/outside-click handler.
                  e.preventDefault();
                  selectField(field);
                }}
                className={`px-3 py-2 cursor-pointer border-b border-border last:border-b-0 ${
                  index === selectedSuggestionIndex
                    ? 'bg-blue-500/10 border-blue-500/20'
                    : 'hover:bg-surface-hover'
                }`}
              >
                <div className="flex items-center justify-between">
                  <div className="font-medium text-content-primary text-sm">{keyword}</div>
                  <div className="text-xs text-blue-600 dark:text-blue-400 font-mono">{normalizedTag}</div>
                </div>
                <div className="text-xs text-content-tertiary mt-0.5">{field.name}</div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
};

export default DicomFieldAutocompleteInput;
