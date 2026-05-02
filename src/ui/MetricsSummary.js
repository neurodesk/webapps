import { createElement, clearElement } from '../core/dom.js';

export class MetricsSummary {
  constructor(options = {}) {
    this.element = typeof options.element === 'string'
      ? globalThis.document?.getElementById(options.element)
      : options.element;
  }

  render(metrics = {}) {
    if (!this.element) return;
    clearElement(this.element);
    const doc = this.element.ownerDocument;
    const stats = metrics.stats || [
      { label: 'Labels', value: metrics.detectedLabels?.length ?? 0 },
      { label: 'Volume', value: metrics.totalVolumeMl != null ? `${Number(metrics.totalVolumeMl).toFixed(2)} ml` : null },
      { label: 'Voxels', value: metrics.totalVoxels ?? null }
    ].filter(item => item.value != null);

    const row = createElement('div', { className: 'nd-metrics-header', ownerDocument: doc });
    for (const stat of stats) {
      row.appendChild(createElement('div', { className: 'nd-metrics-stat', ownerDocument: doc }, [
        createElement('div', { className: 'nd-metrics-stat-value', text: stat.value, ownerDocument: doc }),
        createElement('div', { className: 'nd-metrics-stat-label', text: stat.label, ownerDocument: doc })
      ]));
    }
    this.element.appendChild(row);
  }
}
