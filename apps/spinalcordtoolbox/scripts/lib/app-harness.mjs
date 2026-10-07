// Boots the real SpinalCordToolboxApp against the real web/index.html in jsdom.
//
// Only the boundaries are faked: the NiiVue global (WebGL), the Worker (ONNX
// inference) and fetch (the example catalog). Everything between a click and
// the message posted to the worker is the shipped application code.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { JSDOM } from 'jsdom';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const APP_ROOT = path.resolve(HERE, '../..');
export const APP_URL = 'http://localhost:4320/';

export function readIndexHtml() {
  return fs.readFileSync(path.join(APP_ROOT, 'web/index.html'), 'utf8');
}

export function parseIndexHtml() {
  return new JSDOM(readIndexHtml(), { url: APP_URL });
}

function createFakeNiivue(calls) {
  return class FakeNiivue {
    constructor(options = {}) {
      this.opts = { ...options };
      this.volumes = [];
      this.gl = {};
      this.sliceTypeMultiplanar = 3;
      this.sliceTypeAxial = 0;
      this.sliceTypeCoronal = 1;
      this.sliceTypeSagittal = 2;
      this.sliceTypeRender = 4;
    }
    async attachTo(id) {
      calls.push(['attachTo', id]);
    }
    setMultiplanarPadPixels() {}
    setSliceType(value) {
      calls.push(['setSliceType', value]);
    }
    setInterpolation(value) {
      calls.push(['setInterpolation', value]);
    }
    setCrosshairWidth(value) {
      calls.push(['setCrosshairWidth', value]);
    }
    setOpacity(index, value) {
      calls.push(['setOpacity', index, value]);
    }
    addColormap(id) {
      calls.push(['addColormap', id]);
    }
    async loadVolumes(volumes) {
      calls.push(['loadVolumes', volumes.map(volume => volume.name)]);
      this.volumes = volumes.map(volume => ({
        id: volume.name,
        name: volume.name,
        colormap: volume.colormap || 'gray',
        opacity: volume.opacity ?? 1,
        cal_min: 0,
        cal_max: 1,
        global_min: 0,
        global_max: 1,
        img: new Float32Array(8)
      }));
    }
    async addVolumeFromUrl(volume) {
      calls.push(['addVolumeFromUrl', volume.name, volume.colormap]);
      this.volumes.push({
        id: volume.name,
        name: volume.name,
        colormap: volume.colormap,
        opacity: volume.opacity ?? 1,
        cal_min: 0,
        cal_max: 1,
        global_min: 0,
        global_max: 1,
        img: new Uint8Array(8)
      });
    }
    setColormap(id, colormap) {
      calls.push(['setColormap', id, colormap]);
      const volume = this.volumes.find(item => item.id === id);
      if (volume) volume.colormap = colormap;
    }
    removeVolumeByIndex(index) {
      this.volumes.splice(index, 1);
    }
    updateGLVolume() {
      calls.push(['updateGLVolume']);
    }
    drawScene() {
      calls.push(['drawScene']);
    }
    async saveScene(name) {
      calls.push(['saveScene', name]);
    }
  };
}

class FakeWorker {
  constructor(url, options) {
    this.url = String(url);
    this.options = options;
    this.posted = [];
    this.terminated = false;
    this.onmessage = null;
    this.onerror = null;
    FakeWorker.instances.push(this);
  }
  postMessage(message, transfer) {
    this.posted.push({ message, transfer });
    // The real worker answers `init` once ONNX Runtime is configured.
    if (message?.type === 'init') {
      setTimeout(() => this.emit({ type: 'initialized' }), 0);
    }
  }
  terminate() {
    this.terminated = true;
  }
  addEventListener(type, listener) {
    this[`on${type}`] = listener;
  }
  removeEventListener() {}
  emit(data) {
    this.onmessage?.({ data });
  }
}
FakeWorker.instances = [];

const GLOBAL_KEYS = [
  'window',
  'document',
  'HTMLElement',
  'Element',
  'Node',
  'Event',
  'CustomEvent',
  'MouseEvent',
  'KeyboardEvent',
  'customElements',
  'MutationObserver',
  'getComputedStyle',
  'requestAnimationFrame',
  'cancelAnimationFrame',
  'localStorage',
  'sessionStorage',
  'DOMParser',
  'HTMLInputElement',
  'HTMLSelectElement',
  'HTMLButtonElement',
  'HTMLDialogElement',
  'DragEvent',
  'FileReader',
  'location'
];

function defineGlobal(key, value) {
  Object.defineProperty(globalThis, key, {
    value,
    configurable: true,
    writable: true
  });
}

const realConsoleLog = console.log.bind(console);

// Prints test output; the app mirrors its technical log to console.log, which
// bootApp() silences so a test run shows only its own lines.
export function report(...args) {
  realConsoleLog(...args);
}

export async function bootApp({ niivueAttachError = null } = {}) {
  console.log = () => {};
  const dom = new JSDOM(readIndexHtml(), {
    url: APP_URL,
    pretendToBeVisual: true
  });
  const { window } = dom;
  // jsdom has no canvas backend; the 2D fallback preview only needs a context
  // object to draw on.
  window.HTMLCanvasElement.prototype.getContext = function getContext() {
    return {
      canvas: this,
      clearRect() {},
      fillRect() {},
      putImageData() {},
      drawImage() {},
      createImageData: (width, height) => ({ width, height, data: new Uint8ClampedArray(width * height * 4) })
    };
  };
  // jsdom cannot navigate; record what a download link would have saved.
  const downloads = [];
  window.HTMLAnchorElement.prototype.click = function click() {
    if (this.download) downloads.push({ name: this.download, href: this.href });
  };
  for (const key of GLOBAL_KEYS) {
    if (window[key] !== undefined) defineGlobal(key, window[key]);
  }
  defineGlobal('navigator', window.navigator);
  defineGlobal('self', globalThis);

  const niivueCalls = [];
  const FakeNiivue = createFakeNiivue(niivueCalls);
  if (niivueAttachError) {
    FakeNiivue.prototype.attachTo = async () => {
      throw new Error(niivueAttachError);
    };
  }
  defineGlobal('niivue', { Niivue: FakeNiivue });
  window.niivue = globalThis.niivue;

  FakeWorker.instances = [];
  defineGlobal('Worker', FakeWorker);
  window.Worker = FakeWorker;

  const examples = fs.readFileSync(path.join(APP_ROOT, 'examples.json'), 'utf8');
  const fetched = [];
  const fakeFetch = async (input) => {
    const url = String(input?.url || input);
    fetched.push(url);
    if (url === `${APP_URL}examples.json`) {
      return new Response(examples, { status: 200, headers: { 'content-type': 'application/json' } });
    }
    return new Response('not found', { status: 404 });
  };
  defineGlobal('fetch', fakeFetch);
  window.fetch = fakeFetch;

  const clipboard = [];
  Object.defineProperty(window.navigator, 'clipboard', {
    value: {
      writeText: async (text) => {
        clipboard.push(text);
      }
    },
    configurable: true
  });

  const moduleUrl = pathToFileURL(path.join(APP_ROOT, 'web/js/spinalcordtoolbox-app.js'));
  const { SpinalCordToolboxApp } = await import(`${moduleUrl.href}?boot=${Date.now()}-${Math.random()}`);
  const app = new SpinalCordToolboxApp();
  await waitFor(() => app.automation !== undefined, 'app.init() to finish');

  const worker = () => FakeWorker.instances.at(-1);
  return {
    app,
    dom,
    window,
    document: window.document,
    niivueCalls,
    fetched,
    clipboard,
    downloads,
    worker,
    workers: () => FakeWorker.instances,
    viewerStack() {
      return app.nv.volumes.map(volume => ({ name: volume.name, colormap: volume.colormap }));
    },
    logText() {
      return window.document.getElementById('consoleOutput').textContent;
    },
    postedOfType(type) {
      return FakeWorker.instances.flatMap(instance => instance.posted).filter(entry => entry.message?.type === type);
    }
  };
}

export async function waitFor(predicate, description, timeoutMs = 5000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const value = await predicate();
    if (value) return value;
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  throw new Error(`Timed out waiting for ${description}`);
}

export function click(element) {
  const { window } = element.ownerDocument.defaultView;
  element.dispatchEvent(new window.MouseEvent('click', { bubbles: true, cancelable: true }));
}

export function setValue(element, value, eventName = 'change') {
  const { window } = element.ownerDocument.defaultView;
  element.value = String(value);
  element.dispatchEvent(new window.Event(eventName, { bubbles: true }));
}

export function setChecked(element, checked) {
  const { window } = element.ownerDocument.defaultView;
  element.checked = checked;
  element.dispatchEvent(new window.Event('change', { bubbles: true }));
}

// A 4x4x4 uint8 NIfTI-1 volume with 1 mm voxels and an identity sform.
export function tinyNiftiBytes() {
  const voxels = 64;
  const buffer = new ArrayBuffer(352 + voxels);
  const view = new DataView(buffer);
  view.setInt32(0, 348, true);
  const dims = [3, 4, 4, 4, 1, 1, 1, 1];
  dims.forEach((value, index) => view.setInt16(40 + index * 2, value, true));
  view.setInt16(70, 2, true);
  view.setInt16(72, 8, true);
  const pixdims = [1, 1, 1, 1, 0, 0, 0, 0];
  pixdims.forEach((value, index) => view.setFloat32(76 + index * 4, value, true));
  view.setFloat32(108, 352, true);
  view.setFloat32(112, 1, true);
  view.setInt16(254, 1, true);
  view.setFloat32(280, 1, true);
  view.setFloat32(300, 1, true);
  view.setFloat32(320, 1, true);
  new Uint8Array(buffer, 344, 4).set([0x6e, 0x2b, 0x31, 0x00]);
  const data = new Uint8Array(buffer, 352);
  for (let index = 0; index < voxels; index++) {
    data[index] = index;
  }
  return new Uint8Array(buffer);
}

export function tinyNiftiFile(name = 'input.nii') {
  return new File([tinyNiftiBytes()], name, { type: 'application/octet-stream' });
}

// Selects files through the real #fileInput change handler.
export function chooseFiles(harness, files) {
  const input = harness.document.getElementById('fileInput');
  Object.defineProperty(input, 'files', { value: files, configurable: true });
  input.dispatchEvent(new harness.window.Event('change', { bubbles: true }));
}

// Loads one input and plays the worker's reply to the `load` request.
export async function loadInput(harness, name = 'input.nii') {
  const before = harness.postedOfType('load').length;
  chooseFiles(harness, [tinyNiftiFile(name)]);
  await waitFor(() => harness.postedOfType('load').length > before, 'the load request to reach the worker');
  harness.worker().emit({ type: 'step-complete', step: 'load' });
  await waitFor(() => !harness.app.inferenceExecutor.isRunning(), 'the load step to finish');
}

// Plays a worker stage result (a label mask) into the app.
export async function emitStage(harness, stage, extra = {}) {
  const niftiData = tinyNiftiBytes().buffer;
  harness.worker().emit({ type: 'stageData', stage, niftiData, description: stage, ...extra });
  await settle(harness);
}

export async function settle(harness) {
  await new Promise(resolve => setTimeout(resolve, 0));
  await harness.app._renderViewerPromise;
  await new Promise(resolve => setTimeout(resolve, 0));
}
