import { createElement } from '../core/dom.js';
import { createInfoDialog, renderCommand } from './renderInfoDialog.js';

export function openStandalone({ title, app, suite, installed = false }, doc = globalThis.document) {
  const content = doc.createElement('div');
  const append = (tag, text) => content.append(createElement(tag, { text, ownerDocument: doc }));
  if (installed) append('p', 'This application runs from your installed offline package. Models and runtime dependencies are included.');
  for (const [heading, downloads] of [['Desktop application', app.downloads.filter(item => item.kind === 'desktop')], ['Webapps desktop suite', suite?.downloads || []], ['Command line / HPC', app.downloads.filter(item => item.kind === 'cli')]]) {
    if (!downloads.length) continue;
    append('h3', heading);
    for (const download of downloads) {
      const row = createElement('p', { ownerDocument: doc });
      row.append(createElement('a', { href: download.url, text: `${download.platform} · ${download.version}`, ownerDocument: doc }));
      if (download.parts?.length) row.append(doc.createTextNode(' · Download every part below'));
      if (download.modelsIncluded) row.append(doc.createTextNode(' · Models included'));
      content.append(row);
      for (const [index, part] of (download.parts || []).entries()) {
        const link = createElement('p', { ownerDocument: doc });
        link.append(createElement('a', { href: part.url, text: `Part ${index + 1} of ${download.parts.length} · ${(part.bytes / 1e9).toFixed(2)} GB`, ownerDocument: doc }));
        content.append(link);
      }
      if (download.archiveSha256) append('p', `Complete archive SHA-256: ${download.archiveSha256}`);
      if (download.sha256) content.append(renderCommand({ id: `checksum-${download.kind}-${download.platform}`, command: download.sha256, label: 'SHA-256' }, doc).root);
      if (download.command) content.append(renderCommand({ id: `standalone-${download.kind}-${download.platform}`, command: download.command }, doc).root);
    }
  }
  if (!app.downloads.length && !suite?.downloads?.length && !installed) append('p', 'Offline packages have not been published for this app yet.');
  if (app.containers.length) {
    append('h3', 'Neurodesk container');
    for (const container of app.containers) {
      const row = createElement('p', { ownerDocument: doc });
      row.append(createElement('a', { href: container.url, text: container.label, ownerDocument: doc }));
      content.append(row);
      if (container.description) append('p', container.description);
      if (container.command) content.append(renderCommand({ id: `container-${container.id}`, command: container.command }, doc).root);
    }
  }
  doc.getElementById('neurodeskStandaloneDialog')?.remove();
  const dialog = createInfoDialog({ id: 'neurodeskStandaloneDialog' }, doc);
  dialog.open(`${title} · Standalone`, content, { wide: true });
  return dialog;
}
