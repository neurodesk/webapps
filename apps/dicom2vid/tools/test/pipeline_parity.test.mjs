// Parity gate: the JS DICOM reader + pipeline must reproduce the reference
// pre-encode 8-bit frame stacks (tools/golden) with max|diff| = 0.
//
// Run: node --test tools/test/   (after gen_phantom.py + gen_reference.py)

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { readDicomSeries } from '../../web/js/readers/dicom.js';
import { buildFrames } from '../../web/js/pipeline.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..');
const PHANTOM = path.join(ROOT, 'tools', 'phantom_out');
const GOLDEN = path.join(ROOT, 'tools', 'golden');

function readAB(p) {
  const buf = fs.readFileSync(p);
  return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
}

function loadFolder(dir) {
  return fs.readdirSync(dir)
    .filter((n) => n.toLowerCase().endsWith('.dcm'))
    .map((n) => ({ name: n, buffer: readAB(path.join(dir, n)) }));
}

const manifestPath = path.join(GOLDEN, 'manifest.json');
const haveGolden = fs.existsSync(manifestPath);

test('golden fixtures present', () => {
  assert.ok(haveGolden, 'Run tools/gen_phantom.py and tools/gen_reference.py first');
});

if (haveGolden) {
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  const folders = {
    single: () => loadFolder(path.join(PHANTOM, 'dicom_single')),
    mf: () => loadFolder(path.join(PHANTOM, 'dicom_mf')),
  };

  for (const cfg of manifest.configs) {
    test(`parity: ${cfg.name}`, () => {
      const vol = readDicomSeries(folders[cfg.source]());
      const out = buildFrames(vol, {
        orientation: cfg.orientation,
        start: cfg.start,
        end: cfg.end,
        step: cfg.step,
      });

      const [gN, gH, gW] = cfg.shape;
      assert.deepEqual([out.nFrames, out.fH, out.fW], [gN, gH, gW],
        `shape mismatch for ${cfg.name}`);
      assert.deepEqual(out.sliceIndices, cfg.slice_indices,
        `slice indices mismatch for ${cfg.name}`);

      const golden = new Uint8Array(readAB(path.join(GOLDEN, `${cfg.name}.bin`)));
      assert.equal(out.frames.length, golden.length,
        `frame buffer length mismatch for ${cfg.name}`);

      let maxDiff = 0;
      let firstBad = -1;
      for (let i = 0; i < golden.length; i++) {
        const d = Math.abs(out.frames[i] - golden[i]);
        if (d > maxDiff) { maxDiff = d; if (firstBad < 0) firstBad = i; }
      }
      assert.equal(maxDiff, 0,
        `max|diff| = ${maxDiff} for ${cfg.name} (first at flat index ${firstBad}: got ${out.frames[firstBad]}, want ${golden[firstBad]})`);
    });
  }
}
