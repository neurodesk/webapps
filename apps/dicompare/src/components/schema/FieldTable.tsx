import React, { useState, useEffect } from 'react';
import { Trash2, ArrowRightLeft, Loader, Eye, EyeOff, Pencil } from 'lucide-react';
import { DicomField, Acquisition } from '../../types';
import { inferDataTypeFromValue } from '../../utils/datatypeInference';
import { formatFieldValue, formatFieldTypeInfo, formatFieldDisplay } from '../../utils/fieldFormatters';
import { ComplianceFieldResult } from '../../types/schema';
import CustomTooltip from '../common/CustomTooltip';
import StatusIcon from '../common/StatusIcon';
import FieldEditModal from './FieldEditModal';

interface FieldTableProps {
  fields: DicomField[];
  isEditMode: boolean;
  incompleteFields?: Set<string>;
  acquisitionId?: string;
  mode?: 'edit' | 'view' | 'compliance';
  // Compliance-specific props
  schemaId?: string;
  schemaAcquisitionId?: string;
  acquisition?: Acquisition;
  getSchemaContent?: (id: string) => Promise<string | null>;
  isDataProcessing?: boolean; // Prevent validation during DICOM upload
  // Pass validation results from parent instead of computing them here
  complianceResultsProp?: ComplianceFieldResult[];
  // Edit mode props
  onFieldUpdate: (fieldTag: string, updates: Partial<DicomField>) => void;
  onFieldConvert: (fieldTag: string) => void;
  onFieldDelete: (fieldTag: string) => void;
}

const FieldTable: React.FC<FieldTableProps> = ({
  fields,
  isEditMode,
  incompleteFields = new Set(),
  acquisitionId = '',
  mode = 'edit',
  schemaId,
  schemaAcquisitionId,
  acquisition,
  getSchemaContent,
  isDataProcessing = false,
  complianceResultsProp,
  onFieldUpdate,
  onFieldConvert,
  onFieldDelete,
}) => {
  const [editingField, setEditingField] = useState<DicomField | null>(null);
  const [showStatusMessages, setShowStatusMessages] = useState(false);
  const isComplianceMode = mode === 'compliance';

  // Use compliance results from props instead of computing them
  const complianceResults = complianceResultsProp || [];
  const isValidating = false; // Validation now happens at parent level
  const validationError = null;

  const getFieldComplianceResult = (field: DicomField): ComplianceFieldResult => {
    const result = complianceResults.find(r => {
      // Try exact tag match first (most reliable)
      if (r.fieldPath === field.tag) return true;

      // Try exact keyword match
      if (field.keyword && r.fieldName === field.keyword) return true;

      // Try exact name match
      if (r.fieldName === field.name) return true;

      // Try tag inclusion as fallback
      if (field.tag && r.fieldPath?.includes(field.tag)) return true;

      return false;
    });

    return result || {
      fieldPath: field.tag,
      fieldName: field.keyword || field.name,
      status: 'unknown',
      message: 'No validation result available',
      actualValue: '',
      expectedValue: '',
      validationType: 'field',
      seriesName: undefined,
      rule_name: undefined
    };
  };


  if (fields.length === 0) {
    if (isComplianceMode && isValidating) {
      return (
        <div className="border border-border rounded-md p-4 text-center">
          <Loader className="h-4 w-4 animate-spin mx-auto mb-2" />
          <p className="text-content-tertiary text-xs">Validating compliance...</p>
        </div>
      );
    }
    return null;
  }

  if (isComplianceMode && validationError) {
    return (
      <div className="border border-red-500/20 rounded-md p-4 text-center">
        <p className="text-red-600 dark:text-red-400 text-xs">{validationError}</p>
      </div>
    );
  }

  return (
    <>
      <div className="border border-border rounded-md overflow-hidden" data-tutorial="field-table">
        <table className="min-w-full divide-y divide-border">
          <thead className="bg-surface-secondary">
            <tr>
              <th className="px-2 py-1.5 text-left text-xs font-medium text-content-tertiary uppercase tracking-wider">
                Field
              </th>
              <th className="px-2 py-1.5 text-left text-xs font-medium text-content-tertiary uppercase tracking-wider">
                {isComplianceMode ? 'Expected Value' : 'Value'}
              </th>
              {isComplianceMode && (
                <th className="px-2 py-1.5 text-left text-xs font-medium text-content-tertiary uppercase tracking-wider">
                  Actual Value
                </th>
              )}
              {isComplianceMode && (
                <th className={`px-2 py-1.5 text-xs font-medium text-content-tertiary uppercase tracking-wider ${showStatusMessages ? 'min-w-[100px] text-left' : 'text-center'}`}>
                  <div className={`flex items-center gap-1 ${showStatusMessages ? 'justify-start' : 'justify-center'}`}>
                    <span>Status</span>
                    <button
                      onClick={() => setShowStatusMessages(!showStatusMessages)}
                      className="p-0.5 text-content-tertiary hover:text-brand-600 transition-colors"
                      title={showStatusMessages ? "Hide status messages" : "Show status messages"}
                    >
                      {showStatusMessages ? <Eye className="h-3 w-3" /> : <EyeOff className="h-3 w-3" />}
                    </button>
                  </div>
                </th>
              )}
              {isEditMode && (
                <th className="px-2 py-1.5 text-right text-xs font-medium text-content-tertiary uppercase tracking-wider w-16">
                  Actions
                </th>
              )}
            </tr>
          </thead>
          <tbody className="bg-surface-primary divide-y divide-border">
            {fields.map((field, index) => {
              // For unique identification: use tag for standard DICOM fields, name/keyword for derived fields
              // Note: some derived fields have tag="derived" which is not unique
              const isDerivedTag = !field.tag || field.tag === 'derived' || field.tag === null;
              const fieldIdentifier = isDerivedTag ? (field.keyword || field.name) : field.tag;
              const fieldKey = `${acquisitionId}-${fieldIdentifier}`;
              const isIncomplete = incompleteFields.has(fieldKey);

              // Pre-calculate data type display (will be used if needed in render)
              const explicitDataType = (field as any).dataType;
              const inferredDataType = inferDataTypeFromValue(field.value);
              const finalDataType = explicitDataType || inferredDataType;
              const fieldTypeDisplay = formatFieldTypeInfo(finalDataType, field.validationRule);

              // Pre-calculate compliance result (will be used if needed in render)
              const complianceResult = isComplianceMode ? getFieldComplianceResult(field) : null;

              return (
                <tr
                  key={fieldIdentifier}
                  className={`group ${index % 2 === 0 ? 'bg-surface-primary' : 'bg-surface-alt'} ${
                    isEditMode ? 'hover:bg-surface-hover transition-colors' : ''
                  } ${isIncomplete ? 'ring-2 ring-red-500 ring-inset bg-red-500/10' : ''}`}
                >
                <td className="px-2 py-1.5">
                  <div>
                    <p className="text-xs font-medium text-content-primary">
                      {field.keyword || field.name}
                    </p>
                    <p className="text-xs text-content-tertiary font-mono">
                      {field.fieldType === 'derived' ? 'Derived field' :
                       field.fieldType === 'custom' ? 'Custom field' :
                       field.fieldType === 'private' ? 'Private field' :
                       (field.tag || 'Unknown tag')}
                    </p>
                  </div>
                </td>
                <td className="px-2 py-1.5">
                  <div
                    className={`${isEditMode ? 'cursor-pointer hover:bg-brand-500/20 rounded px-1 -mx-1' : ''}`}
                    onClick={() => isEditMode && setEditingField(field)}
                    data-tutorial={index === 0 && isEditMode ? 'field-value-cell' : undefined}
                  >
                    <p className="text-xs text-content-primary break-words">{formatFieldValue(field)}</p>
                    <p className="text-xs text-content-tertiary mt-0.5">{fieldTypeDisplay}</p>
                  </div>
                </td>
                {isComplianceMode && (
                  <td className="px-2 py-1.5">
                    {complianceResult?.actualValue !== undefined && complianceResult?.actualValue !== null ? (
                      <p className="text-xs text-content-primary break-words">{formatFieldDisplay(complianceResult.actualValue)}</p>
                    ) : (
                      <span className="text-xs text-content-muted italic">—</span>
                    )}
                  </td>
                )}
                {isComplianceMode && complianceResult && (
                  <td className="px-2 py-1.5">
                    <div className={`flex items-center gap-2 ${showStatusMessages ? 'justify-start' : 'justify-center'}`}>
                      <CustomTooltip
                        content={complianceResult.message}
                        position="top"
                        delay={100}
                      >
                        <div className="inline-flex items-center justify-center cursor-help flex-shrink-0">
                          <StatusIcon status={complianceResult.status} />
                        </div>
                      </CustomTooltip>
                      {showStatusMessages && complianceResult.message && (
                        <span className="text-xs text-content-secondary">
                          {complianceResult.message}
                        </span>
                      )}
                    </div>
                  </td>
                )}
                {isEditMode && (
                  <td className="px-2 py-1.5 text-right">
                    <div className="flex items-center justify-end space-x-1">
                      <button
                        onClick={() => setEditingField(field)}
                        className="p-0.5 text-content-tertiary hover:text-brand-600 transition-colors"
                        title="Edit field"
                      >
                        <Pencil className="h-3 w-3" />
                      </button>
                      <button
                        onClick={() => onFieldConvert(fieldIdentifier)}
                        className="p-0.5 text-content-tertiary hover:text-brand-600 transition-colors"
                        title="Convert to series field"
                        data-tutorial={index === 0 ? 'convert-to-series-button' : undefined}
                      >
                        <ArrowRightLeft className="h-3 w-3" />
                      </button>
                      <button
                        onClick={() => onFieldDelete(fieldIdentifier)}
                        className="p-0.5 text-content-tertiary hover:text-red-600 dark:hover:text-red-400 transition-colors"
                        title="Delete field"
                      >
                        <Trash2 className="h-3 w-3" />
                      </button>
                    </div>
                  </td>
                )}
              </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {/* Edit Modal */}
      {editingField && (
        <FieldEditModal
          field={editingField}
          onSave={(updates) => {
            onFieldUpdate(editingField.tag || editingField.name, updates);
            setEditingField(null);
          }}
          onClose={() => setEditingField(null)}
        />
      )}

    </>
  );
};

export default FieldTable;