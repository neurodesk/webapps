#!/usr/bin/env node
'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.resolve(__dirname, '..');
const source = fs.readFileSync(path.join(ROOT, 'web/coi-serviceworker.js'), 'utf8');
const listeners = new Map();
const warnings = [];

const context = {
  console: {
    log() {},
    error(...args) {
      warnings.push(args.join(' '));
    },
    warn(...args) {
      warnings.push(args.join(' '));
    }
  },
  self: {
    addEventListener(type, listener) {
      listeners.set(type, listener);
    },
    skipWaiting() {},
    clients: {
      claim() {},
      matchAll: () => Promise.resolve([])
    },
    registration: {
      unregister: () => Promise.resolve()
    }
  },
  Request,
  Response,
  Headers
};

vm.runInNewContext(source, context, { filename: 'coi-serviceworker.js' });

assert.ok(listeners.has('fetch'), 'service worker registers a fetch handler');
assert.ok(listeners.has('message'), 'service worker registers a message handler');

listeners.get('message')({ data: { type: 'coepCredentialless', value: true } });

async function runFetch(fetchImpl, request = new Request('https://example.test/data')) {
  context.fetch = fetchImpl;
  let responsePromise = null;
  listeners.get('fetch')({
    request,
    respondWith(promise) {
      responsePromise = Promise.resolve(promise);
    }
  });
  assert.ok(responsePromise, 'fetch handler calls respondWith');
  return responsePromise;
}

async function main() {
  {
    const response = await runFetch(() => Promise.resolve(new Response('ok', { status: 200 })));
    assert.equal(response.status, 200);
    assert.equal(await response.text(), 'ok');
    assert.equal(response.headers.get('Cross-Origin-Embedder-Policy'), 'credentialless');
    assert.equal(response.headers.get('Cross-Origin-Opener-Policy'), 'same-origin');
  }

  for (const status of [204, 205, 304]) {
    const upstream = {
      status,
      statusText: '',
      headers: new Headers({ 'x-test': String(status) }),
      body: new ReadableStream()
    };
    const response = await runFetch(() => Promise.resolve(upstream));
    assert.equal(response.status, status);
    assert.equal(response.body, null, `status ${status} must be reconstructed with a null body`);
    assert.equal(response.headers.get('x-test'), String(status));
  }

  {
    const opaqueResponse = { status: 0, marker: 'opaque' };
    const response = await runFetch(() => Promise.resolve(opaqueResponse));
    assert.equal(response, opaqueResponse, 'opaque responses pass through unchanged');
  }

  {
    const response = await runFetch(() => Promise.reject(new TypeError('Failed to fetch')));
    assert.equal(response.type, 'error');
    assert.equal(response.status, 0);
    assert.ok(warnings.some(line => line.includes('COOP/COEP Service Worker fetch failed')), 'fetch failures are logged');
  }

  console.log('COI service worker compatibility tests passed');
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
