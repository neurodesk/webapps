// Opens files another app sent here the way a page drop opens them: the shell claims the
// handoff and puts the files on the app's own inputs, so every app on the site can receive
// one without code of its own. An app that takes handoffs itself marks an element
// `data-neurodesk-handoff-receiver`, and the shell leaves its handoffs to it.
import { handoffId, takeHandoff } from './index.js';
import { classifiedInputs, deliverFiles, primaryInput, routeFiles } from '../ui/pageDrop.js';

// Apps that build their inputs after loading a model or a runtime get this long to show one.
const INPUT_WAIT_MS = 60 * 1000;

function loaded(window) {
  if (window.document.readyState === 'complete') return Promise.resolve();
  return new Promise((resolve) => { window.addEventListener('load', resolve, { once: true }); });
}

function inputAppears(document, signal) {
  signal.throwIfAborted();
  const window = document.defaultView;
  return new Promise((resolve, reject) => {
    let timer;
    const cleanup = () => {
      observer.disconnect();
      window.clearTimeout(timer);
      signal.removeEventListener('abort', abort);
    };
    const abort = () => {
      cleanup();
      reject(signal.reason);
    };
    const check = () => {
      const input = primaryInput(document);
      if (!input) return;
      cleanup();
      resolve(input);
    };
    const observer = new window.MutationObserver(check);
    signal.addEventListener('abort', abort, { once: true });
    observer.observe(document.documentElement, { subtree: true, childList: true, attributes: true, attributeFilter: ['disabled', 'inert', 'open'] });
    timer = window.setTimeout(() => {
      cleanup();
      reject(new Error('this app shows no input to take it'));
    }, INPUT_WAIT_MS);
    check();
  });
}

// Whether a change on input reaches a handler of its app. Only known on a page the shell watched
// from the start (site/theme.js); elsewhere the input is taken as handled.
function handled(input) {
  const window = input.ownerDocument.defaultView;
  const bound = window[Symbol.for('neurodesk.changeListeners')];
  if (!bound || input.onchange) return true;
  for (let node = input; node; node = node.parentNode ?? node.host) {
    if (bound.has(node)) return true;
  }
  return bound.has(window);
}

// Apps that bind their inputs only after starting a viewer show the input first; wait for the
// handler, then deliver anyway rather than never.
async function handlerBound(input, deadline, signal) {
  const window = input.ownerDocument.defaultView;
  while (!handled(input) && Date.now() < deadline) {
    signal.throwIfAborted();
    await new Promise((resolve) => { window.setTimeout(resolve, 100); });
  }
  signal.throwIfAborted();
}

// Resolves with what was received, or null when the page carries no handoff for the shell.
export async function receiveHandoff(document = globalThis.document) {
  if (!handoffId(document.location.hash)) return null;
  const window = document.defaultView;
  const controller = new window.AbortController();
  const { signal } = controller;
  function supersede(event) {
    const input = event.composedPath()[0];
    if (event.type === 'change') {
      if (!(input instanceof window.HTMLInputElement) || input.type !== 'file' || !input.hasAttribute('data-neurodesk-input')) return;
    } else if (event.type === 'drop') {
      if (!event.dataTransfer?.types?.includes('Files')) return;
    } else if (!['loading', 'ready'].includes(event.detail?.state)) return;
    controller.abort();
  }
  const listeners = [[document, 'change'], [window, 'drop'], [document, 'nd-example-status']];
  for (const [target, type] of listeners) target.addEventListener(type, supersede, true);
  const stop = () => {
    for (const [target, type] of listeners) target.removeEventListener(type, supersede, true);
  };
  try {
    // Module scripts run in order and the app's own come after the shell's. The receiver marker
    // must be in the served HTML: one an app renders after load is not seen.
    await loaded(window);
    if (document.querySelector('[data-neurodesk-handoff-receiver]')) return null;
    const deadline = Date.now() + INPUT_WAIT_MS;
    const received = await takeHandoff({ document, signal });
    if (!received) return null;
    await handlerBound(await inputAppears(document, signal), deadline, signal);
    // A frame more, so an app that binds its handlers once it has started does not miss the change.
    await new Promise((resolve) => { window.requestAnimationFrame(() => resolve()); });
    signal.throwIfAborted();
    const primary = primaryInput(document) ?? await inputAppears(document, signal);
    stop();
    for (const [input, files] of routeFiles(received.files, classifiedInputs(document), primary)) {
      deliverFiles(input, files, { replace: true });
    }
    return received;
  } catch (error) {
    if (!signal.aborted) throw error;
    return null;
  } finally {
    stop();
  }
}
