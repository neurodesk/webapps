import assert from 'node:assert/strict';
import test from 'node:test';
import { mountAppShell } from '../test-utils/mount-app-shell.mjs';

// Every hosted app carries one Support action in the shared application bar. It
// opens a GitHub issue that already knows which app, build and browser the
// report came from, and asks the reporter for reproduction steps or a feature
// suggestion.

const supportLink = (window) => window.document.querySelector('.nd-app-bar a[title="Report a problem or suggest a feature on GitHub"]');

function issueUrl(window) {
  const link = supportLink(window);
  link.click();
  return new URL(link.href);
}

test('the shared bar offers Support alongside the other application actions', async () => {
  const window = await mountAppShell({ appId: 'zarro', title: 'ZARRo' });
  const actions = [...window.document.querySelectorAll('.nd-app-bar__navigation .nd-app-bar__action span')]
    .map((span) => span.textContent);
  assert.deepEqual(actions, ['About', 'Cite', 'Standalone', 'Privacy', 'Support', 'Light', 'More Apps', 'GitHub']);
  const link = supportLink(window);
  assert.equal(link.target, '_blank');
  assert.equal(link.rel, 'noopener noreferrer');
  assert.equal(window.document.querySelectorAll('.nd-app-bar__navigation .nd-app-bar__action').length, actions.length);
});

test('Support opens a new issue on the webapps repository, not the app subdirectory', async () => {
  const window = await mountAppShell({ appId: 'qsmbly', title: 'QSMbly' });
  const url = issueUrl(window);
  assert.equal(url.origin + url.pathname, 'https://github.com/neurodesk/webapps/issues/new');
  assert.equal(url.searchParams.get('title'), '[QSMbly] ');
});

test('the prefilled issue asks for reproduction steps and welcomes a feature suggestion', async () => {
  const window = await mountAppShell({ appId: 'zarro', title: 'ZARRo' });
  const body = issueUrl(window).searchParams.get('body');
  assert.match(body, /## What happened, or what would you like this app to do\?/);
  assert.match(body, /## How can we reproduce the problem\?/);
  assert.match(body, /Leave this out for a feature suggestion\./);
  assert.match(body, /## What did you expect instead\?/);
  assert.match(body, /## Browser console output/);
  assert.match(body, /do not upload identifiable patient data/);
});

test('the prefilled issue carries the app, build and browser facts a maintainer needs', async () => {
  const window = await mountAppShell({ appId: 'synthsr', title: 'SynthSR', version: '0.4.20260715' });
  const body = issueUrl(window).searchParams.get('body');
  assert.match(body, /\| App \| SynthSR \(synthsr\) \|/);
  assert.match(body, /\| Version \| v0\.4\.20260715 \|/);
  assert.match(body, /\| Page \| https:\/\/webapps\.neurodesk\.org\/synthsr\/ \|/);
  assert.match(body, new RegExp(`\\| Browser \\| ${window.navigator.userAgent.replace(/[.()/\\]/g, '\\$&')} \\|`));
  assert.match(body, /\| WebGPU \| unavailable \|/);
  assert.match(body, /\| Cross-origin isolated \| no \|/);
});

test('the reported version follows the scientific version the shell syncs into the bar', async () => {
  const window = await mountAppShell({ appId: 'qsmbly', title: 'QSMbly', version: '0.1.20260101' });
  const display = window.document.createElement('span');
  display.id = 'appVersion';
  display.textContent = 'v2.5.1';
  window.document.body.append(display);
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.match(issueUrl(window).searchParams.get('body'), /\| Version \| v2\.5\.1 \|/);
});

test('the reported page address drops query and fragment so it cannot carry a filename', async () => {
  const window = await mountAppShell({ appId: 'deface', title: 'Deface', url: 'https://webapps.neurodesk.org/deface/?file=patient-smith.nii#t=3' });
  const body = issueUrl(window).searchParams.get('body');
  assert.match(body, /\| Page \| https:\/\/webapps\.neurodesk\.org\/deface\/ \|/);
  assert.doesNotMatch(body, /patient-smith/);
});
