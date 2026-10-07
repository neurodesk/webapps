import assert from 'node:assert/strict';
import test from 'node:test';
import { DRAWING_CONTROLS, LOCKED_ATTRIBUTE, applyDrawingLock } from '../src/freebrowse-viewer/drawing-lock.js';

class FakeNode {
  constructor(attributes = {}) {
    this.attributes = new Map(Object.entries(attributes));
  }
  hasAttribute(name) { return this.attributes.has(name); }
  toggleAttribute(name, force) {
    if (force) this.attributes.set(name, '');
    else this.attributes.delete(name);
  }
}

function root(nodes) {
  const selectors = [];
  return {
    selectors,
    querySelectorAll(selector) {
      selectors.push(selector);
      return nodes;
    },
  };
}

test('the drawing lock covers the Drawing tab, its panel and Edit as drawing', () => {
  assert.match(DRAWING_CONTROLS, /\[role="tab"\]\[id\$="-trigger-drawing"\]/);
  assert.match(DRAWING_CONTROLS, /\[role="tabpanel"\]\[id\$="-content-drawing"\]/);
  assert.match(DRAWING_CONTROLS, /button\[title="Edit as drawing"\]/);
});

test('locking makes the controls inert and marks them; unlocking restores them', () => {
  const tab = new FakeNode();
  const editAsDrawing = new FakeNode();
  const host = root([tab, editAsDrawing]);
  applyDrawingLock(host, true);
  assert.deepEqual(host.selectors, [DRAWING_CONTROLS]);
  for (const node of [tab, editAsDrawing]) {
    assert.ok(node.hasAttribute('inert'));
    assert.ok(node.hasAttribute(LOCKED_ATTRIBUTE));
  }
  applyDrawingLock(host, false);
  for (const node of [tab, editAsDrawing]) {
    assert.equal(node.hasAttribute('inert'), false);
    assert.equal(node.hasAttribute(LOCKED_ATTRIBUTE), false);
  }
});

test('unlocking leaves controls the lock did not mark alone', () => {
  const inertByFreeBrowse = new FakeNode({ inert: '' });
  applyDrawingLock(root([inertByFreeBrowse]), false);
  assert.ok(inertByFreeBrowse.hasAttribute('inert'));
});
