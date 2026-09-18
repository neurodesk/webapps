import { createElement } from '../core/dom.js';
import { defineElement, upgradeProperties } from './define.js';

let nextId = 0;

export function defineViewerToolbar(view) {
  return defineElement('nd-viewer-toolbar', createToolbarClass, view);
}

function createToolbarClass(view) {
  return class NeurodeskViewerToolbar extends view.HTMLElement {
    #initialized = false;
    #options = {};
    #controls = new Map();

    connectedCallback() {
      upgradeProperties(this, ['options']);
      this.initialize();
    }

    get options() { return this.#options; }
    set options(value) {
      if (this.#initialized) throw new Error('Set toolbar options before initialization');
      this.#options = value;
    }

    control(name) {
      this.initialize();
      return this.#controls.get(name) || null;
    }

    setActive(id) {
      this.initialize();
      for (const tab of this.viewTabs.querySelectorAll('.nd-view-tab')) {
        const active = tab.dataset.view === id;
        tab.classList.toggle('active', active);
        tab.setAttribute('aria-pressed', String(active));
      }
    }

    initialize() {
      if (this.#initialized) return;
      this.#initialized = true;
      const config = this.#options;
      const doc = this.ownerDocument;
      const root = this;
      this.classList.add('nd-viewer-toolbar');
      this.id ||= `nd-viewer-toolbar-${++nextId}`;
      const viewTabs = createElement('div', { className: 'nd-view-tabs', role: 'group', 'aria-label': config.viewsLabel || 'Displayed view', ownerDocument: doc });
      const views = config.views === undefined ? defaultViews() : (config.views || []);
      for (const view of views) {
        viewTabs.appendChild(createElement('button', {
          className: `nd-view-tab ${view.active ? 'active' : ''}`.trim(),
          type: 'button',
          id: view.buttonId,
          dataset: { view: view.id },
          text: view.label,
          disabled: view.disabled,
          hidden: view.hidden,
          ownerDocument: doc,
          onclick: view.onClick
        }));
      }

      const actions = createElement('div', { className: 'nd-viewer-actions', ownerDocument: doc }, [
        config.window !== false ? renderWindowControls(doc) : null,
        config.overlay !== false ? renderOverlayControls(doc) : null,
        config.colormap !== false ? createElement('select', { className: 'nd-colormap-select', id: 'colormapSelect', 'aria-label': 'Colormap', ownerDocument: doc }, [
          createElement('option', { value: 'gray', text: 'Gray', ownerDocument: doc }),
          createElement('option', { value: 'red', text: 'Red', ownerDocument: doc }),
          createElement('option', { value: 'blue', text: 'Blue', ownerDocument: doc })
        ]) : null,
        ...(config.actions || []),
        config.download !== false ? createElement('button', { className: 'nd-btn nd-btn-sm nd-btn-icon', id: 'downloadCurrentVolume', type: 'button', title: 'Download current image as NIfTI', text: 'Download', disabled: true, ownerDocument: doc }) : null,
        config.screenshot !== false ? createElement('button', { className: 'nd-btn nd-btn-sm nd-btn-icon', id: 'screenshotViewer', type: 'button', title: 'Save screenshot as PNG', text: 'Shot', ownerDocument: doc }) : null,
      ]);
      root.append(viewTabs, actions);
      this.viewTabs = viewTabs;
      this.actions = actions;
      for (const control of actions.querySelectorAll('[id]')) {
        // App-supplied actions retain their own IDs.
        if (config.actions?.some(action => action === control || action.contains(control))) continue;
        const name = control.id;
        control.dataset.ndControl = name;
        control.id = `${this.id}-${name}`;
        this.#controls.set(name, control);
      }
      const emit = (name, detail) => this.dispatchEvent(new view.CustomEvent(name, { detail, bubbles: true, composed: true }));
      for (const tab of viewTabs.children) {
        tab.setAttribute('aria-pressed', String(tab.classList.contains('active')));
        tab.addEventListener('click', () => {
          if (!views.find(item => item.id === tab.dataset.view)?.onClick) this.setActive(tab.dataset.view);
          emit('nd-view-change', { value: tab.dataset.view });
        });
      }
      for (const [control, event, name] of [
        ['overlayOpacity', 'input', 'nd-overlay-change'],
        ['colormapSelect', 'change', 'nd-colormap-change'],
        ['downloadCurrentVolume', 'click', 'nd-download'],
        ['screenshotViewer', 'click', 'nd-screenshot'],
        ['resetWindow', 'click', 'nd-window-reset'],
      ]) {
        this.#controls.get(control)?.addEventListener(event, e => {
          const value = control === 'overlayOpacity' ? Number(e.currentTarget.value) : e.currentTarget.value;
          if (control === 'overlayOpacity') this.#controls.get('overlayOpacityValue').textContent = `${Math.round(value * 100)}%`;
          emit(name, { value });
        });
      }
      for (const name of ['windowMin', 'windowMax', 'rangeMin', 'rangeMax']) {
        this.#controls.get(name)?.addEventListener(name.startsWith('range') ? 'input' : 'change', e => {
          emit('nd-window-change', { control: name, value: Number(e.currentTarget.value) });
        });
      }
    }
  };
}

export function createViewerToolbar(config = {}, doc = globalThis.document) {
  defineViewerToolbar(doc.defaultView);
  const element = doc.createElement('nd-viewer-toolbar');
  element.options = config;
  element.initialize();
  return element;
}

function defaultViews() {
  return [
    { id: 'multiplanar', label: '3-Plane', active: true },
    { id: 'axial', label: 'Axial' },
    { id: 'coronal', label: 'Coronal' },
    { id: 'sagittal', label: 'Sagittal' },
    { id: 'render', label: '3D' }
  ];
}

function renderWindowControls(doc) {
  return createElement('div', { className: 'nd-window-controls', ownerDocument: doc }, [
    createElement('input', { id: 'windowMin', className: 'nd-window-input', type: 'number', placeholder: 'min', step: 'any', 'aria-label': 'Window minimum', ownerDocument: doc }),
    createElement('div', { className: 'nd-range-slider-container', ownerDocument: doc }, [
      createElement('div', { className: 'nd-range-track', ownerDocument: doc }),
      createElement('div', { className: 'nd-range-selected', id: 'rangeSelected', ownerDocument: doc }),
      createElement('input', { id: 'rangeMin', className: 'nd-range-slider nd-range-min', type: 'range', min: 0, max: 100, value: 0, 'aria-label': 'Window minimum', ownerDocument: doc }),
      createElement('input', { id: 'rangeMax', className: 'nd-range-slider nd-range-max', type: 'range', min: 0, max: 100, value: 100, 'aria-label': 'Window maximum', ownerDocument: doc })
    ]),
    createElement('input', { id: 'windowMax', className: 'nd-window-input', type: 'number', placeholder: 'max', step: 'any', 'aria-label': 'Window maximum', ownerDocument: doc }),
    createElement('button', { className: 'nd-btn nd-btn-sm', id: 'resetWindow', type: 'button', text: 'Auto', ownerDocument: doc })
  ]);
}

function renderOverlayControls(doc) {
  return createElement('label', { className: 'nd-opacity-control', id: 'overlayOpacityControl', ownerDocument: doc }, [
    'Overlay',
    createElement('input', { id: 'overlayOpacity', type: 'range', min: 0, max: 1, step: 0.05, value: 0.5, ownerDocument: doc }),
    createElement('span', { id: 'overlayOpacityValue', text: '50%', ownerDocument: doc })
  ]);
}
