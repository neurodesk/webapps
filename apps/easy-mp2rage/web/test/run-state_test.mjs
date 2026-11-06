import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { test } from 'node:test';
import assert from 'node:assert/strict';

const source = readFileSync(new URL('../js/app.js', import.meta.url), 'utf8');
const refresh = source.slice(source.indexOf('function refreshRunState()'), source.indexOf('$("#taskSel").onchange'));
function state(task, roles) {
  const elements = new Map();
  const $ = selector => {
    if (!elements.has(selector)) elements.set(selector, {});
    return elements.get(selector);
  };
  $('#taskSel').value = task;
  vm.runInNewContext(`${refresh}\nrefreshRunState();`, { $, state: { files: roles.map(role => ({ role })) }, running: false, byRole: role => roles.includes(role) ? {} : null });
  return { button: $('#run'), status: $('#statusText').textContent };
}

test('names only missing inputs for each task and restores the action when ready', () => {
  for (const [task, roles, missing] of [
    ['denoise', ['UNI', 'INV2'], 'INV1'],
    ['b1only', ['UNI', 'SA2RAGE'], 'INV2'],
    ['t1', ['UNI'], 'SA2RAGE or B1 map'],
    ['t1', ['B1 map'], 'UNI'],
    ['t1', ['(ignore)'], 'UNI, SA2RAGE or B1 map'],
    ['denoise', ['(ignore)'], 'UNI, INV1, INV2'],
    ['b1only', ['(ignore)'], 'UNI, INV2, SA2RAGE'],
  ]) {
    const result = state(task, roles);
    assert.equal(result.button.textContent, `Missing: ${missing}`);
    assert.equal(result.status, `Load or assign ${missing} to continue.`);
    assert.equal(result.button.disabled, true);
  }
  for (const roles of [['UNI', 'B1 map'], ['UNI', 'SA2RAGE']]) {
    const result = state('t1', roles);
    assert.equal(result.button.disabled, false);
    assert.equal(result.button.textContent, 'Compute T1 map');
  }
  for (const [task, label] of [['t1', 'Compute T1 map'], ['denoise', 'Denoise UNI'], ['b1only', 'Compute B1 map']]) {
    const result = state(task, []);
    assert.equal(result.status, 'Drag and drop files');
    assert.equal(result.button.textContent, label);
    assert.equal(result.button.disabled, true);
  }
});
