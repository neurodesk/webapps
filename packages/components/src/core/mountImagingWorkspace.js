import { createElement, resolveElement } from './dom.js';

/**
 * Mount an existing imaging tool inside the shared Neurodesk chrome.
 *
 * The interface deliberately accepts whole coarse-grained regions. It moves the
 * original nodes without cloning or rebuilding them, so application-owned IDs,
 * listeners, canvas state, and scientific workflow code remain untouched.
 */
export function mountImagingWorkspace(config = {}) {
  const doc = config.document || globalThis.document;
  if (!doc) throw new Error('mountImagingWorkspace requires a document');

  const root = resolveElement(config.root || doc.body, doc);
  const controls = resolveElement(config.controls, doc);
  const viewer = resolveElement(config.viewer, doc);
  const status = resolveElement(config.status, doc);

  const existing = root.querySelector(':scope > nd-imaging-workspace');
  if (existing) return existing;

  const workspace = createElement('nd-imaging-workspace', {
    className: 'nd-imaging-workspace',
    ownerDocument: doc,
  });
  const appHeader = createElement('nd-imaging-app-header', {
    className: 'nd-imaging-app-header',
    ownerDocument: doc,
  });
  const brand = createElement('nd-imaging-brand', {
    className: 'nd-imaging-brand',
    ownerDocument: doc,
  }, [
    createElement('span', {
      className: 'nd-imaging-mark',
      text: config.mark || 'N',
      'aria-hidden': 'true',
      ownerDocument: doc,
    }),
    createElement('span', { className: 'nd-imaging-brand-copy', ownerDocument: doc }, [
      createElement('strong', { text: config.title || 'Neurodesk Webapp', ownerDocument: doc }),
      config.subtitle
        ? createElement('small', { text: config.subtitle, ownerDocument: doc })
        : null,
    ]),
  ]);
  const navigation = createElement('nav', {
    className: 'nd-imaging-navigation',
    'aria-label': 'Application navigation',
    ownerDocument: doc,
  }, [
    createElement('a', {
      className: 'nd-header-link',
      href: config.moreAppsHref || '../',
      title: 'More Neurodesk web apps',
      text: 'More Apps',
      ownerDocument: doc,
    }),
  ]);

  appHeader.append(brand, navigation);
  controls.classList.add('nd-imaging-controls');
  viewer.classList.add('nd-imaging-viewer');
  status.classList.add('nd-imaging-status');

  root.insertBefore(workspace, controls);
  workspace.append(appHeader, controls, viewer, status);
  return workspace;
}
