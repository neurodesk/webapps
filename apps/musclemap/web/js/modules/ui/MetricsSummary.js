/**
 * Metrics Summary Card
 *
 * Displays volumetric metrics summary and provides CSV download
 * after segmentation completes.
 */
import { downloadBlob } from '@neurodesk/webapp-components/file-io';
export class MetricsSummary {
  constructor(containerId = 'metricsSummary') {
    this.containerId = containerId;
    this.metrics = null;
    this.detectedLabels = null;
  }

  /**
   * Show metrics summary card.
   * @param {object} metrics - { labelVolumes, labelSliceCounts, totalVolumeMl, voxelSizeMm, totalSlices }
   * @param {Array<{index: number, name: string}>} detectedLabels
   */
  show(metrics, detectedLabels) {
    this.metrics = metrics;
    this.detectedLabels = detectedLabels;

    const container = document.getElementById(this.containerId);
    if (!container) return;

    const content = container.querySelector('.section-content');
    if (!content) return;

    content.innerHTML = '';

    // Summary stats row
    const header = document.createElement('div');
    header.className = 'metrics-header';

    const muscleCount = detectedLabels.length;
    const totalVol = metrics.totalVolumeMl;
    const vs = metrics.voxelSizeMm;

    header.appendChild(this._createStat(muscleCount, 'Muscles'));
    header.appendChild(this._createStat(totalVol.toFixed(1), 'Total ml'));
    header.appendChild(this._createStat(
      `${vs[0].toFixed(1)} x ${vs[1].toFixed(1)} x ${vs[2].toFixed(1)}`,
      'Voxel mm'
    ));
    for (const imf of this._getImfResults(metrics)) {
      if (Number.isFinite(imf.totalFatPercentage)) {
        const fatPercentLabel = imf.mode === 'dixon' ? 'Dixon fat %' : 'IMF %';
        header.appendChild(this._createStat(imf.totalFatPercentage.toFixed(1), fatPercentLabel));
      }
    }

    content.appendChild(header);

    // Download CSV button
    const dlBtn = document.createElement('button');
    dlBtn.className = 'btn btn-secondary btn-sm';
    dlBtn.style.cssText = 'width: 100%; margin-top: var(--space-sm);';
    dlBtn.innerHTML = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg> Download Metrics CSV`;
    dlBtn.addEventListener('click', () => this._downloadCSV());
    content.appendChild(dlBtn);

    container.classList.remove('hidden');
  }

  hide() {
    const container = document.getElementById(this.containerId);
    if (container) {
      container.classList.add('hidden');
      const content = container.querySelector('.section-content');
      if (content) content.innerHTML = '';
    }
    this.metrics = null;
    this.detectedLabels = null;
  }

  _createStat(value, label) {
    const stat = document.createElement('div');
    stat.className = 'metrics-stat';

    const valEl = document.createElement('span');
    valEl.className = 'metrics-stat-value';
    valEl.textContent = value;

    const labEl = document.createElement('span');
    labEl.className = 'metrics-stat-label';
    labEl.textContent = label;

    stat.appendChild(valEl);
    stat.appendChild(labEl);
    return stat;
  }

  _getImfResults(metrics = this.metrics) {
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

  _downloadCSV() {
    if (!this.metrics || !this.detectedLabels) return;

    const imfResults = this._getImfResults();
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

    for (const label of this.detectedLabels) {
      const row = {
        label_index: label.index,
        label_name: label.name,
        volume_ml: this._formatNumber(this.metrics.labelVolumes[label.index], 4),
        slice_count: this.metrics.labelSliceCounts[label.index] || 0
      };

      if (!hasImf) {
        rows.push(columns.map(col => this._csvValue(row[col])).join(','));
        continue;
      }

      for (const imf of imfResults) {
        const imfRow = { ...row };
        this._addImfCsvFields(imfRow, imf, label.index);
        rows.push(columns.map(col => this._csvValue(imfRow[col])).join(','));
      }
    }

    // Total row
    const totalRow = {
      label_index: '',
      label_name: 'TOTAL',
      volume_ml: this._formatNumber(this.metrics.totalVolumeMl, 4),
      slice_count: ''
    };
    if (!hasImf) {
      rows.push(columns.map(col => this._csvValue(totalRow[col])).join(','));
    } else {
      for (const imf of imfResults) {
        const imfTotalRow = { ...totalRow };
        this._addImfTotalCsvFields(imfTotalRow, imf);
        rows.push(columns.map(col => this._csvValue(imfTotalRow[col])).join(','));
      }
    }

    const csv = rows.join('\n');
    downloadBlob(new Blob([csv], { type: 'text/csv' }), 'musclemap_metrics.csv');
  }

  _addImfCsvFields(row, imf, labelIndex) {
    const threshold = imf.thresholds?.[labelIndex] || {};
    row.imf_mode = imf.mode;
    row.imf_method = imf.method;
    row.imf_components = imf.components;
    row.muscle_percent = this._formatNumber(imf.labelMusclePercentages?.[labelIndex], 2);
    row.fat_percent = this._formatNumber(imf.labelFatPercentages?.[labelIndex], 2);
    row.total_volume_ml = this._formatNumber(imf.labelTotalVolumesMl?.[labelIndex], 4);
    row.fat_volume_ml = this._formatNumber(imf.labelFatVolumesMl?.[labelIndex], 4);
    row.muscle_volume_ml = this._formatNumber(imf.labelMuscleVolumesMl?.[labelIndex], 4);
    row.muscle_threshold = this._formatNumber(threshold.muscleMax, 4);
    if (imf.components === 3) {
      row.undefined_percent = this._formatNumber(imf.labelUndefinedPercentages?.[labelIndex], 2);
      row.undefined_volume_ml = this._formatNumber(imf.labelUndefinedVolumesMl?.[labelIndex], 4);
      row.fat_threshold = this._formatNumber(threshold.fatMin, 4);
    }
  }

  _addImfTotalCsvFields(row, imf) {
    row.imf_mode = imf.mode;
    row.imf_method = imf.method;
    row.imf_components = imf.components;
    row.muscle_percent = this._formatNumber(imf.totalMusclePercentage, 2);
    row.fat_percent = this._formatNumber(imf.totalFatPercentage, 2);
    row.total_volume_ml = this._formatNumber(imf.totalMeasuredVolumeMl, 4);
    row.fat_volume_ml = this._formatNumber(imf.totalFatVolumeMl, 4);
    row.muscle_volume_ml = this._formatNumber(imf.totalMuscleVolumeMl, 4);
    if (imf.components === 3) {
      row.undefined_percent = this._formatNumber(imf.totalUndefinedPercentage, 2);
      row.undefined_volume_ml = this._formatNumber(imf.totalUndefinedVolumeMl, 4);
    }
  }

  _formatNumber(value, digits) {
    return Number.isFinite(value) ? value.toFixed(digits) : '';
  }

  _csvValue(value) {
    if (value == null) return '';
    const text = String(value);
    return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
  }
}
