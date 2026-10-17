import assert from 'node:assert/strict';
import test from 'node:test';
import { JSDOM } from 'jsdom';
import { activateRowName, labelSliders, syncRowNames } from '../src/freebrowse-viewer/accessibility.js';

// The markup FreeBrowse's Volumes panel renders for each loaded volume.
function volumesPanel(selected) {
  const { document, KeyboardEvent } = new JSDOM().window;
  document.body.innerHTML = `<div role="tabpanel">${['t1.nii', 'mask.nii'].map((name, index) => `
    <div class="flex cursor-pointer${index === selected ? ' bg-muted' : ''}">
      <div class="flex-shrink-0"><button>eye</button></div>
      <div class="flex-1 w-0"><p>${name}</p></div>
    </div>`).join('')}</div>`;
  const rows = [...document.querySelectorAll('div.cursor-pointer')];
  rows.forEach((row, index) => row.addEventListener('click', () => {
    rows.forEach((other) => other.classList.toggle('bg-muted', other === rows[index]));
  }));
  document.body.addEventListener('keydown', activateRowName);
  return { document, KeyboardEvent, names: [...document.querySelectorAll('p')] };
}

test('each volume name is a focusable toggle button that reports the selection', () => {
  const { document, names } = volumesPanel(1);
  syncRowNames(document);
  for (const name of names) {
    assert.equal(name.getAttribute('role'), 'button');
    assert.equal(name.tabIndex, 0);
  }
  assert.deepEqual(names.map((name) => name.getAttribute('aria-pressed')), ['false', 'true']);
});

test('Enter and Space on a name select its volume; other keys do nothing', () => {
  const { document, KeyboardEvent, names } = volumesPanel(null);
  syncRowNames(document);
  const press = (target, key) => target.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }));
  press(names[0], 'a');
  syncRowNames(document);
  assert.deepEqual(names.map((name) => name.getAttribute('aria-pressed')), ['false', 'false']);
  assert.equal(press(names[0], 'Enter'), false, 'Enter is consumed');
  syncRowNames(document);
  assert.deepEqual(names.map((name) => name.getAttribute('aria-pressed')), ['true', 'false']);
  press(names[1], ' ');
  syncRowNames(document);
  assert.deepEqual(names.map((name) => name.getAttribute('aria-pressed')), ['false', 'true']);
});

test('a labelled slider and its number field take the label as their name', () => {
  const { document } = new JSDOM().window;
  document.body.innerHTML = `
    <div><label>Contrast Max</label><div><span><span role="slider"></span></span><input type="number"></div></div>
    <div><label>Colormap</label><select></select></div>`;
  labelSliders(document);
  assert.equal(document.querySelector('[role="slider"]').getAttribute('aria-label'), 'Contrast Max');
  assert.equal(document.querySelector('input').getAttribute('aria-label'), 'Contrast Max');
  assert.equal(document.querySelector('select').hasAttribute('aria-label'), false);
});

test('keys on the row buttons are left to them', () => {
  const { document, KeyboardEvent } = volumesPanel(null);
  syncRowNames(document);
  const eye = document.querySelector('button');
  assert.equal(eye.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })), true);
  assert.equal(document.querySelectorAll('.bg-muted').length, 0);
});
