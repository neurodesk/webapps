import React, { useState } from 'react';
import { ChevronDown } from 'lucide-react';
import { DicomField } from '../../../types';

interface UncheckedFieldsDisplayProps {
  uncheckedFields: DicomField[];
}

/**
 * Collapsible display of fields in the real data that aren't validated by the schema.
 * Shows in compliance mode when there are fields in the data not defined in the schema.
 */
const UncheckedFieldsDisplay: React.FC<UncheckedFieldsDisplayProps> = ({
  uncheckedFields,
}) => {
  const [showUncheckedFields, setShowUncheckedFields] = useState(false);

  if (uncheckedFields.length === 0) {
    return null;
  }

  return (
    <div className="border border-border-secondary rounded-md overflow-hidden">
      <button
        onClick={() => setShowUncheckedFields(!showUncheckedFields)}
        className="w-full px-3 py-2 bg-surface-secondary hover:bg-surface-tertiary transition-colors flex items-center justify-between text-left"
      >
        <span className="text-xs text-content-tertiary">
          <span className="font-medium">{uncheckedFields.length} field{uncheckedFields.length !== 1 ? 's' : ''}</span> in data not validated by schema
        </span>
        <ChevronDown className={`h-4 w-4 text-content-tertiary transition-transform ${showUncheckedFields ? 'rotate-180' : ''}`} />
      </button>
      {showUncheckedFields && (
        <div className="border-t border-border">
          <table className="min-w-full divide-y divide-border">
            <thead className="bg-surface-tertiary">
              <tr>
                <th className="px-2 py-1.5 text-left text-xs font-medium text-content-tertiary uppercase tracking-wider">
                  Field
                </th>
                <th className="px-2 py-1.5 text-left text-xs font-medium text-content-tertiary uppercase tracking-wider">
                  Value in Data
                </th>
              </tr>
            </thead>
            <tbody className="bg-surface-primary divide-y divide-border">
              {uncheckedFields.map((field, index) => (
                <tr
                  key={field.tag || field.name || index}
                  className={index % 2 === 0 ? 'bg-surface-primary' : 'bg-surface-alt'}
                >
                  <td className="px-2 py-1.5">
                    <div>
                      <p className="text-xs font-medium text-content-secondary">
                        {field.keyword || field.name}
                      </p>
                      <p className="text-xs text-content-muted font-mono">
                        {field.fieldType === 'derived' ? 'Derived field' :
                         field.fieldType === 'custom' ? 'Custom field' :
                         field.fieldType === 'private' ? 'Private field' :
                         (field.tag || 'Unknown tag')}
                      </p>
                    </div>
                  </td>
                  <td className="px-2 py-1.5">
                    <p className="text-xs text-content-secondary break-words">
                      {Array.isArray(field.value)
                        ? field.value.join(', ')
                        : String(field.value ?? '')}
                    </p>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
};

export default UncheckedFieldsDisplay;
