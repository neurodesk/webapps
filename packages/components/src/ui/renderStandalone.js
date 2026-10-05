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
    const size = !download.bytes ? '' : download.bytes < 1e9 ? ` · ${(download.bytes / 1e6).toFixed(0)} MB` : ` · ${(download.bytes / 1e9).toFixed(2)} GB`;
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
    if (instructions && (download.parts?.length || download.kind === 'cli')) {
      const details = element('details');
      details.append(element('summary', download.parts?.length ? 'Installation instructions' : 'Extract and run'));
      command(details, `install-${id}`, instructions);
      row.append(details);
    }
    root.append(row);
  };
  if (app.computeServer) {
    const server = app.computeServer;
    const root = section('standalone-compute', 'Compute server · Linux with NVIDIA GPU',
      'Install this on the Linux x86-64 machine that will process the scans. Keep the webapp open on the clinician’s computer.');
    root.append(element('p', 'The compute machine needs an NVIDIA driver, Docker and NVIDIA Container Toolkit. Python and Node.js are not required.'));
    const prerequisites = element('p');
    prerequisites.append(element('a', 'NVIDIA Container Toolkit installation', { href: 'https://docs.nvidia.com/datacenter/cloud-native/container-toolkit/latest/install-guide.html' }));
    root.append(prerequisites);
    const download = server.download;
    root.append(element('h4', '1. Download and extract on the compute machine'));
    if (download) {
      if (download.preview) root.append(element('p', 'Preview build for testing. Full reconstruction on an NVIDIA backend has not yet been validated.', { className: 'nd-message warning' }));
      const links = element('p');
      links.append(element('a', `Download Linux x86-64 backend (${(download.bytes / 1e6).toFixed(1)} MB)`, { href: download.url, download: download.filename }));
      if (download.checksumUrl) links.append(doc.createTextNode(' · '), element('a', 'Checksum file', { href: download.checksumUrl }));
      root.append(links);
      root.append(element('p', 'In a terminal, open the folder where you saved the archive, then run:'));
      command(root, 'compute-extract', `tar -xzf ${download.filename}\ncd ${download.filename.replace(/\.tar\.gz$/, '')}`);
    } else {
      const notice = element('p', 'A released backend download is not available yet. Preview deployments may provide a test archive here. ');
      notice.append(element('a', 'Source and build instructions', { href: server.documentation }));
      root.append(notice);
      root.append(element('p', 'After extracting a backend archive, open a terminal inside its extracted folder.'));
    }
    root.append(element('h4', '2. Check the machine and download NeSVoR'));
    command(root, 'compute-doctor', './neurodesk-compute doctor');
    root.append(element('p', 'Resolve any reported Docker or NVIDIA setup problems. A missing NeSVoR image is expected before this next command, which downloads the pinned scientific container. This first download requires internet access and may take several minutes.'));
    command(root, 'compute-pull', './neurodesk-compute pull --runner docker');
    root.append(element('h4', '3. Start the server and leave the terminal open'));
    const origin = doc.location?.origin;
    const allowOrigin = origin && /^https?:\/\//.test(origin) ? ` --allow-origin '${origin.replaceAll("'", "'\\''")}'` : '';
    command(root, 'compute-start', `./start.sh --runner docker${allowOrigin}`);
    root.append(element('p', 'The terminal prints a listening address such as https://192.168.1.20:8765 and a pair code. Keep the server running. Ctrl+C stops it.'));
    root.append(element('h4', '4. Connect from this webapp'));
    const steps = element('ol');
    for (const text of [
      'On the clinician’s computer, open the printed server address once. For this test build, the default certificate is self-signed; trust it only after confirming it is your own server. A site-trusted certificate is needed for routine deployment.',
      'Return to this webapp and select Remote NeSVoR (Linux NVIDIA). Enter the full https:// address, including :8765, in Compute server.',
      'Copy the pair code from the server terminal into Pairing code and select Connect. The clinician’s computer must be able to reach the compute machine on port 8765.',
    ]) steps.append(element('li', text));
    root.append(steps);
    const details = element('details');
    details.append(element('summary', 'Certificates, network access and model readiness'));
    details.append(element('p', 'Ask your network administrator to allow access from the clinician’s computer to the compute machine on TCP port 8765. Use its LAN address, not localhost, when the computers are separate.'));
    details.append(element('p', 'To use a certificate supplied by your site, replace these example paths:'));
    command(details, 'compute-tls', `./start.sh --runner docker${allowOrigin} --tls-cert /path/to/cert.pem --tls-key /path/to/key.pem`);
    details.append(element('p', 'The archive includes the server and web frontend. Docker, NVIDIA drivers, the NeSVoR container and its model checkpoints are separate. Pulling the image alone has not yet been verified to provide every checkpoint; a successful connection does not establish reconstruction readiness.'));
    details.append(element('a', 'Compute server documentation', { href: server.documentation }));
    root.append(details);
  }
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
    const models = downloads.every(download => download.modelsIncluded) ? 'Models are included.' : 'Models download when first used.';
    const root = section('standalone-downloads', 'Webapp standalone', `Download the archive for your platform. ${models}`);
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
