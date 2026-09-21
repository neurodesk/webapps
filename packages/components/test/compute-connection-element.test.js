import assert from 'node:assert/strict';
import test from 'node:test';
import { JSDOM } from 'jsdom';
import { createComputeConnection, defineComputeConnection } from '../src/elements/compute-connection.js';

function setup(url = 'https://webapps.neurodesk.org/nesvor/') {
  const { window } = new JSDOM('<!doctype html><body></body>', { url, pretendToBeVisual: true });
  defineComputeConnection(window);
  return window;
}

function fakeClient(info, { reject } = {}) {
  const calls = [];
  const createClient = options => {
    calls.push(options);
    return {
      baseUrl: options.baseUrl,
      async info() {
        if (reject) throw reject;
        return typeof info === 'function' ? info(options) : info;
      },
    };
  };
  return { createClient, calls };
}

const tick = () => new Promise(resolve => setTimeout(resolve, 5));

test('the element imports without browser globals', async () => {
  assert.equal(globalThis.window, undefined);
  const module = await import('../src/elements/compute-connection.js?node-import');
  assert.equal(typeof module.createComputeConnection, 'function');
});

test('the panel is built from the shared field, row, button and message vocabulary', () => {
  const window = setup();
  const panel = createComputeConnection({ storageKey: 'test', autodetect: false }, window.document);
  window.document.body.append(panel);
  assert.equal(panel.querySelectorAll('.nd-field').length, 2);
  assert.equal(panel.querySelector('.nd-field label').textContent, 'Server address');
  assert.equal(panel.addressInput.type, 'text');
  assert.equal(panel.tokenInput.type, 'password');
  assert.equal(panel.querySelector('.nd-row .nd-btn.nd-btn-secondary').textContent, 'Connect');
  assert.equal(panel.message.className, 'nd-message');
  assert.equal(panel.message.getAttribute('role'), 'status');
  assert.equal(panel.dataset.state, 'idle');
  assert.equal(panel.querySelectorAll('.nd-hint').length >= 1, true);
});

test('connect validates the address, stores it, and exposes the client on success', async () => {
  const window = setup();
  const { createClient, calls } = fakeClient({ service: 'neurodesk-compute', tools: [{ id: 'nesvor', version: '0.5.0' }], runner: 'docker', gpu: { available: true, name: 'A6000' } });
  const panel = createComputeConnection({ storageKey: 'test', autodetect: false, createClient }, window.document);
  window.document.body.append(panel);
  const states = [];
  panel.addEventListener('nd-compute-change', event => states.push(event.detail.state));
  await panel.connect();
  assert.equal(panel.state, 'error');
  assert.match(panel.message.textContent, /Enter the address/);
  panel.address = '192.168.1.20:8765';
  panel.token = 'secret';
  const client = await panel.connect();
  assert.ok(client);
  assert.equal(calls.at(-1).baseUrl, 'https://192.168.1.20:8765');
  assert.equal(calls.at(-1).token, 'secret');
  assert.equal(panel.state, 'connected');
  assert.equal(panel.client, client);
  assert.match(panel.message.textContent, /Connected to 192\.168\.1\.20:8765/);
  assert.match(panel.message.textContent, /nesvor 0\.5\.0/);
  assert.match(panel.message.textContent, /A6000/);
  assert.equal(panel.message.className, 'nd-message success');
  assert.equal(panel.addressInput.disabled, true);
  assert.equal(panel.querySelector('.nd-row button:not([hidden])').textContent, 'Disconnect');
  assert.deepEqual(JSON.parse(window.localStorage.getItem('test')), { address: 'https://192.168.1.20:8765', token: 'secret' });
  assert.deepEqual(states, ['error', 'connecting', 'connected']);
  panel.disconnect();
  assert.equal(panel.state, 'idle');
  assert.equal(panel.client, null);
  assert.equal(panel.addressInput.disabled, false);
});

test('a simulated server is labelled and a rejected token is explained', async () => {
  const window = setup();
  const simulated = fakeClient({ service: 'neurodesk-compute', simulated: true, tools: [{ id: 'nesvor', version: '0.5.0' }], runner: 'simulate', gpu: { available: false, name: null } });
  const panel = createComputeConnection({ storageKey: 'a', autodetect: false, createClient: simulated.createClient }, window.document);
  window.document.body.append(panel);
  panel.address = 'http://localhost:8766';
  panel.token = 't';
  await panel.connect();
  assert.equal(panel.state, 'simulated');
  assert.ok(panel.client, 'a simulated server still yields a client');
  assert.match(panel.message.textContent, /Simulated mode/);
  assert.equal(panel.message.className, 'nd-message warning');
  const anonymous = fakeClient({ service: 'neurodesk-compute' });
  const other = createComputeConnection({ storageKey: 'b', autodetect: false, createClient: anonymous.createClient }, window.document);
  window.document.body.append(other);
  other.address = 'http://localhost:8766';
  await other.connect();
  assert.equal(other.state, 'error');
  assert.match(other.message.textContent, /needs an access token/);
  other.token = 'wrong';
  await other.connect();
  assert.match(other.message.textContent, /rejected the access token/);
});

test('network failures are explained from the two origins', async () => {
  const window = setup('https://webapps.neurodesk.org/nesvor/');
  const failing = fakeClient(null, { reject: new TypeError('Failed to fetch') });
  const panel = createComputeConnection({ storageKey: 'c', autodetect: false, createClient: failing.createClient }, window.document);
  window.document.body.append(panel);
  panel.address = 'http://192.168.1.20:8765';
  await panel.connect();
  assert.equal(panel.state, 'error');
  assert.match(panel.message.textContent, /HTTPS/);
  panel.address = 'https://192.168.1.20:8765';
  await panel.connect();
  assert.match(panel.message.textContent, /accept the certificate/);
});

test('a token in the page URL is adopted once and removed from the address bar', async () => {
  const window = setup('http://192.168.1.20:8765/?token=abc123&x=1#top');
  const detected = fakeClient({ service: 'neurodesk-compute' });
  const panel = createComputeConnection({ storageKey: 'd', createClient: detected.createClient }, window.document);
  window.document.body.append(panel);
  await tick();
  assert.equal(panel.token, 'abc123');
  assert.equal(panel.address, 'http://192.168.1.20:8765');
  assert.equal(window.location.search, '?x=1');
  assert.equal(window.location.hash, '#top');
  assert.deepEqual(JSON.parse(window.localStorage.getItem('d')), { address: 'http://192.168.1.20:8765', token: 'abc123' });
});

test('a page served by a compute server adopts its own origin', async () => {
  const window = setup('http://192.168.1.20:8765/nesvor/');
  const detected = fakeClient({ service: 'neurodesk-compute' });
  const panel = createComputeConnection({ storageKey: 'e', createClient: detected.createClient }, window.document);
  window.document.body.append(panel);
  await tick();
  assert.equal(panel.address, 'http://192.168.1.20:8765');
  assert.equal(detected.calls[0].baseUrl, 'http://192.168.1.20:8765');
  assert.match(panel.message.textContent, /served by a compute server/);
  const hosted = setup('https://webapps.neurodesk.org/nesvor/');
  const probe = fakeClient({ service: 'other' });
  const other = createComputeConnection({ storageKey: 'f', createClient: probe.createClient }, hosted.document);
  hosted.document.body.append(other);
  await tick();
  assert.equal(other.address, '');
});

test('saved connections are restored and disabled panels stay inert', async () => {
  const window = setup();
  window.localStorage.setItem('g', JSON.stringify({ address: 'https://a:8765', token: 'x' }));
  const panel = createComputeConnection({ storageKey: 'g', autodetect: false, disabled: true }, window.document);
  window.document.body.append(panel);
  await tick();
  assert.equal(panel.address, 'https://a:8765');
  assert.equal(panel.token, 'x');
  assert.equal(panel.addressInput.disabled, true);
  assert.equal(panel.querySelector('.nd-row button').disabled, true);
  panel.setDisabled(false);
  assert.equal(panel.addressInput.disabled, false);
});
