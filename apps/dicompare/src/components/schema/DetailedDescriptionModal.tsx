import React, { useState, useEffect, useRef } from 'react';
import { X, Edit2, Eye } from 'lucide-react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import MarkdownToolbar from '../common/MarkdownToolbar';
import { markdownComponents } from '../../utils/markdownRenderers';
import { handleMarkdownListContinuation } from '../../utils/markdownEditor';
import { handleTableTab } from '../../utils/tableEditor';

interface DetailedDescriptionModalProps {
  isOpen: boolean;
  onClose: () => void;
  title: string;
  description: string;
  onSave?: (description: string) => void;
  isReadOnly?: boolean;
  /** Other acquisition names in this schema, for the "Link to acquisition" tool. */
  acquisitionNames?: string[];
  /** Called when an internal #acq link is clicked in the preview. */
  onNavigateToAcquisition?: (name: string) => void;
}

const DetailedDescriptionModal: React.FC<DetailedDescriptionModalProps> = ({
  isOpen,
  onClose,
  title,
  description,
  onSave,
  isReadOnly = false,
  acquisitionNames = [],
  onNavigateToAcquisition,
}) => {
  const [activeTab, setActiveTab] = useState<'preview' | 'edit'>('preview');
  const [editedDescription, setEditedDescription] = useState(description);
  const lastSavedRef = useRef(description);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const otherAcquisitions = acquisitionNames.filter((n) => n !== title);

  useEffect(() => {
    setEditedDescription(description);
    lastSavedRef.current = description;
    // Default to edit tab if description is empty and not read-only, otherwise preview
    setActiveTab(!isReadOnly && !description ? 'edit' : 'preview');
  }, [description, isReadOnly]);

  // Auto-save when switching tabs or closing
  const saveIfChanged = () => {
    if (onSave && editedDescription !== lastSavedRef.current) {
      onSave(editedDescription);
      lastSavedRef.current = editedDescription;
    }
  };

  if (!isOpen) return null;

  const handleTabChange = (tab: 'preview' | 'edit') => {
    if (tab !== activeTab) {
      // Save when leaving edit tab
      if (activeTab === 'edit') {
        saveIfChanged();
      }
      setActiveTab(tab);
    }
  };

  const handleClose = () => {
    // Auto-save on close
    saveIfChanged();
    onClose();
  };

  return (
    <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center p-4 z-50">
      <div className="bg-surface-primary rounded-lg max-w-4xl w-full h-[80vh] overflow-hidden flex flex-col">
        {/* Header */}
        <div className="px-6 py-4 border-b border-border flex items-center justify-between flex-shrink-0">
          <div>
            <h3 className="text-lg font-semibold text-content-primary">{title}</h3>
            <span className="text-sm text-content-tertiary">README</span>
          </div>
          <button
            onClick={handleClose}
            className="p-1.5 text-content-tertiary hover:text-content-secondary rounded-md hover:bg-surface-secondary"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        {/* Tabs - underline style */}
        {!isReadOnly && (
          <div className="flex border-b border-border px-6">
            <button
              onClick={() => handleTabChange('edit')}
              className={`px-4 py-2 text-sm font-medium border-b-2 transition-colors ${
                activeTab === 'edit'
                  ? 'border-brand-600 text-brand-600'
                  : 'border-transparent text-content-tertiary hover:text-content-secondary'
              }`}
            >
              <Edit2 className="h-3.5 w-3.5 inline mr-1.5" />
              Edit
            </button>
            <button
              onClick={() => handleTabChange('preview')}
              className={`px-4 py-2 text-sm font-medium border-b-2 transition-colors ${
                activeTab === 'preview'
                  ? 'border-brand-600 text-brand-600'
                  : 'border-transparent text-content-tertiary hover:text-content-secondary'
              }`}
            >
              <Eye className="h-3.5 w-3.5 inline mr-1.5" />
              Preview
            </button>
          </div>
        )}

        {/* Content */}
        <div className="flex-1 overflow-auto p-6">
          {activeTab === 'edit' && !isReadOnly ? (
            <div className="h-full flex flex-col">
              <div className="text-xs text-content-tertiary mb-2">
                Supports GitHub-flavored Markdown (headings, lists, tables, code blocks, etc.)
              </div>
              <MarkdownToolbar
                textareaRef={textareaRef}
                value={editedDescription}
                onChange={setEditedDescription}
                acquisitionNames={otherAcquisitions}
              />
              <textarea
                ref={textareaRef}
                value={editedDescription}
                onChange={(e) => setEditedDescription(e.target.value)}
                onKeyDown={(e) => {
                  if (!handleTableTab(e, editedDescription, setEditedDescription)) {
                    handleMarkdownListContinuation(e, editedDescription, setEditedDescription);
                  }
                }}
                className="flex-1 w-full min-h-[400px] p-4 border border-border-secondary rounded-b-lg font-mono text-sm bg-surface-primary text-content-primary focus:outline-none focus:ring-2 focus:ring-brand-500 focus:border-brand-500 resize-none"
                placeholder="Enter a detailed description using Markdown...

## Overview
Describe the acquisition sequence here.

### Key Parameters
- Parameter 1: Description
- Parameter 2: Description

### Clinical Purpose
Explain the clinical use case.

### Technical Notes
Add any technical details or vendor-specific information."
              />
            </div>
          ) : (
            <div className="prose prose-sm max-w-none dark:prose-invert">
              {editedDescription ? (
                <ReactMarkdown
                  remarkPlugins={[remarkGfm]}
                  components={{
                    // Custom styling for markdown elements
                    h1: ({ children }) => <h1 className="text-2xl font-bold text-content-primary mb-4 pb-2 border-b border-border">{children}</h1>,
                    h2: ({ children }) => <h2 className="text-xl font-semibold text-content-primary mt-6 mb-3">{children}</h2>,
                    h3: ({ children }) => <h3 className="text-lg font-semibold text-content-primary mt-4 mb-2">{children}</h3>,
                    h4: ({ children }) => <h4 className="text-base font-semibold text-content-primary mt-3 mb-2">{children}</h4>,
                    p: ({ children }) => <p className="text-content-secondary mb-3 leading-relaxed">{children}</p>,
                    ul: ({ children }) => <ul className="list-disc list-inside mb-3 space-y-1 text-content-secondary">{children}</ul>,
                    ol: ({ children }) => <ol className="list-decimal list-inside mb-3 space-y-1 text-content-secondary">{children}</ol>,
                    li: ({ children }) => <li className="ml-2">{children}</li>,
                    strong: ({ children }) => <strong className="font-semibold text-content-primary">{children}</strong>,
                    code: ({ className, children, ...props }) => {
                      const isInline = !className;
                      if (isInline) {
                        return <code className="bg-surface-secondary text-brand-600 dark:text-brand-400 px-1.5 py-0.5 rounded text-sm font-mono">{children}</code>;
                      }
                      return (
                        <code className={`${className} block bg-gray-900 text-gray-100 p-4 rounded-lg text-sm font-mono overflow-x-auto`} {...props}>
                          {children}
                        </code>
                      );
                    },
                    pre: ({ children }) => <pre className="mb-4">{children}</pre>,
                    blockquote: ({ children }) => (
                      <blockquote className="border-l-4 border-brand-500 pl-4 py-1 my-3 text-content-secondary italic bg-surface-secondary rounded-r">
                        {children}
                      </blockquote>
                    ),
                    table: ({ children }) => (
                      <div className="overflow-x-auto mb-4">
                        <table className="min-w-full divide-y divide-border border border-border rounded-lg">
                          {children}
                        </table>
                      </div>
                    ),
                    thead: ({ children }) => <thead className="bg-surface-secondary">{children}</thead>,
                    th: ({ children }) => <th className="px-4 py-2 text-left text-xs font-semibold text-content-secondary uppercase tracking-wider">{children}</th>,
                    td: ({ children }) => <td className="px-4 py-2 text-sm text-content-secondary border-t border-border">{children}</td>,
                    hr: () => <hr className="my-6 border-border" />,
                    a: markdownComponents(onNavigateToAcquisition).a,
                  }}
                >
                  {editedDescription}
                </ReactMarkdown>
              ) : (
                <div className="text-center py-12 text-content-tertiary">
                  <p className="mb-2">No detailed description available.</p>
                  {!isReadOnly && (
                    <button
                      onClick={() => setActiveTab('edit')}
                      className="text-brand-600 hover:text-brand-700 dark:text-brand-400 dark:hover:text-brand-300 underline"
                    >
                      Click to add one
                    </button>
                  )}
                </div>
              )}
            </div>
          )}
        </div>

      </div>
    </div>
  );
};

export default DetailedDescriptionModal;
