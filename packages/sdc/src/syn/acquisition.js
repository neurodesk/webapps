// SPDX-License-Identifier: Apache-2.0
// The phase-encoding direction and total readout time of the DWI series (plan Q62): explicit
// options first, then the sidecar's PhaseEncodingDirection and TotalReadoutTime, then
// EffectiveEchoSpacing × (N_PE − 1) as sdcflows' get_trt computes it. EstimatedTotalReadoutTime
// and sdcflows' fallback are not used, and the polarity is never guessed.

export const DIRECTIONS = Object.freeze(['i', 'i-', 'j', 'j-', 'k', 'k-']);

/**
 * @param {object | null} sidecar the DWI JSON sidecar
 * @param {number[]} dims the image dimensions
 * @param {{ phaseEncodingDirection?: string, totalReadoutTime?: number }} [options]
 * @returns {{ phaseEncodingDirection: string, totalReadoutTime: number, source: { phaseEncodingDirection: string, totalReadoutTime: string } }}
 */
export function acquisition(sidecar, dims, options = {}) {
  const meta = sidecar ?? {};
  let phaseEncodingDirection = options.phaseEncodingDirection;
  let directionSource = 'option';
  if (phaseEncodingDirection === undefined || phaseEncodingDirection === null || phaseEncodingDirection === '') {
    phaseEncodingDirection = meta.PhaseEncodingDirection;
    directionSource = 'sidecar';
  }
  if (phaseEncodingDirection === undefined || phaseEncodingDirection === null || phaseEncodingDirection === '') {
    throw new Error('The phase-encoding direction is missing: give PhaseEncodingDirection in the sidecar or as an option (i, i-, j, j-, k or k-). SyN-SDC does not guess it.');
  }
  if (!DIRECTIONS.includes(phaseEncodingDirection)) {
    throw new Error(`The phase-encoding direction ${JSON.stringify(phaseEncodingDirection)} is not one of ${DIRECTIONS.join(', ')}.`);
  }
  let totalReadoutTime = options.totalReadoutTime;
  let readoutSource = 'option';
  if (totalReadoutTime === undefined || totalReadoutTime === null) {
    if (meta.TotalReadoutTime !== undefined) {
      totalReadoutTime = meta.TotalReadoutTime;
      readoutSource = 'sidecar TotalReadoutTime';
    } else if (meta.EffectiveEchoSpacing) {
      const peLength = dims['ijk'.indexOf(phaseEncodingDirection[0])];
      totalReadoutTime = meta.EffectiveEchoSpacing * (peLength - 1);
      readoutSource = `sidecar EffectiveEchoSpacing × (${peLength} − 1)`;
    }
  }
  if (totalReadoutTime === undefined || totalReadoutTime === null) {
    throw new Error('The total readout time is missing: give TotalReadoutTime or EffectiveEchoSpacing in the sidecar, or the readout time as an option (seconds).');
  }
  if (typeof totalReadoutTime !== 'number' || !Number.isFinite(totalReadoutTime) || totalReadoutTime <= 0) {
    throw new Error(`The total readout time must be a positive number of seconds, not ${JSON.stringify(totalReadoutTime)}.`);
  }
  return {
    phaseEncodingDirection,
    totalReadoutTime,
    source: { phaseEncodingDirection: directionSource, totalReadoutTime: readoutSource },
  };
}
