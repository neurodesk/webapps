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

    render(results = {}, stageOrder = Object.keys(results)) {
      this._rendered = true;
      const doc = this.ownerDocument;
      this.replaceChildren();
      if (!stageOrder.length) {
        this.append(createElement('p', {
          className: 'nd-empty-state',
          text: 'No results yet',
          ownerDocument: doc,
        }));
        return;
      }
      const emit = (name, detail) => this.dispatchEvent(new window.CustomEvent(name, {
        detail,
        bubbles: true,
        composed: true,
      }));
      for (const stage of stageOrder) {
        const result = results[stage];
        const label = this.stageLabels[stage] || result?.description || stage;
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
              result,
              visible: event.currentTarget.checked,
              input: event.currentTarget,
            }),
          })])
          : createElement('button', {
            className: 'nd-view-btn',
            type: 'button',
            title: 'View',
            text: 'View',
            ownerDocument: doc,
            onclick: () => emit('nd-view', { stage, result }),
          });
        this.append(createElement('div', {
          className: 'nd-volume-toggle',
          ownerDocument: doc,
        }, [
          viewControl,
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
            onclick: () => emit('nd-download', { stage, result }),
          }),
        ]));
      }
    }
  }, view);
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
