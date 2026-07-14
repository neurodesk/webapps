import assert from 'node:assert/strict';
import test from 'node:test';
import { JSDOM } from 'jsdom';
import { mountImagingWorkspace } from '../src/core/mountImagingWorkspace.js';

test('mountImagingWorkspace preserves region, canvas, and listener identity', () => {
  const dom = new JSDOM(`<!doctype html><body>
    <header id="controls"><button id="apply">Apply</button></header>
    <main id="viewer"><canvas id="gl"></canvas></main>
    <footer id="status">Ready</footer>
    <dialog id="about"></dialog>
  </body>`);
  const { document } = dom.window;
  const controls = document.querySelector('#controls');
  const viewer = document.querySelector('#viewer');
  const status = document.querySelector('#status');
  const canvas = document.querySelector('#gl');
  let clicks = 0;
  document.querySelector('#apply').addEventListener('click', () => clicks++);

  const workspace = mountImagingWorkspace({
    document,
    controls,
    viewer,
    status,
    title: 'Deface',
  });

  assert.equal(workspace.querySelector('#controls'), controls);
  assert.equal(workspace.querySelector('#viewer'), viewer);
  assert.equal(workspace.querySelector('#status'), status);
  assert.equal(workspace.querySelector('#gl'), canvas);
  assert.equal(document.body.querySelector('#about').parentElement, document.body);
  assert.equal(workspace.querySelector('[title="More Neurodesk web apps"]').getAttribute('href'), '../');
  assert.equal(mountImagingWorkspace({ document, controls, viewer, status }), workspace);
  document.querySelector('#apply').click();
  assert.equal(clicks, 1);
});
