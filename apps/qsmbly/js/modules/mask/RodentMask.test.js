/**
 * Tests for RodentMask module
 */

import {
  MOUSE_BET_DEFAULTS,
  fieldOfViewMm,
  looksLikeRodentFov,
  scaleVoxelSize,
  voxelScaleMethodsNote,
  insertBetMethodsNote,
  replaceMaskingSentence,
  RS2_NET_METHODS,
} from './RodentMask.js';

describe('RodentMask', () => {
  describe('fieldOfViewMm', () => {
    it('multiplies dims by voxel size per axis', () => {
      expect(fieldOfViewMm([100, 200, 50], [0.1, 0.1, 0.2])).toEqual([
        expect.closeTo(10), expect.closeTo(20), expect.closeTo(10),
      ]);
    });

    it('returns null without geometry', () => {
      expect(fieldOfViewMm(null, [1, 1, 1])).toBeNull();
      expect(fieldOfViewMm([1, 1, 1], null)).toBeNull();
    });
  });

  describe('looksLikeRodentFov', () => {
    it('flags a mouse head scan', () => {
      expect(looksLikeRodentFov([256, 192, 64], [0.1, 0.1, 0.3])).toBe(true);
    });

    it('does not flag a human head scan', () => {
      expect(looksLikeRodentFov([256, 256, 160], [1, 1, 1])).toBe(false);
      expect(looksLikeRodentFov([164, 205, 80], [1.2, 1.2, 1.6])).toBe(false);
    });

    it('does not flag missing or invalid geometry', () => {
      expect(looksLikeRodentFov(null, null)).toBe(false);
      expect(looksLikeRodentFov([NaN, 10, 10], [1, 1, 1])).toBe(false);
    });
  });

  describe('scaleVoxelSize', () => {
    it('scales each axis', () => {
      expect(scaleVoxelSize([0.1, 0.1, 0.3], 10)).toEqual([
        expect.closeTo(1), expect.closeTo(1), expect.closeTo(3),
      ]);
    });

    it('leaves voxel sizes unchanged for a missing or invalid scale', () => {
      expect(scaleVoxelSize([0.1, 0.2, 0.3], undefined)).toEqual([0.1, 0.2, 0.3]);
      expect(scaleVoxelSize([0.1, 0.2, 0.3], 0)).toEqual([0.1, 0.2, 0.3]);
      expect(scaleVoxelSize([0.1, 0.2, 0.3], -5)).toEqual([0.1, 0.2, 0.3]);
    });

    it('brings a mouse brain into BET\'s human-scale range with the default factor', () => {
      // ~10 mm mouse brain at 0.1 mm -> 100 voxels -> ~100 mm once scaled
      const [vs] = scaleVoxelSize([0.1, 0.1, 0.1], MOUSE_BET_DEFAULTS.voxelScale);
      expect(100 * vs).toBeCloseTo(100);
    });
  });

  describe('voxelScaleMethodsNote', () => {
    it('describes the scale factor', () => {
      expect(voxelScaleMethodsNote(10)).toMatch(/factor of 10/);
    });

    it('is empty when BET ran unscaled', () => {
      expect(voxelScaleMethodsNote(1)).toBe('');
      expect(voxelScaleMethodsNote(undefined)).toBe('');
    });
  });

  describe('insertBetMethodsNote', () => {
    const md = '## Methods\n\nMasks were generated using BET brain extraction (Smith, 2002; f=0.50) of the '
      + 'RSS-combined magnitude image. Phase was unwrapped.\n\n## References\n- Smith 2002';

    it('places the note right after the BET sentence', () => {
      const out = insertBetMethodsNote(md, 'NOTE.');
      expect(out).toContain('magnitude image. NOTE. Phase was unwrapped.');
      expect(out.indexOf('NOTE.')).toBeLessThan(out.indexOf('## References'));
    });

    it('appends when there is no BET sentence', () => {
      expect(insertBetMethodsNote('Otsu thresholding.', 'NOTE.')).toBe('Otsu thresholding.\n\nNOTE.\n');
    });

    it('leaves the text alone without a note', () => {
      expect(insertBetMethodsNote(md, '')).toBe(md);
    });
  });

  describe('replaceMaskingSentence', () => {
    const md = '# Methods\n\nQSM processing was performed using QSMbly (Stewart, 2026). A brain mask was '
      + 'generated using Otsu thresholding (Otsu, 1979) of the magnitude, followed by erosion (1 iteration). '
      + 'Phase unwrapping was performed using ROMEO (Dymerska et al., 2021).\n\n## References\n\n'
      + '- Stewart, A. (2026). QSMbly.\n- Dymerska, B., et al. (2021). ROMEO.\n- Otsu, N. (1979). Otsu.\n';

    it('replaces the masking sentence and nothing else', () => {
      const out = replaceMaskingSentence(md, RS2_NET_METHODS.sentence, RS2_NET_METHODS.reference);
      expect(out).toContain(`(Stewart, 2026). ${RS2_NET_METHODS.sentence} Phase unwrapping`);
      expect(out).not.toMatch(/Otsu thresholding/);
    });

    it('drops references no longer cited and adds the new one', () => {
      const out = replaceMaskingSentence(md, RS2_NET_METHODS.sentence, RS2_NET_METHODS.reference);
      const refs = out.slice(out.indexOf('## References'));
      expect(refs).not.toMatch(/Otsu, N\./);
      expect(refs).toMatch(/Stewart, A\./);
      expect(refs).toMatch(/Dymerska, B\./);
      expect(refs.trimEnd().endsWith(RS2_NET_METHODS.reference)).toBe(true);
    });

    it('appends the sentence when there is no masking sentence', () => {
      const out = replaceMaskingSentence('# Methods\n\nNo mask here.', 'S.', '- R (2024).');
      expect(out).toContain('No mask here. S.');
    });
  });
});
