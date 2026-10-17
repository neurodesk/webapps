import assert from 'node:assert/strict';
import test from 'node:test';
import { JSDOM } from 'jsdom';
import { openDialog, closeDialog, getFocusable } from '../src/ui/dialogFocus.js';
import { ModalManager } from '../src/ui/ModalManager.js';

const FORM = `
  <button id="close">&times;</button>
  <input id="text" type="text">
  <input id="disabled" type="text" disabled>
  <div style="display: none"><input id="cssHidden" type="text"></div>
  <div hidden><input id="attrHidden" type="text"></div>
  <select id="select"><option>a</option></select>
  <button id="save">Save</button>`;

function setup() {
  const dom = new JSDOM('<button id="opener">Open</button>');
  const doc = dom.window.document;
  const opener = doc.getElementById('opener');
  opener.focus();
  const overlay = (id, inner) => {
    const el = doc.createElement('div');
    el.className = 'modal-overlay';
    el.id = id;
    el.innerHTML = `<div class="modal" role="dialog" aria-modal="true">${inner}</div>`;
    doc.body.appendChild(el);
    return el;
  };
  const press = (key, { shiftKey = false } = {}) => {
    const event = new dom.window.KeyboardEvent('keydown', { key, shiftKey, bubbles: true, cancelable: true });
    (doc.activeElement || doc.body).dispatchEvent(event);
    return event;
  };
  return { doc, opener, overlay, press };
}

test('getFocusable skips disabled, display:none and hidden elements', () => {
  const { overlay } = setup();
  const el = overlay('m', FORM);
  assert.deepEqual(getFocusable(el).map((e) => e.id), ['close', 'text', 'select', 'save']);
});

test('openDialog shows the overlay, focuses inside and closeDialog returns focus to the opener', () => {
  const { doc, opener, overlay } = setup();
  const el = overlay('m', FORM);
  openDialog(el);
  assert.equal(el.classList.contains('active'), true);
  assert.equal(doc.activeElement.id, 'close');
  closeDialog(el);
  assert.equal(el.classList.contains('active'), false);
  assert.equal(doc.activeElement, opener);
});

test('a dialog with nothing focusable takes focus itself', () => {
  const { doc, overlay, press } = setup();
  const el = overlay('m', '<p>Just text</p>');
  openDialog(el);
  const dialog = el.querySelector('[role="dialog"]');
  assert.equal(doc.activeElement, dialog);
  assert.equal(press('Tab').defaultPrevented, true);
  assert.equal(doc.activeElement, dialog);
  closeDialog(el);
});

test('Tab and Shift+Tab wrap at the ends and are left alone in between', () => {
  const { doc, overlay, press } = setup();
  const el = overlay('m', FORM);
  openDialog(el);
  doc.getElementById('save').focus();
  assert.equal(press('Tab').defaultPrevented, true);
  assert.equal(doc.activeElement.id, 'close');
  assert.equal(press('Tab', { shiftKey: true }).defaultPrevented, true);
  assert.equal(doc.activeElement.id, 'save');
  doc.getElementById('text').focus();
  assert.equal(press('Tab').defaultPrevented, false);
  closeDialog(el);
  assert.equal(press('Tab').defaultPrevented, false);
});

test('focus does not return to an opener hidden while the dialog was open', () => {
  const { doc, opener, overlay } = setup();
  const el = overlay('m', FORM);
  openDialog(el);
  opener.hidden = true;
  closeDialog(el);
  assert.notEqual(doc.activeElement, opener);
});

test('only the top of stacked dialogs traps and handles Escape', () => {
  const { doc, opener, overlay, press } = setup();
  const lower = overlay('lower', '<button id="l1">L1</button><button id="openUpper">Open</button>');
  const upper = overlay('upper', '<button id="u1">U1</button><button id="u2">U2</button>');
  let lowerClosed = 0;
  let upperClosed = 0;
  openDialog(lower, { onEscape: () => { lowerClosed++; closeDialog(lower); } });
  doc.getElementById('openUpper').focus();
  openDialog(upper, { onEscape: () => { upperClosed++; closeDialog(upper); } });
  assert.equal(doc.activeElement.id, 'u1');
  press('Escape');
  assert.deepEqual([upperClosed, lowerClosed], [1, 0]);
  assert.equal(doc.activeElement.id, 'openUpper');
  press('Escape');
  assert.deepEqual([upperClosed, lowerClosed], [1, 1]);
  assert.equal(doc.activeElement, opener);
});

test('ModalManager opens with focus inside, closes on Escape and on an overlay click', () => {
  const { doc, opener, overlay, press } = setup();
  const el = overlay('aboutModal', FORM);
  const modal = new ModalManager({ element: el });
  modal.open();
  assert.equal(modal.isOpen(), true);
  assert.equal(doc.activeElement.id, 'close');
  const escape = press('Escape');
  assert.equal(escape.defaultPrevented, true);
  assert.equal(modal.isOpen(), false);
  assert.equal(doc.activeElement, opener);
  modal.open();
  el.dispatchEvent(new doc.defaultView.MouseEvent('click', { bubbles: true }));
  assert.equal(modal.isOpen(), false);
});

test('ModalManager honours a custom active class', () => {
  const { overlay } = setup();
  const el = overlay('m', FORM);
  const modal = new ModalManager({ element: el, activeClass: 'open' });
  modal.open();
  assert.equal(el.classList.contains('open'), true);
  assert.equal(el.classList.contains('active'), false);
  modal.close();
  assert.equal(el.classList.contains('open'), false);
});

test('ModalManager still toggles an overlay in a document without event support', () => {
  const classes = new Set();
  const element = {
    classList: { add: c => classes.add(c), remove: c => classes.delete(c), contains: c => classes.has(c) },
    addEventListener() {},
  };
  const previous = globalThis.document;
  globalThis.document = { getElementById: () => element };
  try {
    const modal = new ModalManager('m');
    modal.open();
    assert.equal(modal.isOpen(), true);
    modal.close();
    assert.equal(modal.isOpen(), false);
  } finally {
    globalThis.document = previous;
  }
});

test('closed ModalManagers start inert and remain inert after repeated close', () => {
  const { overlay } = setup();
  const el = overlay('m', FORM);
  const modal = new ModalManager({ element: el });
  assert.equal(el.hasAttribute('inert'), true);
  assert.equal(el.getAttribute('aria-hidden'), 'true');
  assert.deepEqual(getFocusable(el), []);
  modal.close();
  modal.close();
  assert.equal(el.hasAttribute('inert'), true);
});

test('initially open ModalManagers are interactive, including custom active classes', () => {
  const { overlay } = setup();
  const el = overlay('m', FORM);
  el.classList.add('open');
  el.setAttribute('inert', '');
  const modal = new ModalManager({ element: el, activeClass: 'open' });
  assert.equal(modal.isOpen(), true);
  assert.equal(el.hasAttribute('inert'), false);
  assert.equal(el.getAttribute('aria-hidden'), 'false');
  modal.close();
  assert.equal(el.hasAttribute('inert'), true);
});

test('reopening clears inert before focus; close and Escape restore focus and inertness', () => {
  const { doc, opener, overlay, press } = setup();
  const el = overlay('m', FORM);
  const modal = new ModalManager({ element: el });
  const close = el.querySelector('#close');
  close.addEventListener('focus', () => assert.equal(el.hasAttribute('inert'), false));
  close.addEventListener('click', () => modal.close());
  for (const dismiss of [() => close.click(), () => press('Escape'), () => close.click()]) {
    modal.open();
    modal.open();
    assert.equal(el.hasAttribute('inert'), false);
    assert.equal(el.getAttribute('aria-hidden'), 'false');
    assert.equal(doc.activeElement, close);
    dismiss();
    assert.equal(modal.isOpen(), false);
    assert.equal(el.hasAttribute('inert'), true);
    assert.equal(el.getAttribute('aria-hidden'), 'true');
    assert.equal(doc.activeElement, opener);
    assert.deepEqual(getFocusable(el), []);
  }
});

test('focus candidates and restoration exclude inert ancestors', () => {
  const { doc, opener, overlay } = setup();
  const parent = doc.createElement('div');
  opener.replaceWith(parent);
  parent.append(opener);
  opener.focus();
  const el = overlay('m', '<div inert><button id="unavailable">Unavailable</button></div><button id="available">Available</button>');
  assert.deepEqual(getFocusable(el).map(node => node.id), ['available']);
  openDialog(el);
  assert.equal(doc.activeElement.id, 'available');
  parent.setAttribute('inert', '');
  closeDialog(el);
  assert.notEqual(doc.activeElement, opener);
});
