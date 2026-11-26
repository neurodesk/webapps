import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { PARAMETERS, TURBO_COLORMAP, sampleColormapRgba } from '@neurodesk/vesselcharter';
import {
  APP,
  DEFAULT_DIAMETER_COLORMAP,
  DIAMETER_COLORMAPS,
  SKELETON_COLORMAP,
  SKELETON_LEGEND_ITEMS,
  buildColorMapCssGradient,
  formatDiameterTicks,
} from '../src/config.js';

test('app config matches automation contract and shared parameter schema', async () => {
  assert.equal(APP.id, 'vesselcharter');
  assert.equal(APP.title, 'VesselCharter');
  const automation = JSON.parse(await readFile(new URL('../automation.json', import.meta.url), 'utf8'));
  assert.equal(automation.app, APP.id);
  assert.equal(automation.defaultOperation, 'characterize');
  const opParams = automation.operations.characterize.parameters;
  assert.deepEqual(Object.keys(opParams).sort(), Object.keys(PARAMETERS).sort());
  for (const key of Object.keys(PARAMETERS)) {
    assert.equal(opParams[key].default, PARAMETERS[key].default, `Default mismatch for ${key}`);
  }
});

test('diameter colormap helpers interpolate control points and format mm ticks', () => {
  assert.ok(DIAMETER_COLORMAPS.some((c) => c.id === DEFAULT_DIAMETER_COLORMAP));
  assert.deepEqual(sampleColormapRgba(TURBO_COLORMAP, 0), [48, 18, 59, 255]);
  assert.deepEqual(sampleColormapRgba(TURBO_COLORMAP, 1), [122, 4, 3, 255]);
  const gradient = buildColorMapCssGradient(TURBO_COLORMAP, 4);
  assert.match(gradient, /^linear-gradient\(to right, rgb\(48 18 59\) 0\.0%, .* rgb\(122 4 3\) 100\.0%\)$/);

  const clippedTicks = formatDiameterTicks(0.23, 4.34, { dataMaxMm: 5.19 });
  assert.equal(clippedTicks.length, 5);
  assert.equal(clippedTicks[0], '0.23');
  assert.equal(clippedTicks[4], '≥ 4.34 mm');

  const unclippedTicks = formatDiameterTicks(0.25, 4.0, { dataMaxMm: 4.0 });
  assert.equal(unclippedTicks[4], '4.00 mm');

  assert.equal(SKELETON_LEGEND_ITEMS.length, 4);
  assert.equal(SKELETON_COLORMAP.I.length, 5);
});
