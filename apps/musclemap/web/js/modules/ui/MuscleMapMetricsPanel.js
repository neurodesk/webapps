/**
 * Metrics Summary Card
 *
 * Displays volumetric metrics summary and provides CSV download
 * after segmentation completes.
 */
import { metricsCsv } from '../../../vendor/musclemap/src/results.js';
import { downloadBlob } from '@neurodesk/webapp-components/file-io';
export class MuscleMapMetricsPanel {
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
    dlBtn.style.cssText = 'width: 100%; margin-top: var(--nd-space-sm);';
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
    const csv = metricsCsv(this.metrics, this.detectedLabels);
    downloadBlob(new Blob([csv], { type: 'text/csv' }), 'musclemap_metrics.csv');
  }
}
