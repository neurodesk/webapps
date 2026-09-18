import { createElement } from '../core/dom.js';
import { createInfoDialog, renderCommand } from './renderInfoDialog.js';

const platforms = {
  'macos-arm64': 'macOS · Apple silicon',
  'windows-x64': 'Windows · x64',
  'linux-x64': 'Linux · x64',
  'linux-x64-apptainer': 'Apptainer · Linux x64',
  any: 'Every platform',
};

export function openStandalone({ title, app, suite, installed = false }, doc = globalThis.document) {
  const content = doc.createElement('div');
  const element = (tag, text, attributes = {}) => createElement(tag, { text, ...attributes, ownerDocument: doc });
  const section = (id, heading, description) => {
    const root = element('section', undefined, { className: 'nd-dialog-section', 'aria-labelledby': id });
    root.append(element('h3', heading, { id }));
    if (description) root.append(element('p', description));
    content.append(root);
    return root;
  };
  const command = (parent, id, text) => parent.append(renderCommand({ id, command: text }, doc).root);
  const addDownload = (root, download, id) => {
    const row = element('div', undefined, { className: 'nd-download-option' });
    const label = `${download.kind === 'cli' ? `${title} command line · ` : ''}${platforms[download.platform] || download.platform}`;
    const size = download.bytes ? ` · ${(download.bytes / 1e9).toFixed(2)} GB` : '';
    row.append(element('h4', `${label}${size}`));
    if (download.parts?.length) {
      const links = element('p');
      for (const [partIndex, part] of download.parts.entries()) {
        if (partIndex) links.append(doc.createTextNode(' · '));
        links.append(element('a', `Part ${partIndex + 1} of ${download.parts.length}`, { href: part.url }));
      }
      row.append(links);
    } else row.append(element('a', 'Download', { href: download.url }));
    // Integrity metadata stays in the release catalog, outside the user flow.
    const instructions = download.command?.split('\n').filter(line => !/sha256|sha-256|shasum|get-filehash/i.test(line)).join('\n');
    if (download.parts?.length && instructions) {
      const details = element('details');
      details.append(element('summary', 'Installation instructions'));
      command(details, `install-${id}`, instructions);
      row.append(details);
    }
    root.append(row);
  };
  if (installed) content.append(element('p', 'Installed application. Models download when first used, unless a model pack is installed.'));
  if (app.containers.length) {
    const root = section('standalone-neurodesk', 'Neurodesk containers');
    for (const container of app.containers) {
      root.append(element('h4', container.label));
      if (container.dockerImage) {
        const row = element('p');
        row.append(element('a', container.dockerLabel || 'Docker Hub', { href: container.url }));
        root.append(row);
        command(root, `docker-${container.id}`, `docker pull ${container.dockerImage}`);
      }
      if (container.apptainerUrl) {
        const row = element('p');
        row.append(element('a', 'Download Apptainer image', { href: container.apptainerUrl }));
        root.append(row);
        command(root, `apptainer-${container.id}`, `curl -X GET ${container.apptainerUrl} -O`);
      }
    }
  }
  if (app.openrecon) {
    const root = section('standalone-openrecon', 'OpenRecon · MRI scanner console',
      `Run the ${app.openrecon.label} container on the MRI scanner console with OpenRecon.`);
    const download = element('p');
    download.append(doc.createTextNode('Download the official OpenRecon package from the '),
      element('a', 'Siemens teamplay C2P exchange', { href: 'https://webclient.us.api.teamplay.siemens-healthineers.com/c2p' }),
      doc.createTextNode('.'));
    const build = element('p');
    build.append(doc.createTextNode('Or build it using '),
      element('a', 'neurodesk/openrecon', { href: 'https://github.com/neurodesk/openrecon/' }),
      doc.createTextNode(' with the '),
      element('a', `${app.openrecon.label} recipe`, { href: `https://github.com/neurodesk/openrecon/tree/main/recipes/${app.openrecon.recipe}` }),
      doc.createTextNode('.'));
    root.append(download, build);
  }
  const downloads = [...(suite?.downloads || []), ...app.downloads];
  if (downloads.length) {
    const root = section('standalone-downloads', 'Webapp standalone', 'Download the archive for your platform. Models download when first used.');
    for (const [index, download] of downloads.entries()) addDownload(root, download, `platform-${index}`);
  }
  if (suite?.models) {
    const root = section('standalone-models', 'Model pack · optional',
      'Add every model for offline use. Extract the pack and point NEURODESK_MODELS_DIR at that folder before starting the application.');
    addDownload(root, suite.models, 'models');
  }
  if (!downloads.length && !installed) content.append(element('p', 'Standalone downloads have not been published yet.'));
  doc.getElementById('neurodeskStandaloneDialog')?.remove();
  const dialog = createInfoDialog({ id: 'neurodeskStandaloneDialog' }, doc);
  dialog.open(`${title} · Standalone`, content, { wide: true });
  return dialog;
}
