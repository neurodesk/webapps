import { createElement } from '../core/dom.js';
import { createInfoDialog, renderCommand } from './renderInfoDialog.js';

const platforms = {
  'macos-arm64': 'macOS · Apple silicon',
  'macos-x64': 'macOS · Intel',
  'windows-x64': 'Windows · x64',
  'linux-x64': 'Linux · x64',
};

export function openStandalone({ title, app, installed = false }, doc = globalThis.document) {
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
    const label = `${title} command line · ${platforms[download.platform] || download.platform}`;
    const size = !download.bytes ? '' : ` · ${(download.bytes / 1e6).toFixed(0)} MB`;
    row.append(element('h4', `${label}${size}`));
    row.append(element('a', 'Download', { href: download.url }));
    // Integrity metadata stays in the release catalog, outside the user flow.
    const instructions = download.command?.split('\n').filter(line => !/sha256|sha-256|shasum|get-filehash/i.test(line)).join('\n');
    if (instructions) {
      const details = element('details');
      details.append(element('summary', download.url.endsWith('.pkg') ? 'Install and run' : 'Extract and run'));
      command(details, `install-${id}`, instructions);
      row.append(details);
    }
    root.append(row);
  };
  const serverDownload = (root, server, missing) => {
    const download = server.download;
    if (download) {
      if (download.preview) root.append(element('p', 'Preview build for testing.', { className: 'nd-message warning' }));
      const links = element('p');
      links.append(element('a', `Download Linux x86-64 server (${(download.bytes / 1e6).toFixed(1)} MB)`, { href: download.url, download: download.filename }));
      if (download.checksumUrl) links.append(doc.createTextNode(' · '), element('a', 'Checksum file', { href: download.checksumUrl }));
      root.append(links);
      root.append(element('p', 'In a terminal, open the folder where you saved the archive, then run:'));
      command(root, 'compute-extract', `tar -xzf ${download.filename}\ncd ${download.filename.replace(/\.tar\.gz$/, '')}`);
      return;
    }
    const notice = element('p', `${missing} `);
    notice.append(element('a', 'Source and build instructions', { href: server.documentation }));
    root.append(notice);
    root.append(element('p', 'After extracting a server archive, open a terminal inside its extracted folder.'));
  };
  if (app.computeServer?.runner === 'slurm') {
    const server = app.computeServer;
    const root = section('standalone-compute', 'Compute server · Slurm cluster',
      'Run the server as yourself on a cluster host that submits Slurm jobs. Your movies stay on the cluster; only the results you open reach this page.');
    root.append(element('p', 'The cluster needs Slurm with job accounting (sacct), Apptainer and, for the GPU steps, NVIDIA GPUs. Python and Node.js are not required. Never run the server as root or as a shared account.'));
    root.append(element('h4', '1. Download the server on a login host'));
    serverDownload(root, server, 'A released server with Slurm support is not available yet.');
    root.append(element('h4', '2. Download the RELION image and the tutorial movies'));
    command(root, 'compute-fetch', './neurodesk-compute fetch-image relion --dest /shared/images\n./neurodesk-compute fetch-example relion-tutorial --dest $HOME/cryo-examples');
    root.append(element('p', 'Put the image where every compute node can read it. The tutorial is 3.2 GB; both downloads resume when rerun.'));
    root.append(element('h4', '3. Describe your cluster in slurm.json'));
    command(root, 'compute-slurm-config', [
      '{',
      '  "apptainer": "/usr/bin/apptainer",',
      '  "image": { "path": "/shared/images/relion/relion_5.1.1.sif" },',
      '  "scratch": "$TMPDIR",',
      '  "profiles": {',
      '    "cpu": { "partition": "cpu", "cpus": 16, "gpus": 0, "memory": "64G", "time": "12:00:00" },',
      '    "gpu": { "partition": "gpu", "account": "lab", "cpus": 24, "gpus": 4, "memory": "128G", "time": "24:00:00" }',
      '  },',
      '  "defaults": {',
      '    "import": "cpu", "motioncorr": "cpu", "ctffind": "cpu", "autopick": "cpu", "extract": "cpu",',
      '    "class2d": "gpu", "select": "cpu", "initialmodel": "gpu", "refine3d": "gpu",',
      '    "maskcreate": "cpu", "postprocess": "cpu"',
      '  }',
      '}',
    ].join('\n'));
    root.append(element('p', 'Use your site’s partitions, account and GPU counts. Every step needs a default profile. A GPU profile for 3D refinement needs at least 3 CPUs. Add "gres": "gpu:a100:4" when your site names GPU types.'));
    root.append(element('h4', '4. Check the compute nodes once per profile'));
    command(root, 'compute-check', './neurodesk-compute check-slurm --slurm-config slurm.json --profile gpu \\\n  --data-root examples=$HOME/cryo-examples --data-dir $HOME/neurodesk-compute');
    root.append(element('p', 'The probe job reports whether the node runs the image, reads the data, writes the project folder and sees its GPUs.'));
    root.append(element('h4', '5. Start the server on that same host and keep it running'));
    command(root, 'compute-start', 'tmux new -s cryo-em\n./neurodesk-compute serve --single-owner --runner slurm --slurm-config slurm.json \\\n  --data-root examples=$HOME/cryo-examples --data-dir $HOME/neurodesk-compute \\\n  --listen 127.0.0.1:8765 --insecure-http --www "$PWD/www"');
    root.append(element('p', 'Add --data-root facility=/path/to/movies for your own data. Other users of the host need a different port. Detach from tmux with Ctrl+B then D.'));
    root.append(element('h4', '6. Connect from your computer'));
    command(root, 'compute-tunnel', 'ssh -N -L 8765:127.0.0.1:8765 you@login2.cluster.example');
    const steps = element('ol');
    for (const text of [
      'Use the exact host name where the server runs, not a login alias that picks a host for you.',
      'Open http://localhost:8765/cryo-em/ in your browser: the server’s own copy of this app.',
      'Pair with the code in $HOME/neurodesk-compute/token on the cluster (cat it there).',
      'Choose the RELION tutorial example and run the steps in order, from Import to Post-processing.',
    ]) steps.append(element('li', text));
    root.append(steps);
    const details = element('details');
    details.append(element('summary', 'Restarts, cancelling and problems'));
    details.append(element('p', 'Jobs keep running in Slurm when the server stops. Start it again with the same command and it follows them again.'));
    details.append(element('p', 'The × in the status bar cancels the running job with scancel. Each job folder holds job.sbatch, run.out and run.err.'));
    details.append(element('p', 'If the server refuses to start after a crash because the data directory is in use, confirm no server is running, then:'));
    command(details, 'compute-unlock', './neurodesk-compute unlock --data-dir $HOME/neurodesk-compute');
    details.append(element('a', 'Compute server documentation', { href: server.documentation }));
    root.append(details);
  } else if (app.computeServer) {
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
  // Only this app's own command line: the all-apps desktop suite is linked from the catalog page.
  const downloads = app.downloads;
  if (downloads.length) {
    // An external command line states its own prerequisites instead of a model note.
    const models = app.commandLine ? '' : downloads.every(download => download.modelsIncluded) ? ' Models are included.' : ' Models download when first used.';
    const root = section('standalone-downloads', 'Command line', `Download the archive for your platform.${models}`);
    if (app.commandLine) {
      for (const note of app.commandLine.notes) root.append(element('p', note));
      const links = element('p');
      for (const [index, link] of app.commandLine.links.entries()) {
        if (index) links.append(doc.createTextNode(' · '));
        links.append(element('a', link.label, { href: link.url }));
      }
      root.append(links);
    }
    for (const [index, download] of downloads.entries()) addDownload(root, download, `platform-${index}`);
  }
  if (!downloads.length && !installed) content.append(element('p', 'Standalone downloads have not been published yet.'));
  doc.getElementById('neurodeskStandaloneDialog')?.remove();
  const dialog = createInfoDialog({ id: 'neurodeskStandaloneDialog' }, doc);
  dialog.open(`${title} · Standalone`, content, { wide: true });
  return dialog;
}
