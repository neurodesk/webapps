import { createElement } from '../core/dom.js';

export function renderViewerToolbar(config = {}, doc = globalThis.document) {
  const root = createElement('div', { className: 'nd-viewer-toolbar', ownerDocument: doc });
  const viewTabs = createElement('div', { className: 'nd-view-tabs', ownerDocument: doc });
  for (const view of config.views || defaultViews()) {
    viewTabs.appendChild(createElement('button', {
      className: `nd-view-tab ${view.active ? 'active' : ''}`.trim(),
      type: 'button',
      dataset: { view: view.id },
      text: view.label,
      ownerDocument: doc,
      onclick: view.onClick
    }));
  }

  const actions = createElement('div', { className: 'nd-viewer-actions', ownerDocument: doc }, [
    renderWindowControls(doc),
    renderOverlayControls(doc),
    createElement('select', { className: 'nd-colormap-select', id: 'colormapSelect', ownerDocument: doc }, [
      createElement('option', { value: 'gray', text: 'Gray', ownerDocument: doc }),
      createElement('option', { value: 'red', text: 'Red', ownerDocument: doc }),
      createElement('option', { value: 'blue', text: 'Blue', ownerDocument: doc })
    ]),
    createElement('button', { className: 'nd-btn nd-btn-sm nd-btn-icon', id: 'downloadCurrentVolume', type: 'button', title: 'Download current image as NIfTI', text: 'Download', disabled: true, ownerDocument: doc }),
    createElement('button', { className: 'nd-btn nd-btn-sm nd-btn-icon', id: 'screenshotViewer', type: 'button', title: 'Save screenshot as PNG', text: 'Shot', ownerDocument: doc })
  ]);
  root.append(viewTabs, actions);
  return { root, viewTabs, actions };
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
    createElement('input', { id: 'windowMin', className: 'nd-window-input', type: 'number', placeholder: 'min', step: 'any', ownerDocument: doc }),
    createElement('div', { className: 'nd-range-slider-container', ownerDocument: doc }, [
      createElement('div', { className: 'nd-range-track', ownerDocument: doc }),
      createElement('div', { className: 'nd-range-selected', id: 'rangeSelected', ownerDocument: doc }),
      createElement('input', { id: 'rangeMin', className: 'nd-range-slider nd-range-min', type: 'range', min: 0, max: 100, value: 0, ownerDocument: doc }),
      createElement('input', { id: 'rangeMax', className: 'nd-range-slider nd-range-max', type: 'range', min: 0, max: 100, value: 100, ownerDocument: doc })
    ]),
    createElement('input', { id: 'windowMax', className: 'nd-window-input', type: 'number', placeholder: 'max', step: 'any', ownerDocument: doc }),
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
