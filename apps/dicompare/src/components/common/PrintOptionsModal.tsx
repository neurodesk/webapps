import React, { useState } from 'react';
import { X, Printer, FileDown } from 'lucide-react';
import { PrintSectionOptions } from '../../utils/printReportGenerator';

type SectionKey = 'header' | 'readme' | 'schemaImages' | 'referenceDicoms' | 'testDicoms' | 'testNotes' | 'validationRules' | 'fieldsTable' | 'seriesTable' | 'uncheckedFields' | 'uncheckedSeriesFields';

interface SectionDef {
  key: SectionKey;
  label: string;
  group?: string;
}

interface PrintOptionsModalProps {
  isOpen: boolean;
  onClose: () => void;
  onPrint: (options: PrintSectionOptions) => void;
  /** Which sections are available in this context */
  availableSections: SectionKey[];
  /** Whether to show image-specific controls */
  hasImages?: boolean;
  /** Schema images for individual selection */
  schemaImages?: { label: string; url: string }[];
  /** Label for the print button */
  printLabel?: string;
  /** Whether print is in progress */
  isPrinting?: boolean;
}

const SECTION_LABELS: Record<SectionKey, string> = {
  header: 'Header',
  readme: 'Reference Description',
  schemaImages: 'Schema Images',
  referenceDicoms: 'Reference DICOMs',
  testDicoms: 'Test DICOMs',
  testNotes: 'Test Data Description',
  validationRules: 'Validation Rules',
  fieldsTable: 'Fields Table',
  seriesTable: 'Series Table',
  uncheckedFields: 'Unchecked Fields',
  uncheckedSeriesFields: 'Unchecked Series Fields',
};

const IMAGE_SECTIONS: SectionKey[] = ['schemaImages', 'referenceDicoms', 'testDicoms'];

const SCALE_OPTIONS = [
  { value: 0.5, label: 'Small' },
  { value: 0.75, label: 'Medium' },
  { value: 1, label: 'Default' },
  { value: 1.5, label: 'Large' },
  { value: 2, label: 'Extra Large' },
];

const COLUMN_OPTIONS = [
  { value: 0, label: 'Auto' },
  { value: 1, label: '1' },
  { value: 2, label: '2' },
  { value: 3, label: '3' },
];

const PrintOptionsModal: React.FC<PrintOptionsModalProps> = ({
  isOpen,
  onClose,
  onPrint,
  availableSections,
  hasImages = false,
  schemaImages,
  printLabel = 'Print',
  isPrinting = false,
}) => {
  // All sections enabled by default
  const [enabled, setEnabled] = useState<Record<string, boolean>>(() => {
    const init: Record<string, boolean> = {};
    availableSections.forEach(k => { init[k] = true; });
    return init;
  });

  const [imageScale, setImageScale] = useState(1);
  const [imageColumns, setImageColumns] = useState(0);
  const [selectedSchemaImages, setSelectedSchemaImages] = useState<Set<number>>(() =>
    new Set(schemaImages?.map((_, i) => i) ?? [])
  );

  if (!isOpen) return null;

  const toggle = (key: string) => {
    setEnabled(prev => ({ ...prev, [key]: !prev[key] }));
  };

  const toggleSchemaImage = (index: number) => {
    setSelectedSchemaImages(prev => {
      const next = new Set(prev);
      if (next.has(index)) next.delete(index);
      else next.add(index);
      return next;
    });
  };

  const handlePrint = () => {
    const options: PrintSectionOptions = {};
    availableSections.forEach(k => {
      (options as any)[k] = enabled[k] ?? true;
    });
    if (imageScale !== 1) options.imageScale = imageScale;
    if (imageColumns !== 0) options.imageColumns = imageColumns;
    if (schemaImages && schemaImages.length > 0 && selectedSchemaImages.size < schemaImages.length) {
      options.selectedSchemaImages = Array.from(selectedSchemaImages).sort((a, b) => a - b);
    }
    onPrint(options);
  };

  const contentSections = availableSections.filter(k => !IMAGE_SECTIONS.includes(k));
  const imageSections = availableSections.filter(k => IMAGE_SECTIONS.includes(k));
  const showImageControls = hasImages || imageSections.length > 0;

  const getFilename = (url: string) => {
    try { return url.split('/').pop() || url; } catch { return url; }
  };

  return (
    <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center p-4 z-50">
      <div className="bg-surface-primary rounded-lg shadow-xl w-full max-w-md max-h-[80vh] flex flex-col">
        {/* Header */}
        <div className="px-5 py-3 border-b border-border flex items-center justify-between flex-shrink-0">
          <h3 className="text-sm font-semibold text-content-primary">Print Options</h3>
          <button onClick={onClose} className="p-1 text-content-tertiary hover:text-content-secondary rounded">
            <X className="h-4 w-4" />
          </button>
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto px-5 py-4 space-y-5">
          {/* Content sections */}
          <div>
            <div className="text-[10px] font-semibold uppercase tracking-wider text-content-tertiary mb-2">Sections</div>
            <div className="space-y-1">
              {contentSections.map(key => (
                <label key={key} className="flex items-center gap-2 py-1 cursor-pointer select-none">
                  <input
                    type="checkbox"
                    checked={enabled[key] ?? true}
                    onChange={() => toggle(key)}
                    className="rounded border-border-secondary text-brand-600 focus:ring-brand-500 h-3.5 w-3.5"
                  />
                  <span className="text-xs text-content-primary">{SECTION_LABELS[key]}</span>
                </label>
              ))}
            </div>
          </div>

          {/* Image sections */}
          {showImageControls && (
            <div>
              <div className="text-[10px] font-semibold uppercase tracking-wider text-content-tertiary mb-2">Images</div>
              <div className="space-y-1">
                {imageSections.map(key => (
                  <div key={key}>
                    <label className="flex items-center gap-2 py-1 cursor-pointer select-none">
                      <input
                        type="checkbox"
                        checked={enabled[key] ?? true}
                        onChange={() => toggle(key)}
                        className="rounded border-border-secondary text-brand-600 focus:ring-brand-500 h-3.5 w-3.5"
                      />
                      <span className="text-xs text-content-primary">{SECTION_LABELS[key]}</span>
                    </label>
                    {/* Individual schema image selection */}
                    {key === 'schemaImages' && enabled[key] && schemaImages && schemaImages.length > 0 && (
                      <div className="ml-6 mt-1 space-y-0.5">
                        {schemaImages.map((img, i) => (
                          <label key={i} className="flex items-center gap-2 py-0.5 cursor-pointer select-none">
                            <input
                              type="checkbox"
                              checked={selectedSchemaImages.has(i)}
                              onChange={() => toggleSchemaImage(i)}
                              className="rounded border-border-secondary text-brand-600 focus:ring-brand-500 h-3 w-3"
                            />
                            <span className="text-[11px] text-content-secondary truncate">
                              {img.label || getFilename(img.url) || `Image ${i + 1}`}
                            </span>
                          </label>
                        ))}
                      </div>
                    )}
                  </div>
                ))}
              </div>

              {/* Image display options */}
              <div className="mt-3 pt-3 border-t border-border space-y-3">
                <div>
                  <div className="text-[10px] font-medium text-content-tertiary mb-1.5">Image Size</div>
                  <div className="flex items-center gap-0.5 bg-surface-secondary rounded-md p-0.5 border border-border-secondary">
                    {SCALE_OPTIONS.map(opt => (
                      <button
                        key={opt.value}
                        onClick={() => setImageScale(opt.value)}
                        className={`flex-1 px-1.5 py-1 text-[10px] font-medium rounded transition-colors ${
                          imageScale === opt.value
                            ? 'bg-brand-600 text-white'
                            : 'text-content-secondary hover:text-content-primary'
                        }`}
                      >
                        {opt.label}
                      </button>
                    ))}
                  </div>
                </div>
                <div>
                  <div className="text-[10px] font-medium text-content-tertiary mb-1.5">Columns</div>
                  <div className="flex items-center gap-0.5 bg-surface-secondary rounded-md p-0.5 border border-border-secondary">
                    {COLUMN_OPTIONS.map(opt => (
                      <button
                        key={opt.value}
                        onClick={() => setImageColumns(opt.value)}
                        className={`flex-1 px-2 py-1 text-[10px] font-medium rounded transition-colors ${
                          imageColumns === opt.value
                            ? 'bg-brand-600 text-white'
                            : 'text-content-secondary hover:text-content-primary'
                        }`}
                      >
                        {opt.label}
                      </button>
                    ))}
                  </div>
                </div>
              </div>
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="px-5 py-3 border-t border-border flex items-center justify-end gap-2 flex-shrink-0">
          <button
            onClick={onClose}
            className="px-3 py-1.5 text-xs font-medium text-content-secondary border border-border-secondary rounded hover:bg-surface-secondary transition-colors"
          >
            Cancel
          </button>
          <button
            onClick={handlePrint}
            disabled={isPrinting}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-white bg-brand-600 hover:bg-brand-700 disabled:opacity-50 disabled:cursor-not-allowed rounded transition-colors"
          >
            {isPrinting ? (
              <>Generating...</>
            ) : (
              <>
                <Printer className="h-3 w-3" />
                {printLabel}
              </>
            )}
          </button>
        </div>
      </div>
    </div>
  );
};

export default PrintOptionsModal;
