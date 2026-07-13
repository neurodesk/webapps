import { useCallback, Dispatch, SetStateAction } from 'react';
import { Acquisition, DicomField, Series, SeriesField, SelectedValidationFunction } from '../types';
import { WorkspaceItem } from '../contexts/workspace/types';
import { searchDicomFields, suggestDataType, suggestValidationConstraint, isValidDicomTag } from '../services/dicomFieldService';
import { convertValueToDataType, inferDataTypeFromValue } from '../utils/datatypeInference';
import { getSuggestedToleranceValue } from '../utils/vrMapping';

/**
 * Hook for workspace item editing operations.
 * Extracts field/series/validation function mutations from WorkspaceContext.
 */
export function useWorkspaceEditing(
  setItems: Dispatch<SetStateAction<WorkspaceItem[]>>
) {
  // Update acquisition properties
  const updateAcquisition = useCallback((id: string, updates: Partial<Acquisition>) => {
    setItems(prev => prev.map(item =>
      item.id === id ? { ...item, acquisition: { ...item.acquisition, ...updates } } : item
    ));
  }, [setItems]);

  // Update a field in an acquisition
  const updateField = useCallback((id: string, fieldTagOrName: string, updates: Partial<DicomField>) => {
    setItems(prev => prev.map(item => {
      if (item.id !== id) return item;

      const acq = item.acquisition;
      return {
        ...item,
        acquisition: {
          ...acq,
          acquisitionFields: acq.acquisitionFields.map(f =>
            (f.tag === fieldTagOrName || f.name === fieldTagOrName) ? { ...f, ...updates } : f
          ),
          series: acq.series?.map(s => ({
            ...s,
            fields: Array.isArray(s.fields) ? s.fields.map(f =>
              (f.tag === fieldTagOrName || f.name === fieldTagOrName) ? { ...f, ...updates } : f
            ) : []
          }))
        }
      };
    }));
  }, [setItems]);

  // Delete a field
  const deleteField = useCallback((id: string, fieldTagOrName: string) => {
    setItems(prev => prev.map(item => {
      if (item.id !== id) return item;

      const acq = item.acquisition;
      return {
        ...item,
        acquisition: {
          ...acq,
          acquisitionFields: acq.acquisitionFields.filter(f => f.tag !== fieldTagOrName && f.name !== fieldTagOrName),
          series: acq.series?.map(s => ({
            ...s,
            fields: Array.isArray(s.fields) ? s.fields.filter(f => f.tag !== fieldTagOrName && f.name !== fieldTagOrName) : []
          }))
        }
      };
    }));
  }, [setItems]);

  // Convert field between acquisition and series level
  const convertFieldLevel = useCallback((id: string, fieldTagOrName: string, toLevel: 'acquisition' | 'series', mode: 'separate-series' | 'single-series' = 'single-series') => {
    setItems(prev => prev.map(item => {
      if (item.id !== id) return item;

      const acq = item.acquisition;

      // Find field in acquisition level
      const acquisitionField = acq.acquisitionFields.find(f => f.tag === fieldTagOrName || f.name === fieldTagOrName);

      // Find field in any series
      let seriesField: SeriesField | undefined;
      for (const series of acq.series || []) {
        if (Array.isArray(series.fields)) {
          seriesField = series.fields.find(f => f.tag === fieldTagOrName || f.name === fieldTagOrName);
        }
        if (seriesField) break;
      }

      const field = acquisitionField || (seriesField ? {
        tag: seriesField.tag,
        name: seriesField.name,
        keyword: seriesField.keyword,
        value: seriesField.value,
        vr: 'UN',
        level: 'series' as const,
        validationRule: seriesField.validationRule,
        fieldType: seriesField.fieldType
      } : null);

      if (!field) return item;

      if (toLevel === 'acquisition') {
        const updatedSeries = (acq.series || []).map(series => ({
          ...series,
          fields: Array.isArray(series.fields)
            ? series.fields.filter(f => f.tag !== fieldTagOrName && f.name !== fieldTagOrName)
            : []
        }));

        return {
          ...item,
          acquisition: {
            ...acq,
            acquisitionFields: [...acq.acquisitionFields.filter(f => f.tag !== fieldTagOrName && f.name !== fieldTagOrName), { ...field, level: 'acquisition' }],
            series: updatedSeries
          }
        };
      } else {
        const currentSeries = acq.series || [];
        let updatedSeries: Series[] = [];

        if (Array.isArray(field.value) && mode === 'separate-series') {
          if (currentSeries.length > 0) {
            let seriesCounter = 1;
            for (const existingSeries of currentSeries) {
              for (let i = 0; i < field.value.length; i++) {
                updatedSeries.push({
                  name: `Series ${String(seriesCounter).padStart(2, '0')}`,
                  fields: [
                    ...(Array.isArray(existingSeries.fields)
                        ? existingSeries.fields.filter(f => f.tag !== fieldTagOrName && f.name !== fieldTagOrName)
                        : []),
                    {
                      name: field.name,
                      keyword: field.keyword,
                      tag: field.tag,
                      value: field.value[i],
                      validationRule: field.validationRule,
                      fieldType: field.fieldType
                    }
                  ]
                });
                seriesCounter++;
              }
            }
          } else {
            for (let i = 0; i < field.value.length; i++) {
              updatedSeries.push({
                name: `Series ${String(i + 1).padStart(2, '0')}`,
                fields: [{
                  name: field.name,
                  keyword: field.keyword,
                  tag: field.tag,
                  value: field.value[i],
                  validationRule: field.validationRule,
                  fieldType: field.fieldType
                }]
              });
            }
          }
        } else {
          const seriesCount = Math.max(1, currentSeries.length);
          for (let i = 0; i < seriesCount; i++) {
            const existingSeries = currentSeries[i];
            updatedSeries.push({
              name: existingSeries?.name || `Series ${String(i + 1).padStart(2, '0')}`,
              fields: [
                ...(existingSeries && Array.isArray(existingSeries.fields)
                    ? existingSeries.fields.filter(f => f.tag !== fieldTagOrName && f.name !== fieldTagOrName)
                    : []),
                {
                  name: field.name,
                  keyword: field.keyword,
                  tag: field.tag,
                  value: field.value,
                  validationRule: field.validationRule,
                  fieldType: field.fieldType
                }
              ]
            });
          }
        }

        return {
          ...item,
          acquisition: {
            ...acq,
            acquisitionFields: acq.acquisitionFields.filter(f => f.tag !== fieldTagOrName && f.name !== fieldTagOrName),
            series: updatedSeries
          }
        };
      }
    }));
  }, [setItems]);

  // Add fields to an acquisition
  const addFields = useCallback(async (id: string, fieldTags: string[]) => {
    if (fieldTags.length === 0) return;

    const newFieldsPromises = fieldTags.map(async (tagOrName) => {
      try {
        const isDicomFormat = isValidDicomTag(tagOrName);
        const results = await searchDicomFields(tagOrName, 1);
        const fieldDef = isDicomFormat
          ? results.find(f => f.tag.replace(/[()]/g, '') === tagOrName)
          : results.find(f => f.keyword?.toLowerCase() === tagOrName.toLowerCase() || f.name?.toLowerCase() === tagOrName.toLowerCase());

        let fieldType: 'standard' | 'private' | 'custom';
        if (fieldDef) {
          fieldType = 'standard';
        } else if (isDicomFormat) {
          fieldType = 'private';
        } else {
          fieldType = 'custom';
        }

        const vr = fieldDef?.vr || fieldDef?.valueRepresentation || 'UN';
        const tag = fieldDef?.tag?.replace(/[()]/g, '') || (isDicomFormat ? tagOrName : null);
        const name = fieldDef?.name || tagOrName;
        const keyword = fieldDef?.keyword || name;
        const suggestedDataType = fieldDef ? suggestDataType(vr, fieldDef.valueMultiplicity) : 'string' as const;
        const constraintType = fieldDef ? suggestValidationConstraint(fieldDef) : 'exact' as const;
        const defaultValue = convertValueToDataType('', suggestedDataType);

        let validationRule: any = { type: constraintType };
        if (constraintType === 'tolerance') {
          const toleranceValue = getSuggestedToleranceValue(name, tag || '');
          if (toleranceValue !== undefined) {
            validationRule.tolerance = toleranceValue;
            validationRule.value = defaultValue;
          }
        }

        return {
          tag,
          name,
          keyword,
          value: defaultValue,
          vr,
          dataType: suggestedDataType,
          level: 'acquisition' as const,
          validationRule,
          fieldType
        };
      } catch (error) {
        const isDicomFormat = isValidDicomTag(tagOrName);
        return {
          tag: isDicomFormat ? tagOrName : null,
          name: tagOrName,
          keyword: tagOrName,
          value: '',
          vr: 'UN',
          dataType: 'string',
          level: 'acquisition' as const,
          validationRule: { type: 'exact' as const },
          fieldType: isDicomFormat ? 'private' as const : 'custom' as const
        };
      }
    });

    const newFields = await Promise.all(newFieldsPromises);

    setItems(prev => prev.map(item => {
      if (item.id !== id) return item;

      const acq = item.acquisition;
      const existingTags = new Set(acq.acquisitionFields.map(f => f.tag).filter(Boolean));
      const existingNames = new Set(acq.acquisitionFields.map(f => f.name.toLowerCase()));

      const uniqueNewFields = newFields.filter(newField => {
        if (newField.tag && existingTags.has(newField.tag)) return false;
        if (existingNames.has(newField.name.toLowerCase())) return false;
        return true;
      });

      return {
        ...item,
        acquisition: {
          ...acq,
          acquisitionFields: [...acq.acquisitionFields, ...uniqueNewFields]
        }
      };
    }));
  }, [setItems]);

  // Update a series field
  const updateSeries = useCallback((id: string, seriesIndex: number, fieldTag: string, updates: Partial<SeriesField>) => {
    setItems(prev => prev.map(item => {
      if (item.id !== id) return item;

      const acq = item.acquisition;
      const updatedSeries = [...(acq.series || [])];

      if (!updatedSeries[seriesIndex]) {
        updatedSeries[seriesIndex] = { name: `Series ${String(seriesIndex + 1).padStart(2, '0')}`, fields: [] };
      }

      const existingFieldIndex = updatedSeries[seriesIndex].fields.findIndex(f => f.tag === fieldTag);

      if (existingFieldIndex >= 0) {
        updatedSeries[seriesIndex].fields[existingFieldIndex] = {
          ...updatedSeries[seriesIndex].fields[existingFieldIndex],
          ...updates
        };
      } else {
        const newField: SeriesField = {
          tag: fieldTag,
          name: updates.name || fieldTag,
          value: updates.value || '',
          validationRule: updates.validationRule
        };
        updatedSeries[seriesIndex].fields.push(newField);
      }

      return { ...item, acquisition: { ...acq, series: updatedSeries } };
    }));
  }, [setItems]);

  // Add a new series
  const addSeries = useCallback((id: string) => {
    setItems(prev => prev.map(item => {
      if (item.id !== id) return item;

      const acq = item.acquisition;
      const currentSeries = acq.series || [];
      let newFields: SeriesField[] = [];

      if (currentSeries.length > 0) {
        for (let i = currentSeries.length - 1; i >= 0; i--) {
          if (currentSeries[i].fields.length > 0) {
            newFields = currentSeries[i].fields.map(field => ({
              ...field,
              value: field.value
            }));
            break;
          }
        }
      }

      if (newFields.length === 0 && currentSeries.length > 0) {
        const fieldMap = new Map<string, SeriesField>();
        currentSeries.forEach(s => {
          s.fields.forEach(f => {
            const fieldKey = f.tag || f.name;
            if (!fieldMap.has(fieldKey)) {
              fieldMap.set(fieldKey, f);
            }
          });
        });

        fieldMap.forEach((field) => {
          const defaultValue = inferDataTypeFromValue(field.value) === 'number' ? 0 :
                              inferDataTypeFromValue(field.value) === 'list_number' ? [] :
                              inferDataTypeFromValue(field.value) === 'list_string' ? [] :
                              '';
          newFields.push({ ...field, value: defaultValue });
        });
      }

      const newSeries: Series = {
        name: `Series ${String(currentSeries.length + 1).padStart(2, '0')}`,
        fields: newFields
      };

      return { ...item, acquisition: { ...acq, series: [...currentSeries, newSeries] } };
    }));
  }, [setItems]);

  // Delete a series
  const deleteSeries = useCallback((id: string, seriesIndex: number) => {
    setItems(prev => prev.map(item => {
      if (item.id !== id) return item;

      const acq = item.acquisition;
      const updatedSeries = [...(acq.series || [])];
      updatedSeries.splice(seriesIndex, 1);

      return { ...item, acquisition: { ...acq, series: updatedSeries } };
    }));
  }, [setItems]);

  // Update series name
  const updateSeriesName = useCallback((id: string, seriesIndex: number, name: string) => {
    setItems(prev => prev.map(item => {
      if (item.id !== id) return item;

      const acq = item.acquisition;
      const updatedSeries = [...(acq.series || [])];
      if (updatedSeries[seriesIndex]) {
        updatedSeries[seriesIndex] = { ...updatedSeries[seriesIndex], name };
      }

      return { ...item, acquisition: { ...acq, series: updatedSeries } };
    }));
  }, [setItems]);

  // Add validation function
  const addValidationFunction = useCallback((id: string, func: SelectedValidationFunction) => {
    setItems(prev => prev.map(item =>
      item.id === id ? {
        ...item,
        acquisition: {
          ...item.acquisition,
          validationFunctions: [...(item.acquisition.validationFunctions || []), func]
        }
      } : item
    ));
  }, [setItems]);

  // Update validation function
  const updateValidationFunction = useCallback((id: string, index: number, func: SelectedValidationFunction) => {
    setItems(prev => prev.map(item => {
      if (item.id !== id) return item;

      const updatedFunctions = [...(item.acquisition.validationFunctions || [])];
      if (updatedFunctions[index]) {
        updatedFunctions[index] = func;
      }

      return { ...item, acquisition: { ...item.acquisition, validationFunctions: updatedFunctions } };
    }));
  }, [setItems]);

  // Delete validation function
  const deleteValidationFunction = useCallback((id: string, index: number) => {
    setItems(prev => prev.map(item => {
      if (item.id !== id) return item;

      const updatedFunctions = [...(item.acquisition.validationFunctions || [])];
      updatedFunctions.splice(index, 1);

      return { ...item, acquisition: { ...item.acquisition, validationFunctions: updatedFunctions } };
    }));
  }, [setItems]);

  return {
    updateAcquisition,
    updateField,
    deleteField,
    convertFieldLevel,
    addFields,
    updateSeries,
    addSeries,
    deleteSeries,
    updateSeriesName,
    addValidationFunction,
    updateValidationFunction,
    deleteValidationFunction,
  };
}
