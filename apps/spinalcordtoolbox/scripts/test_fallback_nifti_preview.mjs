#!/usr/bin/env node

import assert from 'node:assert/strict';

class FakeClassList {
  constructor() { this.classes = new Set(); }
  add(c) { this.classes.add(c); }
  remove(c) { this.classes.delete(c); }
  contains(c) { return this.classes.has(c); }
  toggle(c, force) {
    if (force === true) this.classes.add(c);
    else if (force === false) this.classes.delete(c);
    else if (this.classes.has(c)) this.classes.delete(c);
    else this.classes.add(c);
  }
}

function makeCanvas() {
  const rect = { width: 200, height: 100 };
  const ctx = {
    clearRectCalls: [],
    drawImageCalls: [],
    imageSmoothingEnabled: true,
    clearRect(...args) { this.clearRectCalls.push(args); },
    createImageData(width, height) {
      return { width, height, data: new Uint8ClampedArray(width * height * 4) };
    },
    putImageData(imageData) { this.lastImageData = imageData; },
    drawImage(...args) { this.drawImageCalls.push(args); }
  };

  return {
    width: 0,
    height: 0,
    parentElement: {
      getBoundingClientRect: () => ({ ...rect })
    },
    getContext(kind) {
      assert.equal(kind, '2d');
      return ctx;
    },
    _ctx: ctx,
    _rect: rect
  };
}

function installFakeDom() {
  const body = { classList: new FakeClassList() };
  const canvas = makeCanvas();
  const message = { hidden: true, textContent: '', title: '' };
  globalThis.document = {
    body,
    getElementById(id) {
      if (id === 'fallbackCanvas2d') return canvas;
      if (id === 'viewerUnavailableMessage') return message;
      return null;
    },
    createElement(tag) {
      assert.equal(tag, 'canvas');
      return makeCanvas();
    }
  };
  return { body, canvas, message };
}

const imageBuffer = new Uint8Array([0, 0, 0, 0, 1, 2, 3, 4]).buffer;
const sourceBuffer = new Uint8Array([1, 2, 3]).buffer;
const header = {
  dims: [3, 2, 2, 2],
  datatypeCode: 2,
  numBitsPerVoxel: 8,
  littleEndian: true,
  scl_slope: 2,
  scl_inter: 1
};

globalThis.window = {
  devicePixelRatio: 1,
  nifti: {
    isCompressed: () => false,
    decompress: () => {
      throw new Error('should not decompress uncompressed test data');
    },
    readHeader: () => header,
    readImage: () => imageBuffer
  }
};

const { body, canvas, message } = installFakeDom();
const { FallbackNiftiPreview } = await import('../web/js/modules/fallback-nifti-preview.js');

const preview = new FallbackNiftiPreview({
  canvasId: 'fallbackCanvas2d',
  messageId: 'viewerUnavailableMessage'
});

assert.equal(preview.isSupported(), true);

const decoded = await preview.decodeNiftiForFallback({
  name: 'scan.nii.gz',
  arrayBuffer: async () => sourceBuffer
});
assert.equal(decoded.width, 2);
assert.equal(decoded.height, 2);
assert.equal(decoded.depth, 2);
assert.equal(decoded.sliceIndex, 1);
assert.equal(decoded.min, 3);
assert.equal(decoded.max, 9);
assert.deepEqual(Array.from(decoded.values), [3, 5, 7, 9]);

const rendered = await preview.renderFile({
  name: 'scan.nii.gz',
  arrayBuffer: async () => sourceBuffer
}, {
  stageName: 'Input',
  reason: 'Unable to initialize WebGL2'
});

assert.equal(rendered, true);
assert.equal(body.classList.contains('viewer-fallback-2d'), true);
assert.equal(canvas.width, 200);
assert.equal(canvas.height, 100);
assert.equal(canvas._ctx.drawImageCalls.length, 1);
assert.equal(message.hidden, false);
assert.match(message.textContent, /2D preview only/);
assert.match(message.textContent, /Input: axial slice 2\/2/);
assert.equal(message.title, 'Unable to initialize WebGL2');

canvas._rect.width = 120;
canvas._rect.height = 80;
assert.equal(preview.redraw(), true);
assert.equal(canvas.width, 120);
assert.equal(canvas.height, 80);
assert.equal(canvas._ctx.drawImageCalls.length, 2);

preview.clear();
assert.equal(body.classList.contains('viewer-fallback-2d'), false);

header.datatypeCode = 128;
header.numBitsPerVoxel = 24;
await assert.rejects(
  () => preview.decodeNiftiForFallback({ name: 'rgb.nii', arrayBuffer: async () => sourceBuffer }),
  /Unsupported NIfTI datatype 128/
);

console.log('Fallback NIfTI preview tests passed');
