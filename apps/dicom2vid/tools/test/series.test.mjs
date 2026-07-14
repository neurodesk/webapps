// Series grouping and ranking: a folder with a T1 series and a color DTI series
// must split by SeriesInstanceUID, label each correctly, and default-pick the T1.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { readDicomHeader } from '../../web/js/readers/dicom.js';
import { groupSeries, classifySeries } from '../../web/js/series.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..');
const PHANTOM = path.join(ROOT, 'tools', 'phantom_out');

function readAB(p) {
  const buf = fs.readFileSync(p);
  return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
}

function headersFrom(dir) {
  return fs.readdirSync(dir)
    .filter((n) => n.toLowerCase().endsWith('.dcm'))
    .map((n) => readDicomHeader(readAB(path.join(dir, n)), n));
}

const haveData = fs.existsSync(path.join(PHANTOM, 'dicom_single'));

test('phantom present', () => {
  assert.ok(haveData, 'Run tools/gen_phantom.py first');
});

if (haveData) {
  test('groups two series and picks the T1', () => {
    const headers = [
      ...headersFrom(path.join(PHANTOM, 'dicom_single')),
      ...headersFrom(path.join(PHANTOM, 'dicom_rgb')),
    ];
    const { series, defaultIndex } = groupSeries(headers);
    assert.equal(series.length, 2, 'should group into 2 series');

    const t1 = series.find((s) => s.classification.label === 't1');
    const color = series.find((s) => s.classification.label === 'color');
    assert.ok(t1, 'T1 series should be labeled t1');
    assert.ok(color, 'RGB series should be labeled color');

    assert.equal(series[defaultIndex].classification.label, 't1',
      'default pick should be the T1 series');
    assert.equal(t1.files.length, 5);
    assert.equal(color.isColor, true);
  });

  test('classifier basics', () => {
    assert.equal(classifySeries({
      seriesDescription: 'T2 FLAIR', isColor: false, sliceCount: 40,
      physics: { inversionTime: 2500, echoTime: 90, repetitionTime: 9000 },
    }).label, 'flair');

    assert.equal(classifySeries({
      seriesDescription: 'AAHead_Scout', isColor: false, sliceCount: 3,
      physics: {},
    }).label, 'localizer');

    assert.equal(classifySeries({
      seriesDescription: 'ep2d_diff_tra', isColor: false, sliceCount: 60,
      physics: { echoTime: 90, repetitionTime: 5000 },
    }).label, 'dwi');
  });
}
