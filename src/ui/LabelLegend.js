import { createElement, clearElement } from '../core/dom.js';

export class LabelLegend {
  constructor(options = {}) {
    this.element = typeof options.element === 'string'
      ? globalThis.document?.getElementById(options.element)
      : options.element;
  }

  render(labels = [], metrics = {}) {
    if (!this.element) return;
    clearElement(this.element);
    const doc = this.element.ownerDocument;
    if (!labels.length) {
      this.element.appendChild(createElement('p', { className: 'nd-empty-state', text: 'No labels detected', ownerDocument: doc }));
      return;
    }
    const list = createElement('div', { className: 'nd-legend-list', ownerDocument: doc });
    for (const label of labels) {
      const color = normalizeColor(label.color);
      const volume = metrics?.labelVolumes?.[label.index] ?? metrics?.labelVolumes?.[label.value];
      list.appendChild(createElement('div', { className: 'nd-legend-item', ownerDocument: doc }, [
        createElement('span', { className: 'nd-legend-swatch', style: { backgroundColor: color }, ownerDocument: doc }),
        createElement('span', { className: 'nd-legend-name', text: label.name || `Label ${label.index}`, ownerDocument: doc }),
        volume != null ? createElement('span', { className: 'nd-legend-volume', text: `${Number(volume).toFixed(2)} ml`, ownerDocument: doc }) : null
      ]));
    }
    this.element.appendChild(list);
  }
}

function normalizeColor(color) {
  if (!Array.isArray(color)) return 'rgba(128,128,128,1)';
  const [r, g, b, a = 255] = color;
  return `rgba(${r},${g},${b},${a / 255})`;
}
