import assert from 'node:assert/strict'
import test from 'node:test'
import { describeSeries } from '../src/series.ts'

test('converted series retain their own sidecars when selected in either order', async () => {
  const t1 = new File(['image'], 't1.nii.gz')
  const t2 = new File(['image'], 't2.nii')
  const series = await describeSeries([t2, t1], [
    new File([JSON.stringify({ SeriesNumber: 8, SeriesDescription: 'T1', EchoTime: 0.003 })], 't1.json'),
    new File([JSON.stringify({ SeriesNumber: 3, SeriesDescription: 'T2', EchoTime: 0.08 })], 't2.json'),
  ], { PatientName: 'unrelated fallback' })
  assert.equal(series[0].meta.EchoTime, 0.08)
  assert.equal(series[1].meta.EchoTime, 0.003)
  assert.match(series[0].label, /3 · T2/)
  assert.match(series[1].label, /8 · T1/)
  assert.equal(series[0].file, t2)
  assert.equal(series[1].file, t1)
})

test('an unmatched sidecar applies to one image only, never multiple series', async () => {
  const image = new File(['image'], 'scan.nii')
  const staged = { EchoTime: 0.004 }
  assert.equal((await describeSeries([image], [], staged))[0].meta, staged)
  assert.deepEqual((await describeSeries([image, new File(['image'], 'other.nii')], [], staged)).map(series => series.meta), [null, null])
  assert.equal((await describeSeries([image], [new File(['invalid'], 'scan.json')], staged))[0].meta, null)
})
