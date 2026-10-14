// Reads elastix TransformParameters TOML files independently of elastix and
// composes a rigid chain into one world matrix. The web app's automation test
// (apps/elastix/e2e/automation.spec.js) and the command line's release check
// (cli-check.mjs) both hold a known displacement to it.
import { multiplyAffine } from '../../../test-utils/registration-similarity.mjs';

/** One value of an elastix TOML parameter file: a string, a number, or an array of them. */
export function tomlValue(text, key) {
  const match = new RegExp(`^${key} = (.+)$`, 'm').exec(text);
  return match ? JSON.parse(match[1]) : undefined;
}

// One elastix TransformParameters file as a 4×4 LPS matrix mapping a
// stationary point to a moving point. ITK's Euler3DTransform without
// ComputeZYX rotates by Rz·Rx·Ry about CenterOfRotationPoint.
function stageMatrix(text) {
  const transform = tomlValue(text, 'Transform');
  const p = tomlValue(text, 'TransformParameters');
  if (transform === 'TranslationTransform') return [[1, 0, 0, p[0]], [0, 1, 0, p[1]], [0, 0, 1, p[2]], [0, 0, 0, 1]];
  if (transform !== 'EulerTransform') throw new Error(`Unexpected ${transform}`);
  if (tomlValue(text, 'ComputeZYX') ?? false) throw new Error('ComputeZYX = true is not the preset elastix rotation order');
  const [cx, sx, cy, sy, cz, sz] = [p[0], p[0], p[1], p[1], p[2], p[2]].map((angle, index) => (index % 2 ? Math.sin(angle) : Math.cos(angle)));
  const rz = [[cz, -sz, 0], [sz, cz, 0], [0, 0, 1]];
  const rx = [[1, 0, 0], [0, cx, -sx], [0, sx, cx]];
  const ry = [[cy, 0, sy], [0, 1, 0], [-sy, 0, cy]];
  const times = (a, b) => a.map((row) => b[0].map((_, column) => row.reduce((sum, value, k) => sum + value * b[k][column], 0)));
  const r = times(times(rz, rx), ry);
  const c = tomlValue(text, 'CenterOfRotationPoint');
  const offset = [0, 1, 2].map((row) => p[3 + row] + c[row] - r[row].reduce((sum, value, k) => sum + value * c[k], 0));
  return [...r.map((row, index) => [...row, offset[index]]), [0, 0, 0, 1]];
}

/**
 * The composed fixed-to-moving matrix of a rigid preset's TransformParameters
 * files, in order. elastix composes each stage after the ones it names as
 * initial transforms, in ITK's LPS space; the returned matrix is RAS, like
 * NIfTI affines.
 */
export function fixedToMovingRas(texts) {
  const lps = texts.reduce((total, text) => multiplyAffine(stageMatrix(text), total), [[1, 0, 0, 0], [0, 1, 0, 0], [0, 0, 1, 0], [0, 0, 0, 1]]);
  const flip = [[-1, 0, 0, 0], [0, -1, 0, 0], [0, 0, 1, 0], [0, 0, 0, 1]];
  return multiplyAffine(multiplyAffine(flip, lps), flip);
}
