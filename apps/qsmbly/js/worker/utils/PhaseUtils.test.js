/**
 * PhaseUtils Tests
 */
import { jest } from '@jest/globals';
import { computeWeightedEchoFit, ppmFieldToPhase } from './PhaseUtils.js';

describe('ppmFieldToPhase', () => {
  // Proton gamma, matching qsm-core's hz_to_ppm. The round trip only closes if both
  // sides use the same constant.
  const GAMMA = 42.576e6;

  test('inverts the Hz→ppm the field-mapping stage applied', () => {
    const fieldStrength = 3.0;
    const te = 0.012;
    const b0Hz = [-120.5, 0, 0.5, 999.25];

    // What qsm-core's hz_to_ppm produced from those Hz values.
    const ppm = Float64Array.from(b0Hz, hz => (hz * 1e6) / (GAMMA * fieldStrength));
    const phase = ppmFieldToPhase(ppm, fieldStrength, te, GAMMA);

    // Must match converting straight from Hz: phase = 2*pi*B0*TE.
    b0Hz.forEach((hz, i) => {
      expect(phase[i]).toBeCloseTo(2 * Math.PI * hz * te, 12);
    });
  });

  test('scales linearly with field strength and echo time', () => {
    const ppm = Float64Array.from([1.0]);

    const base = ppmFieldToPhase(ppm, 3.0, 0.01, GAMMA)[0];
    expect(ppmFieldToPhase(ppm, 7.0, 0.01, GAMMA)[0]).toBeCloseTo(base * (7 / 3), 12);
    expect(ppmFieldToPhase(ppm, 3.0, 0.02, GAMMA)[0]).toBeCloseTo(base * 2, 12);
  });

  test('returns a Float64Array of the same length and maps zero to zero', () => {
    const phase = ppmFieldToPhase(new Float64Array([0, 0, 0]), 3.0, 0.01, GAMMA);

    expect(phase).toBeInstanceOf(Float64Array);
    expect(phase.length).toBe(3);
    expect(Array.from(phase)).toEqual([0, 0, 0]);
  });

  describe('computeWeightedEchoFit', () => {
    const nx = 4, ny = 4, nz = 3;
    const n = nx * ny * nz;
    const echoTimes = [10, 20, 30]; // ms
    const mask = new Uint8Array(n).fill(1);
    const magnitude4d = echoTimes.map(() => new Float64Array(n).fill(100));

    beforeEach(() => jest.spyOn(console, 'log').mockImplementation(() => {}));
    afterEach(() => console.log.mockRestore());

    const linearPhase = (hz) => {
      const phase = new Float64Array(echoTimes.length * n);
      echoTimes.forEach((te, e) => phase.fill(2 * Math.PI * hz * te / 1000, e * n, (e + 1) * n));
      return phase;
    };

    test('recovers the frequency of noiseless linear phase and keeps every voxel reliable', () => {
      const { tfs, R_0 } = computeWeightedEchoFit(
        linearPhase(25), magnitude4d, echoTimes, nx, ny, nz, [1, 1, 1], mask,
      );
      for (let i = 0; i < n; i++) {
        expect(tfs[i]).toBeCloseTo(25, 8);
        expect(R_0[i]).toBe(1);
      }
    });

    test('flags a voxel whose blurred fit residual exceeds the threshold', () => {
      const phase = linearPhase(25);
      const bad = 1 + nx + nx * ny;
      phase[2 * n + bad] += 3; // last echo off the line
      const { R_0 } = computeWeightedEchoFit(
        phase, magnitude4d, echoTimes, nx, ny, nz, [1, 1, 1], mask, 0.1,
      );
      expect(R_0[bad]).toBe(0);
      // The 3x3x3 residual blur spreads the outlier to its neighbours but not to the far corner.
      expect(R_0[bad + 1]).toBe(0);
      expect(R_0[n - 1]).toBe(1);
    });
  });
});
