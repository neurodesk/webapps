// Shared parity-test helpers used by each app's *-parity.test.js, so the propagation of
// shared components to multiple apps doesn't duplicate the same assertions N times.
import { JSDOM } from "jsdom";

// --- ProgressManager: trace #progressBar width across a value sequence, via a DOM stub. ---
export function progressWidths(PMClass, values = [0, 0.25, 0.5, 1]) {
  const bar = { style: { width: "" } };
  const status = { textContent: "" };
  const prev = globalThis.document;
  globalThis.document = {
    getElementById: (id) => (id === "progressBar" ? bar : id === "statusText" ? status : null),
  };
  try {
    return values.map((v) => {
      const pm = new PMClass({ animationSpeed: 0.5 });
      pm.setProgress(v);
      return bar.style.width;
    });
  } finally {
    globalThis.document = prev;
  }
}

// --- ModalManager: observable trace for open/close/toggle/isOpen + overlay-click-close. ---
export function modalTrace(ModalClass) {
  const classes = new Set();
  const el = {
    classList: {
      add: (c) => classes.add(c),
      remove: (c) => classes.delete(c),
      contains: (c) => classes.has(c),
    },
    addEventListener: (type, h) => {
      if (type === "click") el._onclick = h;
    },
    _fire() {
      if (this._onclick) this._onclick({ target: this });
    },
  };
  const prev = globalThis.document;
  globalThis.document = { getElementById: (id) => (id === "m" ? el : null) };
  try {
    const m = new ModalClass("m");
    const t = [m.isOpen()];
    m.open();
    t.push(m.isOpen(), el.classList.contains("active"));
    m.close();
    t.push(m.isOpen());
    m.toggle();
    t.push(m.isOpen());
    el._fire();
    t.push(m.isOpen());
    return t;
  } finally {
    globalThis.document = prev;
  }
}

// --- ConsoleOutput: render messages via a factory into a jsdom container; return HTML. ---
// `makeInstance(containerEl)` builds the component bound to containerEl.
export function renderConsole(makeInstance, messages) {
  const dom = new JSDOM("<!doctype html><body></body>");
  const prev = globalThis.document;
  globalThis.document = dom.window.document;
  try {
    const el = dom.window.document.createElement("div");
    el.id = "consoleOutput";
    dom.window.document.body.appendChild(el);
    const inst = makeInstance(el, dom.window.document);
    for (const m of messages) inst.log(m);
    return el.innerHTML.replace(/\[\d\d:\d\d:\d\d\]/g, "[TIME]");
  } finally {
    globalThis.document = prev;
  }
}

// --- download helpers: run `fn` with jsdom + stubbed object-URL APIs; capture side effects. ---
export function captureDownload(fn) {
  const dom = new JSDOM("<!doctype html><body></body>");
  const prevDoc = globalThis.document;
  const prevURL = globalThis.URL;
  const created = [];
  const revoked = [];
  const clicks = [];
  try {
    globalThis.document = dom.window.document;
    globalThis.URL = dom.window.URL;
    globalThis.URL.createObjectURL = (b) => {
      created.push(b);
      return `blob:mock/${created.length}`;
    };
    globalThis.URL.revokeObjectURL = (u) => revoked.push(u);
    dom.window.HTMLAnchorElement.prototype.click = function () {
      clicks.push({ href: this.href, download: this.download });
    };
    fn(dom.window);
    return { created, revoked, clicks, leftoverAnchors: dom.window.document.querySelectorAll("a").length };
  } finally {
    globalThis.document = prevDoc;
    globalThis.URL = prevURL;
  }
}
