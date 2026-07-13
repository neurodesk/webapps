import React, { useState } from 'react';
import { Plus, Trash2, Edit2, ArrowLeftRight, ImageIcon, Eye, EyeOff } from 'lucide-react';
import { Series, SeriesField } from '../../types';
import { ComplianceFieldResult } from '../../types/schema';
import { inferDataTypeFromValue } from '../../utils/datatypeInference';
import { formatSeriesFieldValue, formatFieldTypeInfo } from '../../utils/fieldFormatters';
import CustomTooltip from '../common/CustomTooltip';
import StatusIcon from '../common/StatusIcon';
import FieldEditModal from './FieldEditModal';

interface SeriesTableProps {
  // seriesFields removed - now embedded in series[].fields[]
  series: Series[];
  isEditMode: boolean;
  incompleteFields?: Set<string>;
  acquisitionId?: string;
  mode?: 'edit' | 'view' | 'compliance';
  // Compliance-specific props
  complianceResults?: any[];
  onSeriesUpdate: (seriesIndex: number, fieldTag: string, updates: Partial<SeriesField>) => void;
  onSeriesAdd: () => void;
  onSeriesDelete: (seriesIndex: number) => void;
  onFieldConvert: (fieldTag: string) => void;
  onSeriesNameUpdate?: (seriesIndex: number, name: string) => void;
  onSeriesView?: (seriesIndex: number, seriesName: string) => void;
  onSeriesViewTestData?: (seriesIndex: number, seriesName: string) => void;
}

const SeriesTable: React.FC<SeriesTableProps> = ({
  series,
  isEditMode,
  incompleteFields = new Set(),
  acquisitionId = '',
  mode = 'edit',
  complianceResults = [],
  onSeriesUpdate,
  onSeriesAdd,
  onSeriesDelete,
  onFieldConvert,
  onSeriesNameUpdate,
  onSeriesView,
  onSeriesViewTestData,
}) => {
  const [editingCell, setEditingCell] = useState<{
    seriesIndex: number;
    fieldIndex: number;
    fieldTag?: string;
    fieldName?: string;
  } | null>(null);
  const [hoveredHeader, setHoveredHeader] = useState<string | null>(null);
  const [showStatusMessages, setShowStatusMessages] = useState(false);

  const isComplianceMode = mode === 'compliance';

  // Helper function to get compliance result for a specific field and series
  const getSeriesFieldComplianceResult = (field: SeriesField, seriesName: string): ComplianceFieldResult => {
    // For series validation, find any result that includes this field
    const result = complianceResults.find(r => {
      if (r.validationType !== 'series') return false;
      const fieldNameLower = r.fieldName.toLowerCase();
      const fieldLower = field.name.toLowerCase();
      return fieldNameLower === fieldLower || fieldNameLower.includes(fieldLower) ||
             (field.tag && r.fieldPath && r.fieldPath.includes(field.tag));
    });

    return result || {
      fieldPath: field.tag || field.name,
      fieldName: field.name,
      status: 'unknown',
      message: 'No validation result available',
      actualValue: '',
      expectedValue: '',
      validationType: 'series',
      seriesName: seriesName,
      rule_name: undefined
    };
  };


  // Helper function to get fields as array (handles both array and object formats)
  const getFieldsArray = (fields: any): SeriesField[] => {
    if (!fields) return [];
    if (Array.isArray(fields)) return fields;
    // Object format from .pro files: { "tag": { value, field, name, keyword, ... } }
    return Object.entries(fields).map(([tag, fieldData]: [string, any]) => ({
      tag,
      name: fieldData.name || fieldData.field || tag,
      keyword: fieldData.keyword,
      value: fieldData.value,
      validationRule: fieldData.validationRule
    }));
  };

  // Get all unique field tags from all series
  const allFieldTags = new Set<string>();
  series.forEach(s => {
    const fieldsArray = getFieldsArray(s.fields);
    fieldsArray.forEach(f => allFieldTags.add(f.tag));
  });

  if (allFieldTags.size === 0) {
    return (
      <div className="border border-border rounded-md p-4 text-center">
        <p className="text-content-tertiary text-xs">No series-level fields defined</p>
        <p className="text-xs text-content-muted mt-1">
          Convert acquisition-level fields to series-level to create varying values
        </p>
      </div>
    );
  }

  // Display all existing series (no minimum requirement)
  const displaySeries = [];
  for (let i = 0; i < series.length; i++) {
    if (series[i]) {
      displaySeries.push(series[i]);
    } else {
      displaySeries.push({ name: `Series ${String(i + 1).padStart(2, '0')}`, fields: [] });
    }
  }

  // Get all unique field definitions across series for table headers
  // Use tag or name as key (for derived fields that have null tags)
  const allFields: SeriesField[] = [];
  const fieldMap = new Map<string, SeriesField>();

  series.forEach(s => {
    const fieldsArray = getFieldsArray(s.fields);
    fieldsArray.forEach(f => {
      const fieldKey = f.tag || f.name;
      if (!fieldMap.has(fieldKey)) {
        fieldMap.set(fieldKey, f);
        allFields.push(f);
      }
    });
  });

  return (
    <div className="border border-border rounded-md overflow-hidden">
      <div className="overflow-x-auto">
        <table className="min-w-full divide-y divide-border">
          <thead className="bg-surface-secondary">
            <tr>
              <th className="px-2 py-1.5 text-left text-xs font-medium text-content-tertiary uppercase tracking-wider sticky left-0 bg-surface-secondary z-10 min-w-[140px]">
                Series
              </th>
              {allFields.map((field) => (
                <th
                  key={field.tag || field.name}
                  className="px-2 py-1.5 text-left text-xs font-medium text-content-tertiary uppercase tracking-wider min-w-[120px]"
                  onMouseEnter={() => setHoveredHeader(field.tag || field.name)}
                  onMouseLeave={() => setHoveredHeader(null)}
                >
                  <div className="flex items-center justify-between">
                    <div className="min-w-0 flex-1">
                      <p className="font-medium truncate">{field.keyword || field.name}</p>
                      <p className="text-xs font-normal text-content-muted font-mono">
                        {field.fieldType === 'derived' ? 'Derived field' :
                         field.fieldType === 'custom' ? 'Custom field' :
                         field.fieldType === 'private' ? 'Private field' :
                         (field.tag || 'Unknown tag')}
                      </p>
                    </div>
                    {isEditMode && (
                      <div className={`flex items-center ml-1 ${
                        hoveredHeader === (field.tag || field.name) ? 'opacity-100' : 'opacity-0'
                      } transition-opacity`}>
                        <button
                          onClick={() => onFieldConvert(field.tag || field.name)}
                          className="p-0.5 text-content-muted hover:text-brand-600 transition-colors"
                          title="Convert to acquisition field"
                        >
                          <ArrowLeftRight className="h-3 w-3" />
                        </button>
                      </div>
                    )}
                  </div>
                </th>
              ))}
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
              {(onSeriesView || onSeriesViewTestData) && (
                <th className="px-2 py-1.5 text-center text-xs font-medium text-content-tertiary uppercase tracking-wider w-auto">
                </th>
              )}
            </tr>
          </thead>
          <tbody className="bg-surface-primary divide-y divide-border">
            {displaySeries.map((ser, seriesIndex) => (
              <tr
                key={seriesIndex}
                className={`${seriesIndex % 2 === 0 ? 'bg-surface-primary' : 'bg-surface-alt'} ${
                  isEditMode ? 'hover:bg-surface-hover transition-colors' : ''
                }`}
              >
                <td className="px-2 py-1.5 whitespace-nowrap font-medium text-content-primary sticky left-0 bg-inherit min-w-[140px]">
                  {isEditMode && onSeriesNameUpdate ? (
                    <input
                      type="text"
                      value={ser.name}
                      onChange={(e) => onSeriesNameUpdate(seriesIndex, e.target.value)}
                      className="bg-transparent border-none focus:outline-none focus:ring-2 focus:ring-brand-500 rounded px-1 py-0.5 -mx-1 -my-0.5 text-xs w-full text-content-primary"
                      onBlur={(e) => {
                        if (!e.target.value.trim()) {
                          onSeriesNameUpdate(seriesIndex, `Series ${String(seriesIndex + 1).padStart(2, '0')}`);
                        }
                      }}
                    />
                  ) : (
                    <span className="text-xs">{ser.name}</span>
                  )}
                </td>
                {allFields.map((headerField) => {
                  // Find the specific field in this series (by tag or name for derived fields)
                  const fieldsArray = getFieldsArray(ser.fields);
                  const fieldIdentifier = headerField.tag || headerField.name;
                  const seriesFieldIndex = fieldsArray.findIndex(f => f.tag === headerField.tag || f.name === headerField.name);
                  const seriesField = seriesFieldIndex >= 0 ? fieldsArray[seriesFieldIndex] : null;

                  const seriesFieldKey = `${acquisitionId}-series-${seriesIndex}-${fieldIdentifier}`;
                  const isIncomplete = incompleteFields.has(seriesFieldKey);
                  const complianceResult = isComplianceMode && seriesField ? getSeriesFieldComplianceResult(seriesField, ser.name) : null;

                  return (
                    <td key={fieldIdentifier} className={`px-2 py-1.5 ${
                      isIncomplete ? 'ring-2 ring-red-500 ring-inset bg-red-50' : ''
                    }`}>
                      <div
                        className={`${isEditMode ? 'cursor-pointer hover:bg-brand-500/20 rounded px-1 -mx-1' : ''}`}
                        onClick={() => {
                          if (isEditMode) {
                            // If field doesn't exist in this series, we'll handle creating it
                            setEditingCell({
                              seriesIndex,
                              fieldIndex: seriesFieldIndex,
                              fieldTag: fieldIdentifier,
                              fieldName: headerField.name
                            });
                          }
                        }}
                      >
                        <div className="flex items-center justify-between">
                          <div className="flex-1">
                            <p className="text-xs text-content-primary break-words">
                              {seriesField ? formatSeriesFieldValue(seriesField.value, seriesField.validationRule) : '-'}
                            </p>
                            {seriesField && (
                              <p className="text-xs text-content-tertiary mt-0.5">
                                {formatFieldTypeInfo(
                                  inferDataTypeFromValue(seriesField.value),
                                  seriesField.validationRule
                                )}
                              </p>
                            )}
                          </div>
                        </div>
                      </div>
                    </td>
                  );
                })}
                {isComplianceMode && (
                  <td className="px-2 py-1.5">
                    {(() => {
                      // Find series validation result by series name
                      const seriesResult = complianceResults.find(r =>
                        r.validationType === 'series' && r.seriesName === ser.name
                      );

                      const message = seriesResult?.message || "No validation result available";
                      const status = seriesResult?.status || 'unknown';

                      return (
                        <div className={`flex items-center gap-2 ${showStatusMessages ? 'justify-start' : 'justify-center'}`}>
                          <CustomTooltip
                            content={message}
                            position="top"
                            delay={100}
                          >
                            <div className="inline-flex items-center justify-center cursor-help flex-shrink-0">
                              <StatusIcon status={status} />
                            </div>
                          </CustomTooltip>
                          {showStatusMessages && message && (
                            <span className="text-xs text-content-secondary">
                              {message}
                            </span>
                          )}
                        </div>
                      );
                    })()}
                  </td>
                )}
                {isEditMode && (
                  <td className="px-2 py-1.5 text-right">
                    <div>
                      <button
                        onClick={() => onSeriesDelete(seriesIndex)}
                        className="p-0.5 text-content-tertiary hover:text-red-600 dark:hover:text-red-400 transition-colors"
                        title="Delete series"
                        disabled={false}
                      >
                        <Trash2 className="h-3 w-3" />
                      </button>
                    </div>
                  </td>
                )}
                {(onSeriesView || onSeriesViewTestData) && (
                  <td className="px-2 py-1.5 text-center">
                    <div className="flex items-center justify-center gap-1">
                      {onSeriesView && (
                        <button
                          onClick={() => onSeriesView(seriesIndex, ser.name)}
                          className="inline-flex items-center gap-0.5 px-1.5 py-0.5 text-[10px] text-content-tertiary hover:text-brand-600 rounded hover:bg-brand-50 transition-colors"
                          title={`View ${ser.name} reference images`}
                        >
                          <ImageIcon className="h-3 w-3" />
                          {onSeriesViewTestData ? 'Ref' : 'Images'}
                        </button>
                      )}
                      {onSeriesViewTestData && (
                        <button
                          onClick={() => onSeriesViewTestData(seriesIndex, ser.name)}
                          className="inline-flex items-center gap-0.5 px-1.5 py-0.5 text-[10px] text-content-tertiary hover:text-amber-600 rounded hover:bg-amber-50 transition-colors"
                          title={`View ${ser.name} test data images`}
                        >
                          <ImageIcon className="h-3 w-3" />
                          {onSeriesView ? 'Test' : 'Images'}
                        </button>
                      )}
                    </div>
                  </td>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* Add Series Button */}
      {isEditMode && (
        <div className="bg-surface-secondary px-2 py-1.5 border-t border-border">
          <button
            onClick={onSeriesAdd}
            className="inline-flex items-center px-2 py-1 text-xs text-brand-600 dark:text-brand-400 hover:text-brand-700 dark:hover:text-brand-300 hover:bg-brand-500/10 rounded transition-colors"
          >
            <Plus className="h-3 w-3 mr-1" />
            Add Series
          </button>
        </div>
      )}

      {/* Edit Modal for Series Values */}
      {editingCell && displaySeries[editingCell.seriesIndex] && (
        <FieldEditModal
          field={(() => {
            // If field exists in series, use it
            if (editingCell.fieldIndex >= 0) {
              const fieldsArray = getFieldsArray(displaySeries[editingCell.seriesIndex].fields);
              const existingField = fieldsArray[editingCell.fieldIndex];
              return {
                tag: existingField.tag,
                name: existingField.name,
                value: existingField.value,
                vr: 'UN',
                level: 'series' as const,
                validationRule: existingField.validationRule
              };
            }
            // Otherwise create a new field with defaults
            return {
              tag: editingCell.fieldTag || '',
              name: editingCell.fieldName || editingCell.fieldTag || '',
              value: '',
              vr: 'UN',
              level: 'series' as const,
              validationRule: { type: 'exact' as const }
            };
          })()}
          value={editingCell.fieldIndex >= 0
            ? getFieldsArray(displaySeries[editingCell.seriesIndex].fields)[editingCell.fieldIndex].value
            : ''}
          onSave={(updates) => {
            const fieldTag = editingCell.fieldIndex >= 0
              ? getFieldsArray(displaySeries[editingCell.seriesIndex].fields)[editingCell.fieldIndex].tag
              : editingCell.fieldTag || '';

            const fieldUpdate: Partial<SeriesField> = {
              name: editingCell.fieldName || editingCell.fieldTag || '',
              tag: fieldTag
            };

            if ('value' in updates && updates.value !== undefined) {
              fieldUpdate.value = updates.value;
            }
            if ('validationRule' in updates && updates.validationRule !== undefined) {
              fieldUpdate.validationRule = updates.validationRule;
            }

            onSeriesUpdate(editingCell.seriesIndex, fieldTag, fieldUpdate);
            setEditingCell(null);
          }}
          onClose={() => setEditingCell(null)}
          isSeriesValue={true}
        />
      )}

    </div>
  );
};

export default SeriesTable;
