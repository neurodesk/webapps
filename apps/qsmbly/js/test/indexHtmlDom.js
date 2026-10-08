/**
 * A minimal `document` stand-in built from the real index.html, for controller tests that read
 * and write form controls by id. Each element with an id becomes a stub carrying the initial
 * value/checked state from the markup. Writes behave the way a browser's do where it matters
 * for a settings round trip: a <select> rejects a value it has no <option> for (its value
 * becomes ''), and a number input rejects text that is not a number.
 *
 * `missing` records every id looked up that index.html does not have — a control the code
 * reads but the page never renders.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const INDEX_HTML = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'index.html');

function attrs(tag) {
  const out = {};
  for (const m of tag.matchAll(/([\w-]+)(?:\s*=\s*"([^"]*)")?/g)) out[m[1]] = m[2] ?? '';
  return out;
}

function makeElement(id, tagName, a, options) {
  const classes = new Set((a.class || '').split(/\s+/).filter(Boolean));
  let value = a.value ?? '';
  if (options) value = (options.find(o => o.selected) || options[0])?.value ?? '';
  const el = {
    id, tagName: tagName.toUpperCase(), type: a.type || '', options,
    checked: 'checked' in a, disabled: 'disabled' in a, hidden: 'hidden' in a,
    style: {}, textContent: '', innerHTML: '',
    // Enough of a parent for code that inserts an inline warning next to a control.
    parentNode: { tagName: 'DIV', insertBefore() {} },
    classList: {
      add: c => classes.add(c), remove: c => classes.delete(c), contains: c => classes.has(c),
      toggle: (c, on = !classes.has(c)) => (on ? classes.add(c) : classes.delete(c), on),
    },
    listeners: {},
    addEventListener(type, fn) { (this.listeners[type] ||= []).push(fn); },
    querySelector: () => null,
    querySelectorAll: () => [],
    closest: () => null,
    // Enough for the dialog focus helper (dialogFocus.js) that open()/close() go through.
    hasAttribute: n => n in a,
    setAttribute(n, v) { a[n] = String(v); },
    focus() {},
    get value() { return value; },
    set value(v) {
      const s = String(v);
      if (options) value = options.some(o => o.value === s) ? s : '';
      else if (el.type === 'number') value = s.trim() !== '' && Number.isFinite(Number(s)) ? s : '';
      else value = s;
    },
  };
  return el;
}

/** Parse index.html into id -> element stub. */
export function parseIndexHtml(html = readFileSync(INDEX_HTML, 'utf8')) {
  const elements = new Map();
  for (const m of html.matchAll(/<(\w+)\b([^>]*\bid="([^"]+)"[^>]*)>/g)) {
    const [, tagName, attrText, id] = m;
    let options = null;
    if (tagName === 'select') {
      const body = html.slice(m.index).match(/<select[^>]*>([\s\S]*?)<\/select>/)[1];
      options = [...body.matchAll(/<option\b([^>]*)>/g)].map(o => {
        const oa = attrs(o[1]);
        return { value: oa.value ?? '', selected: 'selected' in oa };
      });
    }
    elements.set(id, makeElement(id, tagName, attrs(attrText), options));
  }
  return elements;
}

/** Install a `document` global backed by index.html; returns { elements, missing, restore }. */
export function installIndexHtmlDom() {
  const elements = parseIndexHtml();
  const missing = new Set();
  const previous = globalThis.document;
  globalThis.document = {
    activeElement: null,
    body: null,
    addEventListener() {},
    getElementById(id) {
      if (!elements.has(id)) missing.add(id);
      return elements.get(id) ?? null;
    },
    createElement(tagName) {
      const el = makeElement('', tagName, {}, null);
      el.querySelector = () => makeElement('', 'span', {}, null);
      return el;
    },
  };
  return {
    elements,
    missing,
    restore() {
      if (previous === undefined) delete globalThis.document;
      else globalThis.document = previous;
    },
  };
}
