import type { TrackingParams } from '@dipy/gpu-streamlines'

/** JSON reports spell the tracker's intentional +Infinity point limit as "unbounded". */
export function trackingParametersReport(parameters: TrackingParams) {
  for (const [name, value] of Object.entries(parameters)) {
    if (name === 'maxPts' && value === Infinity) continue
    if (!Number.isFinite(value)) throw new Error(`Tracking parameter ${name} must be finite.`)
  }
  return { ...parameters, maxPts: parameters.maxPts === Infinity ? 'unbounded' : parameters.maxPts }
}
