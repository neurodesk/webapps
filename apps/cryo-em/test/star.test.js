import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fscResolution, formatStar, loopBlock, pairsBlock, syntheticFsc } from '../../../test-utils/relion-simulator.mjs';
import { parseChecksums, parseStar, postprocessFsc } from '../src/star.js';
import { crossing, fscChartSvg } from '../src/fsc-chart.js';

function postprocessStar(angpix) {
  const shells = Array.from({ length: 17 }, (_, k) => k);
  return formatStar([
    pairsBlock('general', [['rlnFinalResolution', fscResolution(angpix)], ['rlnBfactorUsedForSharpening', -60]]),
    loopBlock('fsc', ['rlnSpectralIndex', 'rlnResolution', 'rlnFourierShellCorrelationCorrected', 'rlnCorrectedFourierShellCorrelationPhaseRandomizedMaskedMaps'],
      shells.map(k => [k, k / (32 * angpix), syntheticFsc(k), k < 8 ? syntheticFsc(k) : 0])),
  ]);
}

test('parses loops, pairs and quoted values', () => {
  const [block] = parseStar('# version 50001\ndata_x\nloop_\n_rlnA #1\n_rlnB #2\n1 "a b"\n2 c\n');
  assert.deepEqual(block.columns, ['rlnA', 'rlnB']);
  assert.deepEqual(block.rows, [['1', 'a b'], ['2', 'c']]);
  assert.throws(() => parseStar('data_x\nloop_\n_rlnA #1\n1 2\n'), /2 values for 1 columns/);
});

test('reads the FSC of postprocess.star and finds its 0.143 crossing', () => {
  const fsc = postprocessFsc(postprocessStar(1.77));
  assert.equal(fsc.shells.length, 17);
  assert.equal(fsc.bfactor, -60);
  assert.ok(Math.abs(fsc.finalResolution - fscResolution(1.77)) < 1e-4);
  assert.ok(Math.abs(1 / crossing(fsc.shells) - fsc.finalResolution) < 1e-3, 'the curve crosses 0.143 at the final resolution');
  const svg = fscChartSvg(fsc);
  assert.match(svg, /class="nd-chart"/);
  assert.match(svg, new RegExp(`${fsc.finalResolution.toFixed(2)} Å`));
  assert.doesNotMatch(svg, /#[0-9a-f]{3,6}|rgb\(/i, 'colours come from the shared tokens');
});

test('a curve that never falls below 0.143 has no crossing marker', () => {
  const shells = [0, 1, 2].map(index => ({ resolution: index / 10, fsc: 0.9, randomised: null }));
  assert.equal(crossing(shells), null);
  assert.doesNotMatch(fscChartSvg({ shells, finalResolution: 5 }), /nd-chart-marker/);
});

test('reads SHA256SUMS lines', () => {
  const sum = 'a'.repeat(64);
  assert.deepEqual(parseChecksums(`${sum}  Movies/x.tiff\n${sum} *gain.mrc\nnot a line\n`), { 'Movies/x.tiff': sum, 'gain.mrc': sum });
});
