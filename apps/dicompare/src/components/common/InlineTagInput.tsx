import React, { useState, useRef, useEffect } from 'react';
import { X, Plus, FlaskConical } from 'lucide-react';
import { isAnalysisTag, getAnalysisTagDisplayName } from '../../utils/tagUtils';

interface InlineTagInputProps {
  tags: string[];
  onChange: (tags: string[]) => void;
  suggestions?: string[];
  placeholder?: string;
  disabled?: boolean;
}

/**
 * Compact inline tag input - tags are always visible as chips with an inline "+ Add" button
 * that expands to an input field when clicked.
 */
const InlineTagInput: React.FC<InlineTagInputProps> = ({
  tags,
  onChange,
  suggestions = [],
  placeholder = 'Add tag...',
  disabled = false
}) => {
  const [isAdding, setIsAdding] = useState(false);
  const [inputValue, setInputValue] = useState('');
  const [showSuggestions, setShowSuggestions] = useState(false);
  const [highlightedIndex, setHighlightedIndex] = useState(-1);
  const inputRef = useRef<HTMLInputElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  // Filter suggestions based on input and exclude already selected tags
  const filteredSuggestions = suggestions
    .filter(s => !tags.includes(s))
    .filter(s => s.toLowerCase().includes(inputValue.toLowerCase()))
    .slice(0, 8);

  const addTag = (tag: string) => {
    const trimmedTag = tag.trim();
    if (trimmedTag && !tags.includes(trimmedTag)) {
      onChange([...tags, trimmedTag]);
    }
    setInputValue('');
    setShowSuggestions(false);
    setHighlightedIndex(-1);
  };

  const removeTag = (tagToRemove: string) => {
    onChange(tags.filter(tag => tag !== tagToRemove));
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      if (highlightedIndex >= 0 && filteredSuggestions[highlightedIndex]) {
        addTag(filteredSuggestions[highlightedIndex]);
      } else if (inputValue.trim()) {
        addTag(inputValue);
      }
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      setHighlightedIndex(prev =>
        prev < filteredSuggestions.length - 1 ? prev + 1 : prev
      );
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setHighlightedIndex(prev => prev > 0 ? prev - 1 : -1);
    } else if (e.key === 'Escape') {
      setIsAdding(false);
      setInputValue('');
      setShowSuggestions(false);
      setHighlightedIndex(-1);
    } else if (e.key === 'Backspace' && !inputValue) {
      // Close input on backspace if empty
      setIsAdding(false);
    }
  };

  // Focus input when entering add mode
  useEffect(() => {
    if (isAdding && inputRef.current) {
      inputRef.current.focus();
    }
  }, [isAdding]);

  // Close when clicking outside
  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(event.target as Node)) {
        if (inputValue.trim()) {
          addTag(inputValue);
        }
        setIsAdding(false);
        setShowSuggestions(false);
      }
    };

    if (isAdding) {
      document.addEventListener('mousedown', handleClickOutside);
      return () => document.removeEventListener('mousedown', handleClickOutside);
    }
  }, [isAdding, inputValue]);

  // Sort tags: analysis tags first, then regular tags (both alphabetically)
  const sortedTags = [...tags].sort((a, b) => {
    const aIsAnalysis = isAnalysisTag(a);
    const bIsAnalysis = isAnalysisTag(b);
    if (aIsAnalysis && !bIsAnalysis) return -1;
    if (!aIsAnalysis && bIsAnalysis) return 1;
    return a.toLowerCase().localeCompare(b.toLowerCase());
  });

  return (
    <div ref={containerRef} className="flex flex-wrap items-center gap-1.5">
      {/* Existing tags as compact chips */}
      {sortedTags.map((tag, index) => {
        const isAnalysis = isAnalysisTag(tag);
        const displayName = isAnalysis ? getAnalysisTagDisplayName(tag) : tag;

        return (
          <span
            key={index}
            className={`inline-flex items-center pl-2 pr-1 py-0.5 rounded text-xs ${
              isAnalysis
                ? 'bg-purple-100 dark:bg-purple-900/30 text-purple-700 dark:text-purple-300'
                : 'bg-brand-100 dark:bg-brand-900/30 text-brand-700 dark:text-brand-300'
            }`}
          >
            {isAnalysis && <FlaskConical className="h-2.5 w-2.5 mr-0.5" />}
            {displayName}
            {!disabled && (
              <button
                type="button"
                onClick={() => removeTag(tag)}
                className={`ml-1 p-0.5 rounded ${
                  isAnalysis
                    ? 'hover:bg-purple-200 dark:hover:bg-purple-800/50 text-purple-600 dark:text-purple-400'
                    : 'hover:bg-brand-200 dark:hover:bg-brand-800/50 text-brand-600 dark:text-brand-400'
                }`}
              >
                <X className="h-2.5 w-2.5" />
              </button>
            )}
          </span>
        );
      })}

      {/* Add button / Input */}
      {!disabled && (
        isAdding ? (
          <div className="relative">
            <input
              ref={inputRef}
              type="text"
              value={inputValue}
              onChange={(e) => {
                setInputValue(e.target.value);
                setShowSuggestions(true);
                setHighlightedIndex(-1);
              }}
              onKeyDown={handleKeyDown}
              onBlur={() => {
                // Small delay to allow click on suggestion
                setTimeout(() => {
                  if (inputValue.trim()) {
                    addTag(inputValue);
                  }
                  setIsAdding(false);
                  setShowSuggestions(false);
                }, 150);
              }}
              className="w-24 px-2 py-0.5 text-xs border border-brand-300 dark:border-brand-700 rounded bg-surface-primary text-content-primary focus:outline-none focus:ring-1 focus:ring-brand-500"
              placeholder={placeholder}
            />

            {/* Autocomplete Dropdown */}
            {showSuggestions && filteredSuggestions.length > 0 && (
              <div className="absolute z-20 left-0 mt-1 w-40 bg-surface-primary border border-border-secondary rounded shadow-lg max-h-32 overflow-y-auto">
                {filteredSuggestions.map((suggestion, index) => (
                  <button
                    key={suggestion}
                    type="button"
                    onMouseDown={(e) => {
                      e.preventDefault();
                      addTag(suggestion);
                    }}
                    className={`w-full text-left px-2 py-1 text-xs hover:bg-surface-secondary ${
                      index === highlightedIndex ? 'bg-surface-secondary' : ''
                    }`}
                  >
                    <span className="text-content-primary">{suggestion}</span>
                  </button>
                ))}
              </div>
            )}
          </div>
        ) : (
          <button
            type="button"
            onClick={() => setIsAdding(true)}
            className="inline-flex items-center px-1.5 py-0.5 rounded text-xs border border-dashed border-content-muted text-content-tertiary hover:border-brand-400 hover:text-brand-600 dark:hover:text-brand-400 transition-colors"
          >
            <Plus className="h-2.5 w-2.5 mr-0.5" />
            Add
          </button>
        )
      )}

      {/* Show placeholder when no tags and not adding */}
      {tags.length === 0 && !isAdding && disabled && (
        <span className="text-xs text-content-tertiary italic">No tags</span>
      )}
    </div>
  );
};

export default InlineTagInput;
