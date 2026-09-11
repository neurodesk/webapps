import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { JSDOM } from 'jsdom';
import { loadAppsRegistry, repoRoot } from '../scripts/lib/apps-registry.mjs';
import { appInformationPayload, loadAppInformation } from '../scripts/lib/app-information.mjs';
import { injectCompositeTheme } from '../scripts/lib/composite-theme.mjs';

// Every hosted app's About and Cite dialogs are fed from
// registry/app-information.yml through the shared shell. These tests keep the
// data complete (who built it, what runs under the hood, a paper for every
// implemented method, the ecosystem statement and the platform citation) and
// keep the shell rendering it.

const registry = await loadAppsRegistry();
const information = await loadAppInformation(registry);

// Methods each app implements, by DOI or URL. Add a line when an app gains a
// method; the entry must then be cited in registry/app-information.yml.
const REQUIRED_METHODS = {
  dwi2trx: ['10.1016/S0006-3495(94)80775-1', 'github.com/dipy/GPUStreamlines', 'PMC5381389', 'brainder.org/2025/05/05/15656/'],
  musclemap: ['10.3390/jimaging10110262', 'arxiv.org/abs/2211.02701', '10.1016/j.jneumeth.2016.03.001'],
  vesselboost: ['10.52294/001c.123217', '10.1109/TMI.2010.2046908', '10.1109/TMI.2007.906087', '10.1109/ICCV.1998.710815', '10.1002/hbm.10062', '10.1016/j.neuroimage.2022.119474'],
  spinalcordtoolbox: ['10.1016/j.neuroimage.2016.10.009', '10.1016/j.media.2025.103473', '10.1038/s41592-020-01008-z', 'arxiv.org/abs/2407.17265', 'github.com/neuropoly/totalspineseg', '10.1155/2014/719520', '10.1016/j.neuroimage.2017.10.041'],
  calmar: ['10.1093/brain/awv228', '10.1016/j.neuroimage.2022.119474', 'SynthStroke', 'arxiv.org/abs/2403.19425', '10.1109/TMI.2021.3116879', '10.1016/j.neuroimage.2010.07.033', '10.1152/jn.00338.2011', '10.1093/cercor/bhx179', '10.1038/s41467-018-03399-2', '10.1038/nmeth.1635'],
  qsmbly: ['10.1002/hbm.10062', '10.1002/mrm.28563', '10.1002/mrm.26963', '10.1002/mrm.23000', '10.1002/nbm.1670', '10.1002/mrm.22135', '10.1002/mrm.22816', '10.1016/j.neuroimage.2015.02.041', '10.1016/j.neuroimage.2020.117701', '10.1016/j.jneumeth.2016.03.001'],
  seedseg: ['10.1101/2023.10.26.564293', '10.1007/978-3-319-46723-8_49', '10.1016/j.jneumeth.2016.03.001'],
  dicompare: ['github.com/astewartau/dicompare', 'pyodide.org', '10.1016/j.jneumeth.2016.03.001'],
  deface: ['10.52294/001c.94384', 'arxiv.org/abs/2506.11860', '10.21105/joss.05098', '10.1098/rstb.2001.0915', '10.1016/j.jneumeth.2016.03.001'],
  'easy-mp2rage': ['10.1016/j.neuroimage.2009.10.002', '10.1371/journal.pone.0069294', '10.1002/mrm.23145', '10.1371/journal.pone.0099676'],
  niimath: ['10.52294/001c.94384', '10.1016/j.jneumeth.2016.03.001'],
  dicom2vid: ['10.1007/s003300101100', 'github.com/Vanilagy/mp4-muxer'],
  browserqc: ['10.1371/journal.pone.0184661', '10.21105/joss.05098', '10.52294/001c.94384', '10.1016/j.jneumeth.2016.03.001'],
  surfannotate: ['10.1016/j.neuroimage.2012.01.021', 'github.com/niivue/niivue'],
  zarro: ['10.1038/s41592-021-01326-w', 'zarr.dev', 'dandiarchive.org'],
  synthseg: ['10.1016/j.media.2023.102789', '10.1016/j.jneumeth.2016.03.001', 'github.com/niivue/niivue'],
  synthsr: ['10.1016/j.neuroimage.2021.118206', 'github.com/neurolabusc/py_synthsr'],
  syncro: ['10.1016/j.neuroimage.2021.118206', 'arxiv.org/abs/2506.11860', '10.1016/j.neuroimage.2022.119474', '10.1016/j.media.2007.06.004', '10.1016/j.neuroimage.2010.07.033'],
  edgereg: ['afni.nimh.nih.gov', '10.1016/j.jneumeth.2016.03.001', 'github.com/niivue/niivue'],
  greedy: ['sites.google.com/view/greedyreg/about', 'github.com/pyushkevich/greedy', 'arxiv.org/abs/2506.11860', '10.1016/j.jneumeth.2016.03.001'],
};

test('every registered app has app information with packages and cited methods', () => {
  for (const app of registry.apps) {
    const info = information.apps[app.id];
    assert.ok(info, `${app.id} has an app-information entry`);
    assert.ok(info.packages.length >= 1, `${app.id} lists what runs under the hood`);
    assert.ok(info.packages.some((item) => /niivue|zarrita|pyodide|rust|mp4-muxer/i.test(item.name)), `${app.id} names its runtime`);
    const cited = info.citations.map((item) => `${item.doi ?? ''} ${item.url ?? ''} ${item.code ?? ''} ${item.title}`).join('\n');
    for (const method of REQUIRED_METHODS[app.id] ?? []) {
      assert.ok(cited.includes(method), `${app.id} must cite ${method}`);
    }
    assert.ok(REQUIRED_METHODS[app.id], `${app.id} has a required-methods list in this test`);
  }
});

test('the shared statements say who builds the apps and which ecosystem they belong to', () => {
  assert.match(information.shared.builder, /Neurodesk team/);
  assert.equal(information.shared.ecosystem, 'This app is part of the lightNIIng ecosystem (lightniing.org), which aims to make neuroimaging tools widely available for clinical translation.');
  assert.equal(information.shared.ecosystem_url, 'https://lightniing.org');
  assert.equal(information.shared.platform_citation.doi, '10.1038/s41592-023-02145-x');
  assert.match(information.shared.platform_citation.reference, /Renton/);
});

test('theme injection carries the app information as one JSON script and stays idempotent', () => {
  const html = '<!doctype html><html><head><title>Demo</title></head><body></body></html>';
  const metadata = {
    appId: 'synthsr', shell: 'imaging-workspace', title: 'SynthSR', description: 'Synthesis.', version: '1.0.0',
    measurementId: 'G-TEST', href: './app-theme.css', themeHref: './theme.js', shellHref: './app-shell.js',
    analyticsHref: './analytics.js', moreAppsHref: '../', iconHref: './neurodesk-logo.svg',
    information: appInformationPayload(information, 'synthsr'),
  };
  const themed = injectCompositeTheme(html, metadata);
  const match = themed.match(/<script type="application\/json" data-neurodesk-app-information>([\s\S]*?)<\/script>/);
  assert.ok(match, 'information script present');
  const parsed = JSON.parse(match[1]);
  assert.equal(parsed.shared.ecosystem, information.shared.ecosystem);
  assert.ok(parsed.citations.some((item) => item.doi === '10.1016/j.neuroimage.2021.118206'));
  assert.ok(!match[1].includes('</script'), 'JSON cannot terminate the script element');
  assert.equal(injectCompositeTheme(themed, metadata), themed, 'second injection is a no-op');
});

async function mountShell(appId, bodyHtml = '') {
  const payload = appInformationPayload(information, appId);
  const html = `<!doctype html><html data-neurodesk-app="${appId}" data-neurodesk-shell="imaging-workspace" data-neurodesk-theme="dark"><head>
    <script type="application/json" data-neurodesk-app-information>${JSON.stringify(payload)}</script>
    <script type="module" src="./app-shell.js" data-neurodesk-app-shell data-app-id="${appId}" data-app-shell="imaging-workspace" data-app-title="Demo" data-app-description="A demo app." data-app-version="1.2.3" data-ga4-measurement-id="G-TEST" data-analytics-href="./analytics.js" data-more-apps-href="../" data-source-href="https://github.com/neurodesk/webapps"></script>
    </head><body>${bodyHtml}</body></html>`;
  const dom = new JSDOM(html, { url: 'https://webapps.neurodesk.org/demo/', pretendToBeVisual: true });
  const { window } = dom;
  window.HTMLDialogElement.prototype.showModal ??= function showModal() { this.setAttribute('open', ''); };
  window.HTMLDialogElement.prototype.close ??= function close() { this.removeAttribute('open'); };
  window.Element.prototype.checkVisibility ??= function checkVisibility() { return true; };
  globalThis.window = window;
  globalThis.document = window.document;
  globalThis.MutationObserver = window.MutationObserver;
  globalThis.requestAnimationFrame = (callback) => setTimeout(callback, 0);
  globalThis.HTMLElement = window.HTMLElement;
  const shell = await readFile(join(repoRoot, 'site', 'app-shell.js'), 'utf8');
  const adapters = await readFile(join(repoRoot, 'site', 'shell-adapters', 'index.js'), 'utf8');
  // The shell is an ES module; evaluate it inline with its adapter resolved.
  const source = shell.replace("import { resolveShellAdapter } from './shell-adapters/index.js';", '')
    .replace(/import\(analyticsUrl\.href\)/, 'Promise.resolve({ initAnalytics() {} })');
  const adapterSource = adapters.replace(/import [^;]+;/g, '').replace(/export /g, '');
  const adapterModules = await Promise.all(['imaging-workspace', 'static-html', 'react'].map(async (name) =>
    (await readFile(join(repoRoot, 'site', 'shell-adapters', `${name}.js`), 'utf8')).replace(/export /g, '')));
  new Function('document', 'window', 'MutationObserver', 'requestAnimationFrame', 'console',
    `${adapterModules.join('\n')}\n${adapterSource}\n${source}`)(window.document, window, window.MutationObserver, globalThis.requestAnimationFrame, console);
  return window;
}

test('the shell Cite action renders every registry citation and the platform paper', async () => {
  const window = await mountShell('syncro');
  window.document.querySelector('.nd-app-bar [data-neurodesk-shell-control="cite"]').click();
  const dialog = window.document.querySelector('.nd-app-dialog[data-dialog="cite"]');
  assert.ok(dialog?.hasAttribute('open'), 'cite dialog opened');
  const text = dialog.textContent;
  for (const item of information.apps.syncro.citations) assert.ok(text.includes(item.title), `cites ${item.title}`);
  assert.ok(text.includes('Renton'), 'platform citation present');
  assert.equal([...dialog.querySelectorAll('h3')].at(-1).textContent, 'Platform');
  assert.ok(dialog.querySelector('a[href="https://doi.org/10.1038/s41592-023-02145-x"]'));
  assert.ok(dialog.querySelector('.nd-app-dialog__close'));
});

test('the shell About action appends the packages, builder and ecosystem block to an app dialog', async () => {
  const window = await mountShell('qsmbly', `
    <button id="openAbout" data-neurodesk-control="about">About</button>
    <div class="modal-overlay" id="aboutModal"><div class="modal"><div class="modal-body"><p>App text</p></div></div></div>`);
  const overlay = window.document.getElementById('aboutModal');
  window.document.getElementById('openAbout').addEventListener('click', () => overlay.classList.add('active'));
  window.document.querySelector('.nd-app-bar [data-neurodesk-shell-control="about"]').click();
  await new Promise((resolve) => setTimeout(resolve, 20));
  const block = overlay.querySelector('.modal-body [data-neurodesk-app-info="about"]');
  assert.ok(block, 'shared block appended inside the app dialog body');
  assert.match(block.textContent, /Under the hood/);
  assert.match(block.textContent, /QSM\.rs/);
  assert.match(block.textContent, /Ashley Stewart/);
  assert.match(block.textContent, /Neurodesk team/);
  assert.match(block.textContent, /lightNIIng ecosystem \(lightniing\.org\), which aims to make neuroimaging tools widely available for clinical translation/);
  assert.ok(block.querySelector('a[href="https://lightniing.org"]'), 'About links to lightniing.org');
  assert.ok(window.document.querySelector('.nd-app-bar a[href="https://lightniing.org"]'), 'app bar links to lightniing.org');
  assert.equal(overlay.querySelectorAll('[data-neurodesk-app-info="about"]').length, 1);
  window.document.querySelector('.nd-app-bar [data-neurodesk-shell-control="about"]').click();
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(overlay.querySelectorAll('[data-neurodesk-app-info="about"]').length, 1, 'block is not duplicated on reopen');
});

test('the shell About fallback uses registry paragraphs when the app has no About dialog', async () => {
  const window = await mountShell('zarro');
  window.document.querySelector('.nd-app-bar [data-neurodesk-shell-control="about"]').click();
  const dialog = window.document.querySelector('.nd-app-dialog[data-dialog="about"]');
  assert.ok(dialog?.hasAttribute('open'));
  assert.match(dialog.textContent, /OME-Zarr/);
  assert.match(dialog.textContent, /zarrita/);
  assert.match(dialog.textContent, /lightniing\.org/);
});
