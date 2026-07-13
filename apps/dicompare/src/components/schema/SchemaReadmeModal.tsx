import React, { useState, useEffect } from 'react';
import { X, FileText, List } from 'lucide-react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

export interface ReadmeItem {
  id: string;           // 'schema' or 'acquisition-{index}'
  type: 'schema' | 'acquisition';
  name: string;
  description: string;
  acquisitionIndex?: number;
}

interface SchemaReadmeModalProps {
  isOpen: boolean;
  onClose: () => void;
  schemaName: string;
  readmeItems: ReadmeItem[];
  initialSelection: string;
}

const SchemaReadmeModal: React.FC<SchemaReadmeModalProps> = ({
  isOpen,
  onClose,
  schemaName,
  readmeItems,
  initialSelection,
}) => {
  const [selectedId, setSelectedId] = useState(initialSelection);

  // Reset selection when modal opens with new data
  useEffect(() => {
    setSelectedId(initialSelection);
  }, [initialSelection, isOpen]);

  if (!isOpen) return null;

  const selectedItem = readmeItems.find(item => item.id === selectedId) || readmeItems[0];

  return (
    <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center p-4 z-50">
      <div className="bg-surface-primary rounded-lg w-full max-w-5xl h-[80vh] overflow-hidden flex flex-col">
        {/* Header */}
        <div className="px-6 py-4 border-b border-border flex items-center justify-between flex-shrink-0">
          <div className="flex items-center space-x-3">
            <h3 className="text-lg font-semibold text-content-primary">{schemaName}</h3>
            <span className="text-sm text-content-tertiary">Documentation</span>
          </div>
          <button
            onClick={onClose}
            className="p-1.5 text-content-tertiary hover:text-content-secondary rounded-md hover:bg-surface-secondary"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        {/* Body with sidebar and content */}
        <div className="flex-1 flex overflow-hidden">
          {/* Sidebar */}
          <div className="w-56 flex-shrink-0 border-r border-border overflow-y-auto bg-surface-secondary">
            <div className="p-2 space-y-1">
              {readmeItems.map((item) => (
                <button
                  key={item.id}
                  onClick={() => setSelectedId(item.id)}
                  className={`w-full text-left px-3 py-2 rounded-md transition-colors flex items-center ${
                    selectedId === item.id
                      ? 'bg-brand-100 dark:bg-brand-900/30 text-brand-700 dark:text-brand-300'
                      : 'text-content-secondary hover:bg-surface-hover hover:text-content-primary'
                  }`}
                >
                  {item.type === 'schema' ? (
                    <FileText className="h-4 w-4 mr-2 flex-shrink-0" />
                  ) : (
                    <List className="h-4 w-4 mr-2 flex-shrink-0" />
                  )}
                  <span className="truncate text-sm">{item.name}</span>
                </button>
              ))}
            </div>
          </div>

          {/* Content area */}
          <div className="flex-1 overflow-y-auto p-6">
            <div className="prose prose-sm max-w-none dark:prose-invert">
              {selectedItem?.description ? (
                <ReactMarkdown
                  remarkPlugins={[remarkGfm]}
                  components={{
                    // Custom styling for markdown elements (matching DetailedDescriptionModal)
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
                    a: ({ href, children }) => (
                      <a href={href} className="text-brand-600 hover:text-brand-700 dark:text-brand-400 dark:hover:text-brand-300 underline" target="_blank" rel="noopener noreferrer">
                        {children}
                      </a>
                    ),
                  }}
                >
                  {selectedItem.description}
                </ReactMarkdown>
              ) : (
                <div className="text-center py-12 text-content-tertiary">
                  <p>No detailed description available for this {selectedItem?.type === 'schema' ? 'schema' : 'acquisition'}.</p>
                </div>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};

export default SchemaReadmeModal;
