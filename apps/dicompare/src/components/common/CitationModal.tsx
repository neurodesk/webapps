import React from 'react';
import { X, Copy, Check } from 'lucide-react';
import { VERSION } from '../../version';

interface CitationModalProps {
  isOpen: boolean;
  onClose: () => void;
  /** Optional schema citation block (shown when viewing a schema with a DOI). */
  schema?: {
    name: string;
    version?: string;
    authors?: string[];
    conceptDoi: string;
  };
}

const CITATION_TEXT = `Ashley Wilton Stewart, Gabriele Amorosino, Jelle Veraart, Anibal S. Heinsfeld, Steffen Bollmann, Franco Pestilli. dicompare v${VERSION} [Computer software]. https://github.com/astewartau/dicompare-web`;

const copyText = async (text: string, setCopied: (v: boolean) => void) => {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    const textarea = document.createElement('textarea');
    textarea.value = text;
    document.body.appendChild(textarea);
    textarea.select();
    document.execCommand('copy');
    document.body.removeChild(textarea);
  }
  setCopied(true);
  setTimeout(() => setCopied(false), 2000);
};

const buildSchemaCitation = (schema: NonNullable<CitationModalProps['schema']>): string => {
  const authors = schema.authors && schema.authors.length > 0 ? schema.authors.join(', ') : 'dicompare';
  const version = schema.version ? ` v${schema.version}` : '';
  return `${authors}. ${schema.name}${version} [Data set]. Zenodo. https://doi.org/${schema.conceptDoi}`;
};

const CitationModal: React.FC<CitationModalProps> = ({ isOpen, onClose, schema }) => {
  const [copied, setCopied] = React.useState(false);
  const [copiedSchema, setCopiedSchema] = React.useState(false);

  if (!isOpen) return null;

  const handleCopy = () => copyText(CITATION_TEXT, setCopied);
  const schemaCitation = schema ? buildSchemaCitation(schema) : null;

  return (
    <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center p-4 z-50" onClick={onClose}>
      <div
        className="bg-surface-primary rounded-lg shadow-xl max-w-lg w-full max-h-[70vh] flex flex-col overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-border">
          <h3 className="text-lg font-semibold text-content-primary">Cite dicompare</h3>
          <button
            onClick={onClose}
            className="p-1.5 text-content-tertiary hover:text-content-primary hover:bg-surface-secondary rounded-lg transition-colors"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        {/* Body */}
        <div className="px-6 py-5 space-y-5 overflow-y-auto">
          {/* Citation block */}
          <div>
            <div className="flex items-center justify-between mb-2">
              <span className="text-xs font-medium text-content-tertiary uppercase tracking-wider">Citation</span>
              <button
                onClick={handleCopy}
                className="inline-flex items-center gap-1 px-2 py-1 text-xs text-content-secondary hover:text-content-primary hover:bg-surface-secondary rounded transition-colors"
              >
                {copied ? <Check className="h-3 w-3 text-green-500" /> : <Copy className="h-3 w-3" />}
                {copied ? 'Copied' : 'Copy'}
              </button>
            </div>
            <div className="bg-surface-secondary border border-border rounded-md p-4 text-sm text-content-secondary leading-relaxed font-mono">
              {CITATION_TEXT}
            </div>
          </div>

          {/* Schema citation (when viewing a schema with a published DOI) */}
          {schemaCitation && (
            <div>
              <div className="flex items-center justify-between mb-2">
                <span className="text-xs font-medium text-content-tertiary uppercase tracking-wider">Cite this schema</span>
                <button
                  onClick={() => copyText(schemaCitation, setCopiedSchema)}
                  className="inline-flex items-center gap-1 px-2 py-1 text-xs text-content-secondary hover:text-content-primary hover:bg-surface-secondary rounded transition-colors"
                >
                  {copiedSchema ? <Check className="h-3 w-3 text-green-500" /> : <Copy className="h-3 w-3" />}
                  {copiedSchema ? 'Copied' : 'Copy'}
                </button>
              </div>
              <div className="bg-surface-secondary border border-border rounded-md p-4 text-sm text-content-secondary leading-relaxed font-mono">
                {schemaCitation}
              </div>
            </div>
          )}

          {/* Authors */}
          <div>
            <span className="text-xs font-medium text-content-tertiary uppercase tracking-wider">Authors</span>
            <div className="mt-2 text-sm text-content-primary leading-relaxed">
              <p>
                Ashley Wilton Stewart<sup>1,2</sup>,
                Gabriele Amorosino<sup>1</sup>,
                Jelle Veraart<sup>3</sup>,
                Anibal S. Heinsfeld<sup>1</sup>,
                Steffen Bollmann<sup>2,4</sup>,
                Franco Pestilli<sup>1</sup>
              </p>
            </div>
            <div className="mt-3 text-xs text-content-tertiary leading-relaxed space-y-0.5">
              <p><sup>1</sup> Department of Psychology, University of Texas at Austin, Austin TX, USA</p>
              <p><sup>2</sup> School of Electrical Engineering and Computer Science, The University of Queensland, Brisbane QLD, Australia</p>
              <p><sup>3</sup> NYU Grossman School of Medicine, New York University, New York, NY, USA</p>
              <p><sup>4</sup> Queensland Digital Health Centre, The University of Queensland, Brisbane QLD, Australia</p>
            </div>
          </div>

          {/* Collaboration acknowledgement */}
          <div className="border-t border-border pt-4">
            <span className="text-xs font-medium text-content-tertiary uppercase tracking-wider">Acknowledgements</span>
            <p className="mt-2 text-sm text-content-secondary leading-relaxed">
              dicompare is a collaboration between{' '}
              <a href="https://brainlife.io" target="_blank" rel="noopener noreferrer" className="text-brand-600 hover:text-brand-700 underline">
                Pestilli Lab / brainlife.io
              </a>
              {' '}and the{' '}
              <a href="https://neurodesk.org" target="_blank" rel="noopener noreferrer" className="text-brand-600 hover:text-brand-700 underline">
                Bollmann Lab / Neurodesk
              </a>.
            </p>
          </div>

          {/* Source code links */}
          <div className="border-t border-border pt-4">
            <span className="text-xs font-medium text-content-tertiary uppercase tracking-wider">Source Code</span>
            <div className="mt-2 text-sm text-content-secondary space-y-1">
              <p>
                <a
                  href="https://github.com/astewartau/dicompare-web"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-brand-600 hover:text-brand-700 underline"
                >
                  github.com/astewartau/dicompare-web
                </a>
                <span className="text-content-tertiary"> — web application</span>
              </p>
              <p>
                <a
                  href="https://github.com/astewartau/dicompare"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-brand-600 hover:text-brand-700 underline"
                >
                  github.com/astewartau/dicompare
                </a>
                <span className="text-content-tertiary"> — Python package</span>
              </p>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};

export default CitationModal;
