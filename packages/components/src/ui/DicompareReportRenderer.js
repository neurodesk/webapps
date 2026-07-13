import { createElement, clearElement } from '../core/dom.js';

export class DicompareReportRenderer {
  constructor(options = {}) {
    this.element = typeof options.element === 'string'
      ? globalThis.document?.getElementById(options.element)
      : options.element;
  }

  render(report = {}) {
    if (!this.element) return;
    clearElement(this.element);
    const doc = this.element.ownerDocument;
    const acquisitions = report.acquisitions || [];
    const complianceResults = report.complianceResults || [];

    this.element.appendChild(createElement('div', { className: 'nd-report-summary', ownerDocument: doc }, [
      createElement('strong', { text: `${acquisitions.length} acquisition(s)`, ownerDocument: doc }),
      createElement('span', { text: `${countFailures(complianceResults)} issue(s)`, ownerDocument: doc })
    ]));

    for (const group of complianceResults) {
      const section = createElement('section', { className: 'nd-report-section', ownerDocument: doc }, [
        createElement('h4', { text: group.acquisitionName || 'Acquisition', ownerDocument: doc })
      ]);
      if (group.error) {
        section.appendChild(createElement('p', { className: 'nd-report-error', text: group.error, ownerDocument: doc }));
      } else {
        const list = createElement('ul', { className: 'nd-report-list', ownerDocument: doc });
        for (const item of group.results || []) {
          list.appendChild(createElement('li', {
            className: item.passed === false ? 'nd-report-fail' : 'nd-report-pass',
            text: item.message || item.name || JSON.stringify(item),
            ownerDocument: doc
          }));
        }
        section.appendChild(list);
      }
      this.element.appendChild(section);
    }
  }
}

function countFailures(groups = []) {
  return groups.reduce((sum, group) => sum + (group.results || []).filter(item => item.passed === false).length + (group.error ? 1 : 0), 0);
}
