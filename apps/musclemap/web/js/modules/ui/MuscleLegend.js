/**
 * Muscle Legend Panel
 *
 * Displays a scrollable list of detected muscles with color swatches
 * after segmentation completes.
 */
export class MuscleLegend {
  constructor(containerId = 'muscleLegend') {
    this.containerId = containerId;
  }

  /**
   * Show detected muscles in the legend.
   * @param {Array<{index: number, name: string, color: number[]}>} detectedLabels
   * @param {object|null} metrics - optional metrics with labelVolumes
   */
  show(detectedLabels, metrics = null) {
    const container = document.getElementById(this.containerId);
    if (!container) return;

    container.innerHTML = '';

    if (detectedLabels.length === 0) {
      container.innerHTML = '<div class="legend-empty">No muscles detected</div>';
      container.classList.remove('hidden');
      return;
    }

    const header = document.createElement('div');
    header.className = 'legend-header';
    header.textContent = `${detectedLabels.length} muscles detected`;
    container.appendChild(header);

    const list = document.createElement('div');
    list.className = 'legend-list';

    for (const label of detectedLabels) {
      const item = document.createElement('div');
      item.className = 'legend-item';

      const swatch = document.createElement('span');
      swatch.className = 'legend-swatch';
      const [r, g, b] = label.color;
      swatch.style.backgroundColor = `rgb(${r}, ${g}, ${b})`;

      const name = document.createElement('span');
      name.className = 'legend-name';
      name.textContent = label.name;

      const idx = document.createElement('span');
      idx.className = 'legend-index';
      idx.textContent = `#${label.value}`;

      item.appendChild(swatch);
      item.appendChild(name);

      if (metrics && metrics.labelVolumes && metrics.labelVolumes[label.index] != null) {
        const vol = document.createElement('span');
        vol.className = 'legend-volume';
        vol.textContent = `${metrics.labelVolumes[label.index].toFixed(1)} ml`;
        item.appendChild(vol);
      }

      item.appendChild(idx);
      list.appendChild(item);
    }

    container.appendChild(list);
    container.classList.remove('hidden');
  }

  hide() {
    const container = document.getElementById(this.containerId);
    if (container) {
      container.classList.add('hidden');
      container.innerHTML = '';
    }
  }
}
