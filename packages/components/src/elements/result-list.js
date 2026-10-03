import { createElement } from '../core/dom.js';
import { defineElement } from './define.js';

export function defineResultList(view = globalThis.window) {
  return defineElement('nd-result-list', (window) => class ResultList extends window.HTMLElement {
    constructor() {
      super();
      this.stageLabels ??= {};
      this._rendered = false;
    }

    connectedCallback() {
      if (!this._rendered) this.render();
    }

    // Rows are kept, keyed by stage, when a re-render leaves their structure
    // unchanged: an app that re-renders while the user presses a button (say,
    // on a field's change event, which fires as the pointer goes down) must
    // not replace the button before its click arrives.
    render(results = {}, stageOrder = Object.keys(results)) {
      this._rendered = true;
      const doc = this.ownerDocument;
      if (!stageOrder.length) {
        this.replaceChildren(createElement('p', {
          className: 'nd-empty-state',
          text: 'No results yet',
          ownerDocument: doc,
        }));
        return;
      }
      const existing = new Map();
      for (const row of this.querySelectorAll(':scope > .nd-volume-toggle')) existing.set(row.dataset.stage, row);
      const rows = stageOrder.map((stage) => {
        const result = results[stage];
        const label = this.stageLabels[stage] || result?.description || stage;
        const signature = rowSignature(result, label);
        const kept = existing.get(stage);
        if (kept && kept._signature === signature) {
          kept._result = result;
          const checkbox = kept.querySelector('.nd-result-visibility input');
          if (checkbox) checkbox.checked = result.visible;
          return kept;
        }
        return this._createRow(stage, result, label, signature);
      });
      this.querySelector(':scope > .nd-empty-state')?.remove();
      for (const row of existing.values()) {
        if (!rows.includes(row)) row.remove();
      }
      rows.forEach((row, index) => {
        if (this.children[index] !== row) this.insertBefore(row, this.children[index] ?? null);
      });
    }

    _createRow(stage, result, label, signature) {
      const doc = this.ownerDocument;
      const window = doc.defaultView;
      const emit = (name, detail) => this.dispatchEvent(new window.CustomEvent(name, {
        detail,
        bubbles: true,
        composed: true,
      }));
      let row;
      // A result that has no image (a table, a report) keeps the column but cannot be viewed.
      const viewButton = () => createElement('button', {
        className: 'nd-view-btn',
        type: 'button',
        title: result?.viewable === false ? 'Download to open' : 'View',
        text: 'View',
        disabled: result?.viewable === false && typeof result?.visible !== 'boolean',
        ownerDocument: doc,
        onclick: () => emit('nd-view', { stage, result: row._result }),
      });
      const viewControl = typeof result?.visible === 'boolean'
        ? createElement('label', {
          className: 'nd-result-visibility',
          title: `Show or hide ${label}`,
          ownerDocument: doc,
        }, [createElement('input', {
          type: 'checkbox',
          checked: result.visible,
          'aria-label': `Show ${label}`,
          ownerDocument: doc,
          onchange: (event) => emit('nd-visibility-change', {
            stage,
            result: row._result,
            visible: event.currentTarget.checked,
            input: event.currentTarget,
          }),
        })])
        : viewButton();
      row = createElement('div', {
        className: 'nd-volume-toggle',
        'data-stage': stage,
        ownerDocument: doc,
      }, [
        viewControl,
        ...(typeof result?.visible === 'boolean' && result.viewable ? [viewButton()] : []),
        createElement('span', {
          className: 'nd-stage-label',
          text: label,
          ownerDocument: doc,
        }),
        createElement('button', {
          className: 'nd-download-btn',
          type: 'button',
          title: 'Download',
          text: 'Download',
          ownerDocument: doc,
          onclick: () => emit('nd-download', { stage, result: row._result }),
        }),
      ]);
      row._result = result;
      row._signature = signature;
      return row;
    }
  }, view);
}

// What a row's markup depends on, besides the result it reports.
function rowSignature(result, label) {
  return JSON.stringify([label, typeof result?.visible === 'boolean', Boolean(result?.viewable), result?.viewable === false]);
}

export function createResultList(options = {}, doc = globalThis.document) {
  const target = typeof options.element === 'string'
    ? doc.getElementById(options.element)
    : options.element;
  doc = target?.ownerDocument || doc;
  defineResultList(doc.defaultView);
  const element = target?.localName === 'nd-result-list' ? target : doc.createElement('nd-result-list');
  element.stageLabels = options.stageLabels || element.stageLabels;
  if (options.onView) {
    element.addEventListener('nd-view', ({ detail }) => options.onView(detail.stage, detail.result));
  }
  if (options.onDownload) {
    element.addEventListener('nd-download', ({ detail }) => options.onDownload(detail.stage, detail.result));
  }
  if (options.onVisibilityChange) {
    element.addEventListener('nd-visibility-change', ({ detail }) => {
      options.onVisibilityChange(detail.stage, detail.visible, detail.result, detail.input);
    });
  }
  if (target && target !== element) {
    for (const attribute of target.attributes) element.setAttribute(attribute.name, attribute.value);
    target.replaceWith(element);
  }
  return element;
}
