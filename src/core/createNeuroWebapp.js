import { appendChildren, clearElement, createElement, resolveElement } from './dom.js';
import { ConsoleOutput } from '../ui/ConsoleOutput.js';
import { ProgressManager } from '../ui/ProgressManager.js';
import { ModalManager } from '../ui/ModalManager.js';
import { renderSidebarSection } from '../ui/renderSidebarSection.js';
import { renderViewerToolbar } from '../ui/renderViewerToolbar.js';

export function createNeuroWebapp(config = {}) {
  const root = resolveElement(config.root || globalThis.document?.body);
  const doc = root.ownerDocument || globalThis.document;
  clearElement(root);

  const container = createElement('div', { className: 'nd-app-container', ownerDocument: doc });
  const header = renderHeader(config, doc);
  const sidebar = createElement('aside', { className: 'nd-app-sidebar', id: config.sidebarId || 'sidebar', ownerDocument: doc });
  const sidebarScroll = createElement('div', { className: 'nd-sidebar-scroll', ownerDocument: doc });
  const sidebarStatus = renderStatusBar(doc);
  const main = createElement('main', { className: 'nd-app-main', ownerDocument: doc });
  const toolbar = renderViewerToolbar(config.viewerToolbar || {}, doc);
  const canvasWrapper = createElement('div', { className: 'nd-viewer-canvas-wrapper', ownerDocument: doc }, [
    createElement('canvas', { id: config.canvasId || 'gl1', ownerDocument: doc })
  ]);
  const viewerInfo = renderViewerInfo(doc);
  const consoleBlock = renderConsole(doc);
  const footer = renderFooter(config, doc);
  const modalRoot = createElement('div', { className: 'nd-modal-root', ownerDocument: doc });

  sidebar.append(sidebarScroll, sidebarStatus.root);
  main.append(toolbar.root, canvasWrapper, viewerInfo.root, consoleBlock.root);
  container.append(header.root, sidebar, main, footer.root, modalRoot);
  root.appendChild(container);

  const consoleOutput = new ConsoleOutput({ element: consoleBlock.output });
  const progress = new ProgressManager({
    barElement: sidebarStatus.progressBar,
    textElement: sidebarStatus.statusText,
    animationSpeed: config.progress?.animationSpeed ?? 0.5
  });

  const app = {
    root,
    container,
    refs: {
      header: header.root,
      sidebar,
      sidebarScroll,
      sidebarStatus: sidebarStatus.root,
      statusText: sidebarStatus.statusText,
      progressBar: sidebarStatus.progressBar,
      main,
      toolbar: toolbar.root,
      canvas: canvasWrapper.querySelector('canvas'),
      viewerInfo: viewerInfo.root,
      viewerInfoPrimary: viewerInfo.primary,
      viewerInfoLabel: viewerInfo.label,
      console: consoleBlock.root,
      consoleOutput: consoleBlock.output,
      footer: footer.root,
      modalRoot
    },
    console: consoleOutput,
    progress,
    modals: new Map(),
    sections: new Map(),
    setStatus(text) {
      sidebarStatus.statusText.textContent = text ?? '';
    },
    setProgress(value, text) {
      progress.setProgress(value, text);
    },
    addSidebarSection(sectionConfig) {
      const section = renderSidebarSection(sectionConfig, doc);
      sidebarScroll.appendChild(section.root);
      if (sectionConfig?.id) app.sections.set(sectionConfig.id, section);
      return section;
    },
    addModal(modalConfig) {
      const modal = renderModal(modalConfig, doc);
      modalRoot.appendChild(modal.root);
      const manager = new ModalManager({ element: modal.root });
      if (modalConfig?.id) app.modals.set(modalConfig.id, manager);
      return { ...modal, manager };
    },
    registerPlugin(plugin) {
      if (typeof plugin?.register === 'function') plugin.register(app);
      return app;
    },
    destroy() {
      progress.stopAnimation();
      clearElement(root);
    }
  };

  for (const section of config.sidebarSections || []) app.addSidebarSection(section);
  for (const modal of config.modals || []) app.addModal(modal);
  for (const plugin of config.plugins || []) app.registerPlugin(plugin);

  return app;
}

function renderHeader(config, doc) {
  const title = config.title || 'Neurodesk Webapp';
  const subtitle = config.subtitle || '';
  const version = config.version || '';
  const root = createElement('header', { className: 'nd-app-header', ownerDocument: doc });
  const brand = createElement('div', { className: 'nd-logo', ownerDocument: doc }, [
    config.logo
      ? createElement('img', { className: 'nd-logo-icon', src: config.logo, alt: '', ownerDocument: doc })
      : null,
    createElement('h1', { ownerDocument: doc }, [
      title,
      subtitle ? createElement('span', { text: subtitle, ownerDocument: doc }) : null,
      version ? createElement('span', { className: 'nd-version', text: version, ownerDocument: doc }) : null
    ])
  ]);
  const links = createElement('div', { className: 'nd-header-links', ownerDocument: doc });
  for (const action of config.headerActions || defaultHeaderActions()) {
    links.appendChild(createElement('button', {
      className: 'nd-header-link',
      id: action.id,
      type: 'button',
      title: action.title || action.label,
      text: action.label,
      ownerDocument: doc,
      onclick: action.onClick
    }));
  }
  root.append(brand, links);
  return { root, brand, links };
}

function defaultHeaderActions() {
  return [
    { id: 'aboutButton', label: 'About' },
    { id: 'citationsButton', label: 'Citations' },
    { id: 'privacyButton', label: 'Privacy' }
  ];
}

function renderStatusBar(doc) {
  const statusText = createElement('span', { className: 'nd-status-value', id: 'statusText', text: 'Ready', ownerDocument: doc });
  const progressBar = createElement('div', { className: 'nd-progress-fill', id: 'progressBar', ownerDocument: doc });
  const root = createElement('div', { className: 'nd-sidebar-status', ownerDocument: doc }, [
    createElement('div', { className: 'nd-status-header', ownerDocument: doc }, [
      createElement('span', { className: 'nd-status-label', text: 'Status', ownerDocument: doc }),
      statusText
    ]),
    createElement('div', { className: 'nd-progress-bar', ownerDocument: doc }, [progressBar])
  ]);
  return { root, statusText, progressBar };
}

function renderViewerInfo(doc) {
  const primary = createElement('div', { className: 'nd-viewer-info-primary', id: 'viewerInfoPrimary', text: 'No volume loaded', ownerDocument: doc });
  const label = createElement('div', { className: 'nd-viewer-info-label', id: 'viewerInfoLabel', ownerDocument: doc });
  const root = createElement('div', { className: 'nd-viewer-info', ownerDocument: doc }, [primary, label]);
  return { root, primary, label };
}

function renderConsole(doc) {
  const output = createElement('div', { className: 'nd-console-output', id: 'consoleOutput', ownerDocument: doc });
  const root = createElement('div', { className: 'nd-console-container', id: 'console', ownerDocument: doc }, [
    createElement('div', { className: 'nd-console-header', ownerDocument: doc }, [
      createElement('span', { className: 'nd-console-title', text: 'Console', ownerDocument: doc }),
      createElement('button', { className: 'nd-console-clear', id: 'clearConsole', text: 'Clear', type: 'button', ownerDocument: doc })
    ]),
    output
  ]);
  root.querySelector('#clearConsole')?.addEventListener('click', () => { output.innerHTML = ''; });
  return { root, output };
}

function renderFooter(config, doc) {
  const root = createElement('footer', { className: 'nd-app-footer', ownerDocument: doc }, [
    createElement('span', { text: config.footerText || 'Runs locally in your browser.', ownerDocument: doc }),
    createElement('span', { id: 'footerVersion', text: config.version ? `v${config.version}` : '', ownerDocument: doc })
  ]);
  return { root };
}

function renderModal(config = {}, doc) {
  const body = createElement('div', { className: 'nd-modal-body', ownerDocument: doc });
  if (config.content?.nodeType) body.appendChild(config.content);
  else if (Array.isArray(config.content)) appendChildren(body, config.content);
  else if (config.content) body.textContent = String(config.content);

  const root = createElement('div', { className: 'nd-modal-overlay', id: config.id, ownerDocument: doc }, [
    createElement('div', { className: `nd-modal ${config.className || ''}`.trim(), ownerDocument: doc }, [
      createElement('div', { className: 'nd-modal-header', ownerDocument: doc }, [
        createElement('h3', { text: config.title || '', ownerDocument: doc }),
        createElement('button', { className: 'nd-modal-close', type: 'button', text: 'x', ownerDocument: doc })
      ]),
      body
    ])
  ]);
  root.querySelector('.nd-modal-close')?.addEventListener('click', () => root.classList.remove('active'));
  return { root, body };
}
