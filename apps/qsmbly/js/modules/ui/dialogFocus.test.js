/**
 * @jest-environment jsdom
 */
import { jest } from '@jest/globals';
import { openDialog, closeDialog, getFocusable } from './dialogFocus.js';

function press(key, { shiftKey = false } = {}) {
  const event = new KeyboardEvent('keydown', { key, shiftKey, bubbles: true, cancelable: true });
  (document.activeElement || document.body).dispatchEvent(event);
  return event;
}

function overlay(id, inner) {
  const el = document.createElement('div');
  el.className = 'modal-overlay';
  el.id = id;
  el.innerHTML = `<div class="modal" role="dialog" aria-modal="true">${inner}</div>`;
  document.body.appendChild(el);
  return el;
}

const FORM = `
  <button id="close">&times;</button>
  <input id="text" type="text">
  <input id="disabled" type="text" disabled>
  <div style="display: none"><input id="cssHidden" type="text"></div>
  <div hidden><input id="attrHidden" type="text"></div>
  <select id="select"><option>a</option></select>
  <button id="save">Save</button>`;

let opener;

beforeEach(() => {
  document.body.innerHTML = '<button id="opener">Open</button>';
  opener = document.getElementById('opener');
  opener.focus();
});

describe('getFocusable', () => {
  test('skips disabled, display:none and hidden elements', () => {
    const el = overlay('m', FORM);
    expect(getFocusable(el).map((e) => e.id)).toEqual(['close', 'text', 'select', 'save']);
  });

  test('keeps only the checked radio of a group that has one', () => {
    const el = overlay('m', `
      <input type="radio" name="g" id="r1"><input type="radio" name="g" id="r2" checked>
      <input type="radio" name="h" id="h1"><input type="radio" name="h" id="h2">`);
    expect(getFocusable(el).map((e) => e.id)).toEqual(['r2', 'h1', 'h2']);
  });
});

describe('openDialog / closeDialog', () => {
  test('shows the overlay and focuses its first focusable element', () => {
    const el = overlay('m', FORM);
    openDialog(el);
    expect(el.classList.contains('active')).toBe(true);
    expect(document.activeElement.id).toBe('close');
    closeDialog(el);
  });

  test('prefers an [autofocus] element', () => {
    const el = overlay('m', '<button id="a">A</button><button id="b" autofocus>B</button>');
    openDialog(el);
    expect(document.activeElement.id).toBe('b');
    closeDialog(el);
  });

  test('focuses the dialog itself when it has nothing focusable', () => {
    const el = overlay('m', '<p>Just text</p>');
    openDialog(el);
    const dialog = el.querySelector('[role="dialog"]');
    expect(document.activeElement).toBe(dialog);
    expect(dialog.getAttribute('tabindex')).toBe('-1');
    expect(press('Tab').defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(dialog);
    closeDialog(el);
  });

  test('hides the overlay and returns focus to the opener', () => {
    const el = overlay('m', FORM);
    openDialog(el);
    closeDialog(el);
    expect(el.classList.contains('active')).toBe(false);
    expect(document.activeElement).toBe(opener);
  });

  test('does not return focus to an opener that has been hidden', () => {
    const el = overlay('m', FORM);
    openDialog(el);
    opener.hidden = true;
    closeDialog(el);
    expect(document.activeElement).not.toBe(opener);
  });

  test('does not steal focus back if it already left the dialog', () => {
    const el = overlay('m', FORM);
    const elsewhere = document.createElement('button');
    document.body.appendChild(elsewhere);
    openDialog(el);
    elsewhere.focus();
    closeDialog(el);
    expect(document.activeElement).toBe(elsewhere);
  });

  test('opening an already-open dialog keeps the original opener', () => {
    const el = overlay('m', FORM);
    openDialog(el);
    document.getElementById('text').focus();
    openDialog(el);
    expect(document.activeElement.id).toBe('text');
    closeDialog(el);
    expect(document.activeElement).toBe(opener);
  });

  test('tolerates a missing overlay', () => {
    expect(() => openDialog(null)).not.toThrow();
    expect(() => closeDialog(null)).not.toThrow();
  });
});

describe('focus trap', () => {
  test('Tab on the last element wraps to the first', () => {
    const el = overlay('m', FORM);
    openDialog(el);
    document.getElementById('save').focus();
    expect(press('Tab').defaultPrevented).toBe(true);
    expect(document.activeElement.id).toBe('close');
    closeDialog(el);
  });

  test('Shift+Tab on the first element wraps to the last', () => {
    const el = overlay('m', FORM);
    openDialog(el);
    expect(press('Tab', { shiftKey: true }).defaultPrevented).toBe(true);
    expect(document.activeElement.id).toBe('save');
    closeDialog(el);
  });

  test('Tab between inner elements is left to the browser', () => {
    const el = overlay('m', FORM);
    openDialog(el);
    document.getElementById('text').focus();
    expect(press('Tab').defaultPrevented).toBe(false);
    expect(press('Tab', { shiftKey: true }).defaultPrevented).toBe(false);
    closeDialog(el);
  });

  test('Tab with focus outside the dialog brings it back in', () => {
    const el = overlay('m', FORM);
    openDialog(el);
    document.body.focus();
    opener.focus();
    expect(press('Tab').defaultPrevented).toBe(true);
    expect(document.activeElement.id).toBe('close');
    closeDialog(el);
  });

  test('the trap follows visibility changes made while open', () => {
    const el = overlay('m', FORM);
    openDialog(el);
    document.getElementById('save').hidden = true;
    document.getElementById('select').focus();
    expect(press('Tab').defaultPrevented).toBe(true);
    expect(document.activeElement.id).toBe('close');
    closeDialog(el);
  });

  test('no trap once every dialog is closed', () => {
    const el = overlay('m', FORM);
    openDialog(el);
    closeDialog(el);
    expect(press('Tab').defaultPrevented).toBe(false);
  });
});

describe('Escape', () => {
  test('calls onEscape, which closes the dialog', () => {
    const el = overlay('m', FORM);
    const onEscape = jest.fn(() => closeDialog(el));
    openDialog(el, { onEscape });
    const event = press('Escape');
    expect(onEscape).toHaveBeenCalledTimes(1);
    expect(event.defaultPrevented).toBe(true);
    expect(el.classList.contains('active')).toBe(false);
    expect(document.activeElement).toBe(opener);
  });

  test('does nothing without onEscape', () => {
    const el = overlay('m', FORM);
    openDialog(el);
    expect(press('Escape').defaultPrevented).toBe(false);
    expect(el.classList.contains('active')).toBe(true);
    closeDialog(el);
  });

  test('ignores an Escape something else already handled', () => {
    const el = overlay('m', FORM);
    const onEscape = jest.fn();
    openDialog(el, { onEscape });
    const input = document.getElementById('text');
    input.focus();
    input.addEventListener('keydown', (e) => e.preventDefault(), { once: true });
    press('Escape');
    expect(onEscape).not.toHaveBeenCalled();
    closeDialog(el);
  });
});

describe('stacked dialogs', () => {
  test('only the top dialog traps and handles Escape; closing it returns focus to the one below', () => {
    const lower = overlay('lower', '<button id="l1">L1</button><button id="openUpper">Open</button>');
    const upper = overlay('upper', '<button id="u1">U1</button><button id="u2">U2</button>');
    const closeLower = jest.fn(() => closeDialog(lower));
    const closeUpper = jest.fn(() => closeDialog(upper));

    openDialog(lower, { onEscape: closeLower });
    document.getElementById('openUpper').focus();
    openDialog(upper, { onEscape: closeUpper });
    expect(document.activeElement.id).toBe('u1');

    document.getElementById('u2').focus();
    press('Tab');
    expect(document.activeElement.id).toBe('u1');

    press('Escape');
    expect(closeUpper).toHaveBeenCalledTimes(1);
    expect(closeLower).not.toHaveBeenCalled();
    expect(document.activeElement.id).toBe('openUpper');

    press('Tab');
    expect(document.activeElement.id).toBe('l1');

    press('Escape');
    expect(closeLower).toHaveBeenCalledTimes(1);
    expect(document.activeElement).toBe(opener);
  });
});
