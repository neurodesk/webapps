import assert from 'node:assert/strict'
import test from 'node:test'
import type { TrackingParams } from '@dipy/gpu-streamlines'
import { trackingParametersReport } from './provenance.ts'

const parameters: TrackingParams = {
  maxAngle: Math.PI / 3,
  stepSize: 0.5,
  tcThreshold: 0.1,
  relativePeakThresh: 0.25,
  minSeparationAngle: Math.PI / 4,
  minSignal: 1,
  rngSeed: 0,
  chunkSize: 10000,
  minPts: 10,
  maxPts: Infinity,
  maxWorkgroupsPerDispatch: 16,
}

await test('unbounded tracking provenance survives the snapshot and downloaded report round trip', () => {
  const report = { provenance: { tracking: { parameters: trackingParametersReport(parameters) } } }
  const snapshot = structuredClone(report)
  const downloaded = JSON.parse(JSON.stringify(report))
  assert.deepEqual(downloaded, snapshot)
  assert.deepEqual(downloaded.provenance.tracking.parameters, { ...parameters, maxPts: 'unbounded' })
  assert.equal(parameters.maxPts, Infinity, 'the scientific tracking parameter is unchanged')
})

await test('finite tracking limits remain numeric in provenance', () => {
  const finite = { ...parameters, maxPts: 200 }
  assert.deepEqual(trackingParametersReport(finite), finite)
})

await test('unexpected nonfinite tracking parameters are rejected', () => {
  for (const field of Object.keys(parameters)) {
    for (const value of [NaN, -Infinity, Infinity]) {
      if (field === 'maxPts' && value === Infinity) continue
      assert.throws(() => trackingParametersReport({ ...parameters, [field]: value }), /must be finite/)
    }
  }
})
