export function getImfResults(metrics) {
    if (!metrics) return [];

    const results = [];
    const seenModes = new Set();
    const addResult = (result) => {
      if (!result?.mode || seenModes.has(result.mode)) return;
      seenModes.add(result.mode);
      results.push(result);
    };

    addResult(metrics.imfThreshold);
    addResult(metrics.imfDixon);
    addResult(metrics.imf);
    return results;
  }

export function metricsCsv(metrics, detectedLabels) {
    if (!metrics || !detectedLabels) throw new Error('Metrics and detected labels are required');

    const imfResults = getImfResults(metrics);
    const hasImf = imfResults.length > 0;
    const hasThreeComponentImf = imfResults.some(imf => imf.components === 3);
    const columns = ['label_index', 'label_name', 'volume_ml', 'slice_count'];

    if (hasImf) {
      columns.push(
        'imf_mode',
        'imf_method',
        'imf_components',
        'muscle_percent',
        'fat_percent',
        'total_volume_ml',
        'fat_volume_ml',
        'muscle_volume_ml',
        'muscle_threshold'
      );
      if (hasThreeComponentImf) {
        columns.push('undefined_percent', 'undefined_volume_ml', 'fat_threshold');
      }
    }

    const rows = [columns.join(',')];

    for (const label of detectedLabels) {
      const row = {
        label_index: label.index,
        label_name: label.name,
        volume_ml: formatNumber(metrics.labelVolumes[label.index], 4),
        slice_count: metrics.labelSliceCounts[label.index] || 0
      };

      if (!hasImf) {
        rows.push(columns.map(col => csvValue(row[col])).join(','));
        continue;
      }

      for (const imf of imfResults) {
        const imfRow = { ...row };
        addImfCsvFields(imfRow, imf, label.index);
        rows.push(columns.map(col => csvValue(imfRow[col])).join(','));
      }
    }

    // Total row
    const totalRow = {
      label_index: '',
      label_name: 'TOTAL',
      volume_ml: formatNumber(metrics.totalVolumeMl, 4),
      slice_count: ''
    };
    if (!hasImf) {
      rows.push(columns.map(col => csvValue(totalRow[col])).join(','));
    } else {
      for (const imf of imfResults) {
        const imfTotalRow = { ...totalRow };
        addImfTotalCsvFields(imfTotalRow, imf);
        rows.push(columns.map(col => csvValue(imfTotalRow[col])).join(','));
      }
    }

    const csv = rows.join('\n');
    return csv;
  }

function addImfCsvFields(row, imf, labelIndex) {
    const threshold = imf.thresholds?.[labelIndex] || {};
    row.imf_mode = imf.mode;
    row.imf_method = imf.method;
    row.imf_components = imf.components;
    row.muscle_percent = formatNumber(imf.labelMusclePercentages?.[labelIndex], 2);
    row.fat_percent = formatNumber(imf.labelFatPercentages?.[labelIndex], 2);
    row.total_volume_ml = formatNumber(imf.labelTotalVolumesMl?.[labelIndex], 4);
    row.fat_volume_ml = formatNumber(imf.labelFatVolumesMl?.[labelIndex], 4);
    row.muscle_volume_ml = formatNumber(imf.labelMuscleVolumesMl?.[labelIndex], 4);
    row.muscle_threshold = formatNumber(threshold.muscleMax, 4);
    if (imf.components === 3) {
      row.undefined_percent = formatNumber(imf.labelUndefinedPercentages?.[labelIndex], 2);
      row.undefined_volume_ml = formatNumber(imf.labelUndefinedVolumesMl?.[labelIndex], 4);
      row.fat_threshold = formatNumber(threshold.fatMin, 4);
    }
  }

function addImfTotalCsvFields(row, imf) {
    row.imf_mode = imf.mode;
    row.imf_method = imf.method;
    row.imf_components = imf.components;
    row.muscle_percent = formatNumber(imf.totalMusclePercentage, 2);
    row.fat_percent = formatNumber(imf.totalFatPercentage, 2);
    row.total_volume_ml = formatNumber(imf.totalMeasuredVolumeMl, 4);
    row.fat_volume_ml = formatNumber(imf.totalFatVolumeMl, 4);
    row.muscle_volume_ml = formatNumber(imf.totalMuscleVolumeMl, 4);
    if (imf.components === 3) {
      row.undefined_percent = formatNumber(imf.totalUndefinedPercentage, 2);
      row.undefined_volume_ml = formatNumber(imf.totalUndefinedVolumeMl, 4);
    }
  }

function formatNumber(value, digits) {
    return Number.isFinite(value) ? value.toFixed(digits) : '';
  }

function csvValue(value) {
    if (value == null) return '';
    const text = String(value);
    return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
  }

export function outputNames(inputName) {
  const base = inputName.replace(/\.(nii|nii\.gz)$/i, '');
  return {
    segmentation: `${base}_segmentation.nii`,
    display: `${base}_segmentation_display.nii`,
    metrics: 'musclemap_metrics.csv'
  };
}
