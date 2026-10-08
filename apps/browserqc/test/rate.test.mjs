import assert from 'node:assert/strict'
import test from 'node:test'
import { readFile } from 'node:fs/promises'
import { JSDOM } from 'jsdom'

test('ratings require inspection and an edit, export MRIQC fields and reset on a new image', async () => {
  const dom = new JSDOM(await readFile(new URL('../index.html', import.meta.url), 'utf8'))
  const previousDocument = globalThis.document
  const previousNow = Date.now
  let now = 1000
  globalThis.document = dom.window.document
  Date.now = () => now
  try {
    const { resetRating, readRating } = await import('../src/rate.ts')
    const doc = dom.window.document
    const save = doc.querySelector('#rateSave')
    const rating = doc.querySelector('#rating')
    const comments = doc.querySelector('#rateComments')
    resetRating()
    rating.value = '1.2'
    rating.dispatchEvent(new dom.window.Event('input'))
    assert.equal(save.disabled, true)
    assert.equal(doc.querySelector('#ratingValue').textContent, '1.2 · Exclude')
    now += 10001
    comments.value = 'Motion affected this scan'
    comments.dispatchEvent(new dom.window.Event('input'))
    doc.querySelector('input[name="head-motion"]').checked = true
    assert.equal(save.disabled, false)
    assert.deepEqual(readRating('scan.nii'), {
      dataset: '<unset>', subject: 'scan.nii', rating: '1.2', confidence: '2',
      artifacts: ['head-motion'], comments: 'Motion affected this scan', time_sec: 10.001,
    })
    resetRating()
    assert.equal(save.disabled, true)
    assert.equal(readRating('next.nii').comments, '')
    assert.deepEqual(readRating('next.nii').artifacts, [])
  } finally {
    globalThis.document = previousDocument
    Date.now = previousNow
    dom.window.close()
  }
})
